// Journal de diagnostic par match, ecrit sur disque dans logs/matches/.
// Permet de reconstruire a posteriori pourquoi un score vaut ce qu'il vaut,
// actif par actif.
//
// Aucune cle privee, seed, secret ou cle d'API n'est manipulee ici : le module
// ne recoit que des adresses publiques, des quantites et des prix. Le filtre
// ci-dessous est une ceinture de securite en cas d'evolution du code.

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs', 'matches');
const MAX_SNAPSHOTS_PER_PLAYER = 240;
const FORBIDDEN_KEYS = /(secret|private|seed|passphrase|apikey|api_key|token_secret|mnemonic)/i;

function scrub(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(k)) continue;
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

function compactValuation(valuation) {
  return {
    timestamp: valuation.timestamp,
    slot: valuation.slot,
    equity: valuation.equity,
    coverage: valuation.coverage,
    unpricedAssets: valuation.unpricedAssets,
    // Decomposition complete : montant, prix, statut et valeur par actif.
    breakdown: valuation.breakdown.map((b) => ({
      kind: b.kind,
      mint: b.mint,
      label: b.label,
      program: b.program,
      amount: b.amount,
      raw: b.raw,
      decimals: b.decimals,
      price: b.price,
      priceStatus: b.priceStatus,
      priceAgeMs: b.priceAgeMs,
      priceSource: b.priceSource,
      value: b.value,
    })),
  };
}

class MatchLogger {
  constructor(matchId, meta = {}) {
    this.matchId = matchId;
    this.meta = meta;
    this.players = new Map();
    this.errors = [];
    this.createdAt = Date.now();
  }

  player(playerId) {
    if (!this.players.has(playerId)) {
      this.players.set(playerId, {
        playerId,
        name: null,
        wallet: null,
        simulated: false,
        initialSnapshot: null,
        initialEquity: null,
        snapshots: [],
        transactions: [],
        finalSnapshot: null,
        finalEquity: null,
        finalPnlPct: null,
        calculation: null,
        errors: [],
      });
    }
    return this.players.get(playerId);
  }

  registerPlayer(playerId, { name, wallet, simulated, initialSnapshot, initialValuation }) {
    const p = this.player(playerId);
    p.name = name;
    p.wallet = wallet;
    p.simulated = !!simulated;
    if (initialValuation) {
      p.initialSnapshot = compactValuation(initialValuation);
      p.initialEquity = initialValuation.equity;
    }
    if (initialSnapshot?.errors?.length) {
      for (const e of initialSnapshot.errors) p.errors.push({ timestamp: Date.now(), ...e });
    }
  }

  addSnapshot(playerId, valuation, { pnlPct, applied, degraded, flows }) {
    const p = this.player(playerId);
    if (p.snapshots.length >= MAX_SNAPSHOTS_PER_PLAYER) p.snapshots.shift();
    p.snapshots.push({
      ...compactValuation(valuation),
      pnlPct,
      applied,
      degraded: degraded || null,
      flowsApplied: flows || [],
    });
  }

  addTransactions(playerId, transactions) {
    if (!transactions?.length) return;
    const p = this.player(playerId);
    p.transactions.push(...transactions);
  }

  addError(playerId, component, error) {
    const entry = { timestamp: Date.now(), component, error: String(error?.message || error) };
    if (playerId === null) this.errors.push(entry);
    else this.player(playerId).errors.push(entry);
  }

  finalize(playerId, { finalValuation, calculation, finalPnlPct }) {
    const p = this.player(playerId);
    if (finalValuation) {
      p.finalSnapshot = compactValuation(finalValuation);
      p.finalEquity = finalValuation.equity;
    }
    p.calculation = calculation || null;
    p.finalPnlPct = finalPnlPct ?? null;
  }

  toJSON() {
    return scrub({
      matchId: this.matchId,
      ...this.meta,
      createdAt: this.createdAt,
      closedAt: Date.now(),
      errors: this.errors,
      players: [...this.players.values()],
    });
  }

  async write() {
    try {
      await fs.promises.mkdir(LOG_DIR, { recursive: true });
      const file = path.join(LOG_DIR, `${this.matchId}.json`);
      await fs.promises.writeFile(file, JSON.stringify(this.toJSON(), null, 2), 'utf-8');
      console.log(`[matchlog] Diagnostic ecrit : ${file}`);
      return file;
    } catch (e) {
      console.error('[matchlog] Ecriture du diagnostic impossible :', e.message);
      return null;
    }
  }
}

module.exports = { MatchLogger, LOG_DIR };
