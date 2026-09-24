// Orchestration par joueur : blockchain -> prix -> equity -> flux -> performance.
// game.js ne fait qu'appeler refresh() et lire pnlPct : toute la logique de
// calcul vit ici et dans performance.js.

const { getWalletSnapshot, snapshotMints } = require('./wallet');
const { getPrices } = require('./pricing');
const { valueSnapshot, PerformanceTracker } = require('./performance');
const { fetchClassifiedTransactions, flowUsdValue, dedupeTransactions, TX_TYPE } = require('./txclassify');

// Cadences distinctes, volontairement decouplees :
//  - tick UI          : 2 s   (game.js, TICK_MS) — fluidite de l'affichage
//  - refresh wallet   : 5 s   — cout RPC maitrise, score assez frais pour du 60 s
//  - refresh prix     : 3 s   (pricing.js) — la volatilite compte plus que les balances
const WALLET_REFRESH_MS = Number(process.env.WALLET_REFRESH_MS) || 5000;

class PlayerTracker {
  constructor({ playerId, name, wallet, logger }) {
    this.playerId = playerId;
    this.name = name;
    this.wallet = wallet;
    this.logger = logger;
    this.tracker = null;
    this.lastRefreshAt = 0;
    this.lastSignature = null;
    // Un RPC peut renvoyer deux fois la meme signature (reorg, fenetre
    // glissante). Un flux compte une fois, jamais deux.
    this.seenSignatures = new Set();
    this.inFlight = null;
    this.pnlPct = 0;
    this.degraded = null;
    this.error = null;
    this.ready = false;
  }

  async initialize() {
    const snapshot = await getWalletSnapshot(this.wallet);
    const { prices, errors } = await getPrices(snapshotMints(snapshot));
    const valuation = valueSnapshot(snapshot, prices);

    for (const e of errors) this.logger?.addError(this.playerId, e.component, e.error);
    for (const e of snapshot.errors) this.logger?.addError(this.playerId, e.component, e.error);

    if (!(valuation.equity > 0)) {
      throw new Error('equity initiale nulle ou non valorisable');
    }

    // On memorise la derniere signature connue pour ne classer ensuite que les
    // transactions posterieures au debut du match.
    try {
      const { newestSignature } = await fetchClassifiedTransactions(this.wallet, null);
      this.lastSignature = newestSignature;
    } catch (e) {
      this.logger?.addError(this.playerId, 'txclassify.bootstrap', e);
    }

    this.tracker = new PerformanceTracker(valuation);
    this.lastRefreshAt = Date.now();
    this.ready = true;
    this.logger?.registerPlayer(this.playerId, {
      name: this.name,
      wallet: this.wallet,
      simulated: false,
      initialSnapshot: snapshot,
      initialValuation: valuation,
    });
    return valuation;
  }

  get initialEquity() {
    return this.tracker ? this.tracker.initialEquity : 0;
  }

  get currentEquity() {
    return this.tracker ? this.tracker.lastEquity : 0;
  }

  async collectFlows(prices) {
    if (!this.lastSignature) return { flows: [], transactions: [] };
    try {
      const fetched = await fetchClassifiedTransactions(this.wallet, this.lastSignature);
      this.lastSignature = fetched.newestSignature || this.lastSignature;
      const transactions = dedupeTransactions(fetched.transactions, this.seenSignatures);
      if (!transactions.length) return { flows: [], transactions: [] };

      const flows = [];
      for (const tx of transactions) {
        if (tx.type !== TX_TYPE.TRANSFER_IN && tx.type !== TX_TYPE.TRANSFER_OUT) continue;
        const usdValue = flowUsdValue(tx, prices);
        if (usdValue === null) {
          // Flux detecte mais non valorisable : on le signale plutot que de le
          // neutraliser avec une valeur inventee.
          this.logger?.addError(this.playerId, 'flow.unpriced', `flux ${tx.signature} non valorisable`);
          continue;
        }
        flows.push({ signature: tx.signature, type: tx.type, usdValue, slot: tx.slot });
      }
      return { flows, transactions };
    } catch (e) {
      this.logger?.addError(this.playerId, 'txclassify.refresh', e);
      return { flows: [], transactions: [] };
    }
  }

  // force = true : ignore l'intervalle (fin de match).
  async refresh({ force = false } = {}) {
    if (!this.ready) return this.pnlPct;
    const now = Date.now();
    if (!force && now - this.lastRefreshAt < WALLET_REFRESH_MS) return this.pnlPct;
    // Une seule requete en vol a la fois : evite d'empiler les appels RPC si le
    // reseau est lent par rapport au tick.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this._doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async _doRefresh() {
    try {
      const snapshot = await getWalletSnapshot(this.wallet);
      const { prices, errors } = await getPrices(snapshotMints(snapshot));
      for (const e of errors) this.logger?.addError(this.playerId, e.component, e.error);
      for (const e of snapshot.errors) this.logger?.addError(this.playerId, e.component, e.error);

      const valuation = valueSnapshot(snapshot, prices, {
        carryForward: this.tracker.carryForwardPrices(),
      });

      const { flows, transactions } = await this.collectFlows(prices);
      this.logger?.addTransactions(this.playerId, transactions);

      const result = this.tracker.update(valuation, flows);
      this.pnlPct = result.pnlPct;
      this.degraded = result.degraded;
      this.error = result.degraded ? 'Actif sans prix : score gele' : null;
      this.lastRefreshAt = Date.now();

      this.logger?.addSnapshot(this.playerId, valuation, {
        pnlPct: result.pnlPct,
        applied: result.applied,
        degraded: result.degraded,
        flows,
      });
      return this.pnlPct;
    } catch (e) {
      this.error = 'Wallet injoignable, derniere valeur connue';
      this.logger?.addError(this.playerId, 'playertracker.refresh', e);
      return this.pnlPct;
    }
  }

  // Snapshot final obligatoire : le score enregistre ne doit pas dependre d'un
  // tick vieux de plusieurs secondes.
  async finalize() {
    await this.refresh({ force: true });
    const explain = this.tracker.explain();
    this.logger?.finalize(this.playerId, {
      finalValuation: this.tracker.lastValuation,
      calculation: explain,
      finalPnlPct: this.pnlPct,
    });
    return { pnlPct: this.pnlPct, explain };
  }
}

module.exports = { PlayerTracker, WALLET_REFRESH_MS };
