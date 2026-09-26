// Journal de diagnostic par match, ecrit sur disque dans logs/matches/.
// Permet de reconstruire a posteriori pourquoi un score vaut ce qu'il vaut :
// chaque snapshot, chaque flux, et le verdict de la verification.
//
// Aucune cle privee, seed, secret ou cle d'API n'est manipulee ici : le module
// ne recoit que des adresses publiques, des quantites et des prix. Le filtre
// ci-dessous est une ceinture de securite en cas d'evolution du code.

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs', 'matches');
const MAX_POINTS_PER_PLAYER = 400;
const FORBIDDEN_KEYS = /(secret|private|seed|passphrase|apikey|api_key|token_secret|mnemonic)/i;

function scrub(value, depth = 0) {
  if (depth > 10 || value === null || typeof value !== 'object') return value;
  if (value instanceof Map) return scrub(Object.fromEntries(value), depth + 1);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(k)) continue;
    out[k] = scrub(v, depth + 1);
  }
  return out;
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
        reason: null,
        eligibility: null,
        points: [],
        verification: null,
        recomputed: null,
        calculation: null,
        status: null,
        finalPnlPct: null,
        errors: [],
      });
    }
    return this.players.get(playerId);
  }

  registerPlayer(playerId, { name, wallet, simulated, reason, eligibility, startPoint }) {
    const p = this.player(playerId);
    p.name = name;
    p.wallet = wallet;
    p.simulated = !!simulated;
    p.reason = reason || null;
    if (eligibility) p.eligibility = eligibility;
    if (startPoint) p.points.push({ ...startPoint, pnlPct: 0 });
  }

  addPoint(playerId, point, { pnlPct, alert }) {
    const p = this.player(playerId);
    // On garde toujours le point de depart, puis une fenetre glissante.
    if (p.points.length >= MAX_POINTS_PER_PLAYER) p.points.splice(1, 1);
    p.points.push({ ...point, pnlPct, alert: alert || null });
  }

  setVerification(playerId, report, recomputed) {
    const p = this.player(playerId);
    p.verification = report;
    p.recomputed = recomputed;
  }

  addError(playerId, component, error) {
    const entry = { timestamp: Date.now(), component, error: String(error?.message || error) };
    if (playerId === null) this.errors.push(entry);
    else this.player(playerId).errors.push(entry);
  }

  finalize(playerId, { calculation, status, finalPnlPct }) {
    const p = this.player(playerId);
    p.calculation = calculation || null;
    p.status = status || null;
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
