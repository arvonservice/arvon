// Orchestration par joueur : depart propre -> score en direct -> cloture ->
// verification. game.js n'appelle que ces methodes et lit pnlPct : tout le
// calcul vit dans performance.js.

const { getWalletSnapshot, snapshotMints } = require('./wallet');
const { getPrices } = require('./pricing');
const { assessEligibility, MatchPerformance } = require('./performance');
const { verifyWallet, VERDICT } = require('./verification');

// Cadences decouplees :
//  - tick UI         : 2 s   (game.js) — fluidite de l'affichage
//  - refresh wallet  : 5 s   — cout RPC maitrise, score assez frais
//  - refresh prix    : 3 s   (pricing.js)
//  - transactions    : lues une seule fois, a la fin, par la verification
const WALLET_REFRESH_MS = Number(process.env.WALLET_REFRESH_MS) || 5000;

// extraMints(snapshot) : mints a coter en plus de ceux detenus. Un compte
// ouvert pendant le match puis vide (achat et revente entre deux snapshots)
// ne detient plus rien, mais sa caution ne compte que si son token est cote.
async function readWallet(wallet, extraMints = () => []) {
  const snapshot = await getWalletSnapshot(wallet);
  const { prices, errors } = await getPrices([...snapshotMints(snapshot), ...extraMints(snapshot)]);
  return { snapshot, prices, errors: [...snapshot.errors, ...errors] };
}

// Controle du depart propre, sans demarrer de suivi (files d'attente, defis).
async function checkWallet(wallet) {
  const { snapshot, prices } = await readWallet(wallet);
  return assessEligibility(snapshot, prices);
}

const fmtSol = (n) => (n >= 0.01 ? n.toFixed(4) : n.toPrecision(2));
const shortMint = (m) => `${m.slice(0, 4)}...${m.slice(-4)}`;

function eligibilityMessage(eligibility) {
  const lines = [];
  for (const p of eligibility.problems) {
    if (p.code === 'insufficient-sol') {
      lines.push(
        `Il faut au moins ${p.minimumSol} SOL sur ton wallet pour jouer (tu en as ${fmtSol(p.nativeSol)}). ` +
          `Ouvrir une position et payer les frais coute du SOL.`
      );
    } else if (p.code === 'unclean-start') {
      const list = p.tokens
        .slice(0, 4)
        .map((t) => `${t.symbol || shortMint(t.mint)} (~${fmtSol(t.valueSol)} SOL)`)
        .join(', ');
      const more = p.tokens.length > 4 ? ` et ${p.tokens.length - 4} autre(s)` : '';
      lines.push(
        `Pour jouer, ton wallet ne doit contenir que du SOL (et des stablecoins). ` +
          `Tokens detectes : ${list}${more}. Vends-les, ou utilise un wallet dedie a Arvon.`
      );
    } else if (p.code === 'price-unavailable') {
      lines.push('Le prix du SOL est momentanement indisponible. Reessaie dans quelques secondes.');
    }
  }
  return lines.join(' ');
}

class PlayerTracker {
  constructor({ playerId, name, wallet, logger }) {
    this.playerId = playerId;
    this.name = name;
    this.wallet = wallet;
    this.logger = logger;
    this.perf = null;
    this.ready = false;
    this.pnlPct = 0;
    this.neutralizedPnlPct = null;
    this.alert = null;
    this.error = null;
    this.eligibility = null;
    this.verification = null;
    this.lastRefreshAt = 0;
    this.inFlight = null;
    // Etat de chaque compte de token, pour savoir lesquels ont change pendant
    // le match (la verification doit interroger leur historique).
    this.accountStates = new Map();
  }

  logErrors(errors) {
    for (const e of errors || []) this.logger?.addError(this.playerId, e.component, e.error);
  }

  recordAccounts(snapshot) {
    const present = new Set();
    for (const a of snapshot.tokenAccounts || []) {
      present.add(a.address);
      const state = `${a.raw}:${a.rentLamports}`;
      const known = this.accountStates.get(a.address);
      if (!known) this.accountStates.set(a.address, { first: this.ready ? null : state, last: state });
      else known.last = state;
    }
    for (const [address, known] of this.accountStates) {
      if (!present.has(address)) known.last = null;
    }
  }

  changedAccounts() {
    return [...this.accountStates].filter(([, s]) => s.first !== s.last).map(([address]) => address);
  }

  // Renvoie { eligible, eligibility }. Leve si le wallet est illisible.
  async initialize() {
    const { snapshot, prices, errors } = await readWallet(this.wallet);
    this.logErrors(errors);
    this.eligibility = assessEligibility(snapshot, prices);
    if (!this.eligibility.eligible) return { eligible: false, eligibility: this.eligibility };

    this.perf = new MatchPerformance(snapshot, prices);
    this.recordAccounts(snapshot);
    this.ready = true;
    this.lastRefreshAt = Date.now();
    this.logger?.registerPlayer(this.playerId, {
      name: this.name,
      wallet: this.wallet,
      simulated: false,
      eligibility: this.eligibility,
      startPoint: this.perf.points[0],
    });
    return { eligible: true, eligibility: this.eligibility };
  }

  // force = true : ignore l'intervalle (snapshot de cloture).
  async refresh({ force = false } = {}) {
    if (!this.ready) return this.pnlPct;
    if (!force && Date.now() - this.lastRefreshAt < WALLET_REFRESH_MS) return this.pnlPct;
    // Une seule lecture en vol : evite d'empiler les appels si le reseau est
    // plus lent que le tick.
    if (this.inFlight) {
      if (!force) return this.inFlight;
      await this.inFlight;
    }
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  newAccountMints(snapshot) {
    return (snapshot.tokenAccounts || [])
      .filter((a) => !this.perf.startAccounts.has(a.address))
      .map((a) => a.mint);
  }

  async doRefresh() {
    try {
      const { snapshot, prices, errors } = await readWallet(this.wallet, (s) => this.newAccountMints(s));
      this.logErrors(errors);
      const { pnlPct, alert, point } = this.perf.update(snapshot, prices);
      this.recordAccounts(snapshot);
      this.pnlPct = pnlPct;
      // L'alerte reste affichee jusqu'a la verification de fin de match.
      if (alert && !this.alert) this.alert = { ...alert, slot: snapshot.slot };
      const unpriced = point.legs.filter((l) => l.unpriced);
      this.error = unpriced.length ? 'Token sans prix : compte pour 0 tant qu il n a pas de cours' : null;
      this.lastRefreshAt = Date.now();
      this.logger?.addPoint(this.playerId, point, { pnlPct, alert });
    } catch (e) {
      this.error = 'Wallet injoignable, derniere valeur connue';
      this.logger?.addError(this.playerId, 'playertracker.refresh', e);
    }
    return this.pnlPct;
  }

  // Snapshot de cloture : le score enregistre ne depend jamais d'un tick ancien.
  async close() {
    if (!this.ready) return this.pnlPct;
    return this.refresh({ force: true });
  }

  // Verifie la fenetre du match jusqu'au dernier snapshot (ou jusqu'a toSlot,
  // pour un joueur elimine en Battle Royale).
  async verify({ ignoredSources, toSlot } = {}) {
    if (!this.ready) return null;
    const perf = this.perf;
    const report = await verifyWallet({
      wallet: this.wallet,
      fromSlot: perf.points[0].slot,
      toSlot: toSlot ?? perf.lastPoint.slot,
      candidateAccounts: this.changedAccounts(),
      pricesAtSlot: (slot) => perf.pricesAtSlot(slot),
      rentCounted: (address, mint, prices) => perf.isRentCounted(address, mint, prices),
      capitalSol: perf.capitalSol,
      ignoredSources,
    });
    this.verification = report;
    const recomputed = perf.recompute(report.status === VERDICT.UNVERIFIED ? [] : report.neutralize);
    this.neutralizedPnlPct = recomputed.pnlPct;
    this.logger?.setVerification(this.playerId, report, recomputed);
    return report;
  }

  explain(extra = {}) {
    return this.perf ? this.perf.explain(extra) : null;
  }
}

module.exports = { PlayerTracker, checkWallet, eligibilityMessage, WALLET_REFRESH_MS };
