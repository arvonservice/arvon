// SOURCE DE VERITE UNIQUE du calcul de performance.
//
// Aucune autre couche (game.js, db.js, frontend) ne recalcule un pourcentage.
// Elles consomment ce que ce module publie.
//
// ---------------------------------------------------------------------------
// FORMULE
//
// Sans flux externe (cas normal) :
//
//     performancePct = ((equityActuelle / equityInitiale) - 1) * 100
//
// Avec flux externes (depot / retrait pendant le match), on decoupe en
// sous-periodes aux instants de flux et on compose les rendements
// (rendement temporel pondere, TWR) :
//
//     r_i     = (V_i - F_i) / V_(i-1) - 1      F_i = flux net sur la sous-periode
//     facteur = Π (1 + r_i)
//     performancePct = (facteur - 1) * 100
//
// Sans flux, la chaine se telescope exactement en V_n / V_0 - 1 : la formule
// composee est donc rigoureusement identique au cas simple. Les flux sont
// neutralises, les gains et pertes de marche ne le sont pas.
//
// Les frais reseau et frais de swap ne sont PAS neutralises : ce sont des
// couts de trading reels, ils doivent peser sur la performance.
// ---------------------------------------------------------------------------

const { STATUS } = require('./pricing');
const { SOL_MINT } = require('./wallet');

const HOLDING_NATIVE = 'native-sol';
const HOLDING_TOKEN = 'spl-token';
const HOLDING_RENT = 'token-account-rent';

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Valorise un snapshot de quantites avec une carte de prix.
//
// carryForward : prix retenus lors d'une valorisation precedente. Si la source
// de prix ne cote plus un actif, on reutilise son dernier prix connu au lieu de
// le faire disparaitre de l'equity. Retirer un actif de l'equity revient a le
// valoriser a zero : c'est exactement la perte fantome qu'on veut eliminer.
function valueSnapshot(snapshot, priceMap, options = {}) {
  const carryForward = options.carryForward || new Map();
  const breakdown = [];
  const resolvedPrices = new Map();
  const unpriced = [];
  let equity = 0;

  const resolve = (mint) => {
    const quoted = priceMap.get(mint);
    if (quoted && quoted.price !== null) {
      return { price: quoted.price, status: quoted.status, ageMs: quoted.ageMs, source: 'quote' };
    }
    const carried = carryForward.get(mint);
    if (carried !== undefined && carried !== null) {
      return { price: carried, status: STATUS.STALE, ageMs: null, source: 'carry-forward' };
    }
    return { price: null, status: STATUS.UNPRICED, ageMs: null, source: 'none' };
  };

  const push = (kind, mint, amount, extra) => {
    const { price, status, ageMs, source } = resolve(mint);
    const value = price === null ? null : amount * price;
    if (price !== null) {
      equity += value;
      resolvedPrices.set(mint, price);
    } else if (amount > 0) {
      unpriced.push({ kind, mint, amount });
    }
    breakdown.push({ kind, mint, amount, price, priceStatus: status, priceAgeMs: ageMs, priceSource: source, value, ...extra });
  };

  push(HOLDING_NATIVE, SOL_MINT, snapshot.native.amount, { label: 'SOL' });
  // Ouvrir une position cree un compte de token et immobilise du SOL en rent.
  // Ce SOL quitte le solde natif sans quitter le patrimoine du joueur : sans
  // cette ligne, ouvrir une position ressemble a une perte seche.
  if (snapshot.rent && snapshot.rent.amount > 0) {
    push(HOLDING_RENT, SOL_MINT, snapshot.rent.amount, {
      label: 'SOL immobilise (rent)',
      accounts: snapshot.rent.accounts,
      recoverable: true,
    });
  }
  for (const asset of snapshot.assets) {
    push(HOLDING_TOKEN, asset.mint, asset.amount, {
      raw: asset.raw,
      decimals: asset.decimals,
      program: asset.program,
    });
  }

  const pricedCount = breakdown.filter((b) => b.price !== null).length;

  return {
    wallet: snapshot.wallet,
    timestamp: snapshot.timestamp,
    slot: snapshot.slot,
    equity,
    breakdown,
    resolvedPrices,
    unpricedAssets: unpriced,
    coverage: breakdown.length ? pricedCount / breakdown.length : 1,
  };
}

// Un actif detenu qu'on n'a jamais su coter rend l'equity structurellement
// sous-evaluee. On refuse alors de publier un score plutot que d'afficher une
// perte qui n'existe pas. Les actifs deja non cotes dans la reference sont
// exclus des deux cotes : c'est symetrique, donc sans effet sur le ratio.
function detectDegradation(valuation, referenceValuation) {
  if (!valuation.unpricedAssets.length) return null;
  const knownAtReference = referenceValuation
    ? new Set(referenceValuation.breakdown.filter((b) => b.price !== null).map((b) => b.mint))
    : new Set();
  const excludedAtReference = referenceValuation
    ? new Set(referenceValuation.unpricedAssets.map((u) => u.mint))
    : new Set();

  const blocking = valuation.unpricedAssets.filter(
    (u) => !excludedAtReference.has(u.mint) || knownAtReference.has(u.mint)
  );
  if (!blocking.length) return null;
  return {
    reason: 'unpriced-holdings',
    mints: blocking.map((b) => b.mint),
    detail: 'actif detenu sans prix connu : equity sous-evaluee, score gele',
  };
}

// Suit la performance d'un joueur sur toute la duree d'un match.
class PerformanceTracker {
  constructor(initialValuation) {
    this.initialValuation = initialValuation;
    this.initialEquity = initialValuation.equity;
    this.lastValuation = initialValuation;
    this.lastEquity = initialValuation.equity;
    this.cumulativeFactor = 1;
    this.pnlPct = 0;
    this.subPeriods = [];
    this.totalFlowUsd = 0;
    this.degraded = null;
    this.frozenTicks = 0;
  }

  // Prix de repli : le dernier jeu de prix reellement observe.
  carryForwardPrices() {
    return this.lastValuation.resolvedPrices;
  }

  // flows : transactions classees comme entrees/sorties de capital externes,
  // survenues depuis la derniere valorisation.
  update(valuation, flows = []) {
    const degraded = detectDegradation(valuation, this.initialValuation);
    if (degraded) {
      // Score gele : on ne chaine pas une sous-periode fausse, elle
      // contaminerait definitivement le facteur cumule.
      this.degraded = degraded;
      this.frozenTicks++;
      return { pnlPct: this.pnlPct, applied: false, degraded };
    }
    this.degraded = null;

    const flowUsd = flows.reduce((sum, f) => sum + (f.usdValue || 0), 0);
    this.totalFlowUsd += flowUsd;

    if (this.lastEquity > 0) {
      const adjustedEnd = valuation.equity - flowUsd;
      const r = adjustedEnd / this.lastEquity - 1;
      if (Number.isFinite(r)) {
        this.cumulativeFactor *= 1 + r;
        this.subPeriods.push({
          from: this.lastValuation.timestamp,
          to: valuation.timestamp,
          startEquity: this.lastEquity,
          endEquity: valuation.equity,
          flowUsd,
          adjustedEndEquity: adjustedEnd,
          periodReturnPct: round2(r * 100),
        });
      }
    }

    this.lastValuation = valuation;
    this.lastEquity = valuation.equity;
    this.pnlPct = round2((this.cumulativeFactor - 1) * 100);
    return { pnlPct: this.pnlPct, applied: true, degraded: null };
  }

  // Trace complete du calcul, telle qu'ecrite dans le log de diagnostic.
  explain() {
    const hasFlows = Math.abs(this.totalFlowUsd) > 1e-9;
    return {
      initialEquity: this.initialEquity,
      finalEquity: this.lastEquity,
      totalExternalFlowUsd: this.totalFlowUsd,
      method: hasFlows ? 'time-weighted-return (flux externes neutralises)' : 'simple-ratio',
      formula: hasFlows
        ? 'performancePct = (Prod((V_i - F_i) / V_(i-1)) - 1) * 100'
        : 'performancePct = ((finalEquity / initialEquity) - 1) * 100',
      cumulativeFactor: this.cumulativeFactor,
      rawPerformance: (this.cumulativeFactor - 1) * 100,
      roundedPerformance: round2((this.cumulativeFactor - 1) * 100),
      finalPnlPct: this.pnlPct,
      subPeriodCount: this.subPeriods.length,
      frozenTicks: this.frozenTicks,
    };
  }
}

// Helper direct, sans etat : utilise par les tests et les calculs ponctuels.
function simplePerformance(initialEquity, currentEquity) {
  if (!(initialEquity > 0)) return 0;
  return round2((currentEquity / initialEquity - 1) * 100);
}

module.exports = {
  valueSnapshot,
  detectDegradation,
  PerformanceTracker,
  simplePerformance,
  round2,
  HOLDING_NATIVE,
  HOLDING_TOKEN,
  HOLDING_RENT,
};
