// SOURCE DE VERITE UNIQUE du calcul de performance.
//
// Aucune autre couche (game.js, db.js, frontend) ne calcule un pourcentage.
// Elles consomment ce que ce module publie.
//
// ---------------------------------------------------------------------------
// CE QU'ON MESURE
//
// La performance de ce que le joueur a fait PENDANT le match, exprimee en SOL.
//
//  - Unite : le SOL. Un joueur qui ne fait rien marque exactement 0, meme si
//    le cours du SOL bouge pendant le match.
//  - Depart propre : au lancement, le wallet ne contient que du SOL et des
//    stablecoins, plus des poussieres tolerees (cf. assessEligibility).
//  - Les avoirs d'avant le match sont hors jeu : ils comptent dans le capital
//    de depart a leur valeur initiale, puis seules les VARIATIONS de quantite
//    sont valorisees au prix courant. Detenir un token qui pompe ne rapporte
//    rien ; en acheter un pendant le match, si.
//  - Un token que personne ne sait coter vaut 0 : spam d'airdrop ou token trop
//    recent. S'il obtient un prix plus tard, il est revalorise.
//  - Cautions des comptes de token (rent), suivies compte par compte :
//      * comptes existants au depart : capital mort, hors capital. Si le joueur
//        les ferme, le SOL libere devient du capital (entree neutralisee) ;
//      * comptes ouverts pendant le match pour un token cote : leur caution
//        reste dans la valeur (ouvrir une position n'est pas une perte) ;
//      * comptes ouverts par un tiers pour un token non cote (spam) : ignores.
//  - Les frais reseau, de swap et le slippage restent dans la performance :
//    ce sont des couts de trading reels.
//
// FORMULE (rendement temporel pondere, une sous-periode par snapshot)
//
//     V_i  = SOL natif + avoirs de depart figes + cautions des comptes ouverts
//            pendant le match + Σ (q_i - q_0) x prix_i
//     r_i  = (V_i + sorties_i) / (V_(i-1) + entrees_i) - 1
//     performancePct = (Π (1 + r_i) - 1) x 100
//
// Placement conservateur des flux : une entree de capital est supposee
// disponible des le debut de la sous-periode, une sortie seulement a la fin.
// Aucun mouvement de capital ne peut donc gonfler un rendement.
// ---------------------------------------------------------------------------

const { STATUS } = require('./pricing');
const { SOL_MINT, USDC_MINT, USDT_MINT } = require('./wallet');

const HOLDING_NATIVE = 'native-sol';
const HOLDING_TOKEN = 'spl-token';
const HOLDING_RENT = 'token-account-rent';
const LAMPORTS = 1e9;

// Regles de depart.
const MIN_START_SOL = Number(process.env.MIN_START_SOL) || 0.003;
const DUST_ABS_SOL = Number(process.env.DUST_ABS_SOL) || 0.0005;
const DUST_REL = Number(process.env.DUST_REL) || 0.01;

// Seuls actifs autorises au depart : SOL (natif ou wrappe) et stablecoins, dont
// le prix est fiable. Les stablecoins sont indispensables aux mises en USDT.
const START_ALLOWED_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

// Alerte en direct : entree de valeur sans contrepartie.
const ALERT_ABS_SOL = 0.0005;
const ALERT_REL = 0.005;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ===========================================================================
// Patrimoine en USD — diagnostic uniquement (outils d'inspection). Le score de
// match n'utilise PAS cette fonction.
// ===========================================================================

function valueSnapshot(snapshot, priceMap, options = {}) {
  const carryForward = options.carryForward || new Map();
  const breakdown = [];
  const resolvedPrices = new Map();
  const unpriced = [];
  let equity = 0;

  const resolve = (mint) => {
    const quoted = priceMap.get(mint);
    if (quoted && quoted.price !== null) {
      return {
        price: quoted.price,
        status: quoted.status,
        ageMs: quoted.ageMs,
        source: 'quote',
        crossCheck: quoted.crossCheck || null,
      };
    }
    const carried = carryForward.get(mint);
    if (carried !== undefined && carried !== null) {
      return { price: carried, status: STATUS.STALE, ageMs: null, source: 'carry-forward', crossCheck: null };
    }
    return { price: null, status: STATUS.UNPRICED, ageMs: null, source: 'none', crossCheck: null };
  };

  const push = (kind, mint, amount, extra) => {
    const { price, status, ageMs, source, crossCheck } = resolve(mint);
    const value = price === null ? null : amount * price;
    if (price !== null) {
      equity += value;
      resolvedPrices.set(mint, price);
    } else if (amount > 0) {
      unpriced.push({ kind, mint, amount });
    }
    breakdown.push({
      kind,
      mint,
      amount,
      price,
      priceStatus: status,
      priceAgeMs: ageMs,
      priceSource: source,
      crossCheck,
      value,
      ...extra,
    });
  };

  push(HOLDING_NATIVE, SOL_MINT, snapshot.native.amount, { label: 'SOL' });
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

// ===========================================================================
// Prix exprimes en SOL
// ===========================================================================

// carryForward : Map mint -> prix en SOL deja observe. Si la source ne cote
// plus un actif, son dernier prix connu est reporte plutot que de le perdre.
function pricesInSol(priceMap, carryForward = new Map()) {
  const out = new Map();
  out.set(SOL_MINT, { price: 1, source: 'unit' });
  const sol = priceMap.get(SOL_MINT);
  const solUsd = sol && sol.price !== null ? sol.price : null;

  if (solUsd) {
    for (const [mint, quote] of priceMap) {
      if (mint === SOL_MINT || !quote || quote.price === null) continue;
      out.set(mint, { price: quote.price / solUsd, source: 'quote', status: quote.status });
    }
  }
  for (const [mint, price] of carryForward) {
    if (!out.has(mint) && price !== null && price !== undefined) {
      out.set(mint, { price, source: 'carry-forward', status: STATUS.STALE });
    }
  }
  return out;
}

function priceNumbers(pricesSol) {
  const out = new Map();
  for (const [mint, p] of pricesSol) out.set(mint, p.price);
  return out;
}

function quantitiesOf(snapshot) {
  const q = new Map();
  for (const a of snapshot.assets) q.set(a.mint, (q.get(a.mint) || 0) + a.amount);
  return q;
}

// ===========================================================================
// Depart propre
// ===========================================================================

function assessEligibility(snapshot, priceMap) {
  const sol = pricesInSol(priceMap);
  const nativeSol = snapshot.native.amount;
  const allowed = [];
  const volatile = [];
  const unpriced = [];
  const problems = [];
  let capitalSol = nativeSol;

  for (const a of snapshot.assets) {
    const p = sol.get(a.mint);
    const valueSol = p ? a.amount * p.price : null;
    const symbol = priceMap.get(a.mint)?.crossCheck?.symbol || null;
    if (START_ALLOWED_MINTS.has(a.mint)) {
      if (valueSol === null) {
        problems.push({ code: 'price-unavailable', mint: a.mint });
        continue;
      }
      allowed.push({ mint: a.mint, symbol, amount: a.amount, valueSol });
      capitalSol += valueSol;
    } else if (valueSol === null) {
      // Token que personne ne cote : spam d'airdrop dans l'immense majorite des
      // cas. Il ne bloque pas le depart et vaut 0 dans le calcul.
      unpriced.push({ mint: a.mint, amount: a.amount });
    } else {
      volatile.push({ mint: a.mint, symbol, amount: a.amount, valueSol });
    }
  }

  volatile.sort((x, y) => y.valueSol - x.valueSol);
  const volatileSol = volatile.reduce((s, v) => s + v.valueSol, 0);
  // Les poussieres tolerees font partie du capital de depart : sinon on
  // pourrait trader avec sans qu'elles comptent au denominateur.
  capitalSol += volatileSol;
  const toleranceSol = Math.max(DUST_ABS_SOL, DUST_REL * capitalSol);

  if (nativeSol < MIN_START_SOL) {
    problems.push({ code: 'insufficient-sol', nativeSol, minimumSol: MIN_START_SOL });
  }
  if (volatileSol > toleranceSol) {
    problems.push({ code: 'unclean-start', volatileSol, toleranceSol, tokens: volatile });
  }

  return {
    eligible: problems.length === 0,
    problems,
    capitalSol,
    nativeSol,
    allowed,
    volatile,
    unpriced,
    volatileSol,
    toleranceSol,
  };
}

// ===========================================================================
// Performance de match
// ===========================================================================

// Rendement d'une sous-periode, flux places de facon conservatrice.
function periodReturn(prev, cur, externalIn = 0) {
  const denominator = prev.value + cur.rentFlowIn + externalIn;
  if (!(denominator > 0)) return 0;
  return (cur.value + cur.rentFlowOut) / denominator - 1;
}

// Signal d'alerte : de la valeur est apparue sans que rien ne sorte en face.
// Un swap echange toujours quelque chose contre autre chose ; un depot, non.
// Ce n'est pas une preuve (la verification de fin de match tranche), juste de
// quoi afficher « verification » a cote du joueur.
function detectInflow(prev, cur, pricesSol) {
  const wrapped = (cur.quantities.get(SOL_MINT) || 0) - (prev.quantities.get(SOL_MINT) || 0);
  const solSide = cur.native - prev.native + (cur.countedRent - prev.countedRent) + wrapped;

  let tokensInSol = 0;
  let somethingLeft = false;
  for (const mint of new Set([...prev.quantities.keys(), ...cur.quantities.keys()])) {
    if (mint === SOL_MINT) continue;
    const dq = (cur.quantities.get(mint) || 0) - (prev.quantities.get(mint) || 0);
    if (dq < 0) somethingLeft = true;
    else if (dq > 0) {
      const p = pricesSol.get(mint);
      if (p) tokensInSol += dq * p.price;
    }
  }
  if (somethingLeft) return null;

  const threshold = Math.max(ALERT_ABS_SOL, ALERT_REL * prev.value);
  if (solSide > threshold) return { reason: 'sol-sans-contrepartie', amountSol: solSide };
  // Recevoir plus de 4 fois ce qu'on a paye en SOL n'est pas un achat.
  if (tokensInSol > threshold && solSide > -0.25 * tokensInSol) {
    return { reason: 'tokens-sans-contrepartie', valueSol: tokensInSol, paidSol: -solSide };
  }
  return null;
}

class MatchPerformance {
  constructor(startSnapshot, startPriceMap) {
    const pricesSol = pricesInSol(startPriceMap);
    this.startQuantities = quantitiesOf(startSnapshot);

    // Avoirs d'avant le match, figes a leur valeur de depart : hors jeu.
    // Un token non cote vaut 0, comme dans assessEligibility.
    let holdings = 0;
    for (const [mint, qty] of this.startQuantities) {
      const p = pricesSol.get(mint);
      if (p) holdings += qty * p.price;
    }
    this.startNativeSol = startSnapshot.native.amount;
    this.startHoldingsSol = holdings;
    this.capitalSol = this.startNativeSol + holdings;

    // Comptes de token existants au depart : leur caution est du capital mort.
    this.startAccounts = new Map();
    let oldRentLamports = 0;
    for (const a of startSnapshot.tokenAccounts || []) {
      this.startAccounts.set(a.address, a.rentLamports);
      oldRentLamports += a.rentLamports;
    }
    this.startOldRentLamports = oldRentLamports;

    this.points = [
      {
        slot: startSnapshot.slot,
        timestamp: startSnapshot.timestamp,
        native: this.startNativeSol,
        quantities: this.startQuantities,
        pricesSol: priceNumbers(pricesSol),
        releasedRent: 0,
        newRent: 0,
        countedRent: oldRentLamports / LAMPORTS,
        value: this.capitalSol,
        rentFlowIn: 0,
        rentFlowOut: 0,
        legs: [],
      },
    ];
    this.factor = 1;
    this.pnlPct = 0;
  }

  get lastPoint() {
    return this.points[this.points.length - 1];
  }

  // Une caution compte-t-elle dans la valeur ? Oui pour un compte existant au
  // depart (via le SOL libere) ou pour un compte de token cote.
  isRentCounted(address, mint, pricesSol) {
    return this.startAccounts.has(address) || pricesSol.has(mint);
  }

  rentState(snapshot, pricesSol) {
    let oldLamports = 0;
    let newLamports = 0;
    for (const a of snapshot.tokenAccounts || []) {
      if (this.startAccounts.has(a.address)) oldLamports += a.rentLamports;
      else if (pricesSol.has(a.mint)) newLamports += a.rentLamports;
    }
    const released = Math.max(0, this.startOldRentLamports - oldLamports) / LAMPORTS;
    const newRent = newLamports / LAMPORTS;
    return { releasedRent: released, newRent, countedRent: (oldLamports + newLamports) / LAMPORTS };
  }

  valueOf(snapshot, pricesSol, newRent) {
    const quantities = quantitiesOf(snapshot);
    let value = snapshot.native.amount + this.startHoldingsSol + newRent;
    const legs = [];
    for (const mint of new Set([...this.startQuantities.keys(), ...quantities.keys()])) {
      const deltaQty = (quantities.get(mint) || 0) - (this.startQuantities.get(mint) || 0);
      if (deltaQty === 0) continue;
      const p = pricesSol.get(mint);
      if (!p) {
        legs.push({ mint, deltaQty, priceSol: null, priceSource: 'none', valueSol: 0, unpriced: true });
        continue;
      }
      value += deltaQty * p.price;
      legs.push({ mint, deltaQty, priceSol: p.price, priceSource: p.source, valueSol: deltaQty * p.price });
    }
    return { value, legs, quantities };
  }

  update(snapshot, priceMap) {
    const last = this.lastPoint;
    const pricesSol = pricesInSol(priceMap, last.pricesSol);
    const rent = this.rentState(snapshot, pricesSol);
    const { value, legs, quantities } = this.valueOf(snapshot, pricesSol, rent.newRent);

    const current = { native: snapshot.native.amount, countedRent: rent.countedRent, quantities };
    const alert = detectInflow(last, current, pricesSol);

    const releasedDelta = rent.releasedRent - last.releasedRent;
    const point = {
      slot: snapshot.slot,
      timestamp: snapshot.timestamp,
      native: snapshot.native.amount,
      quantities,
      pricesSol: priceNumbers(pricesSol),
      releasedRent: rent.releasedRent,
      newRent: rent.newRent,
      countedRent: rent.countedRent,
      value,
      // Caution d'un ancien compte liberee : le SOL rejoint le capital.
      rentFlowIn: releasedDelta > 0 ? releasedDelta : 0,
      // Ancien compte recree : du SOL repart en caution morte.
      rentFlowOut: releasedDelta < 0 ? -releasedDelta : 0,
      legs,
    };
    this.points.push(point);
    this.factor *= 1 + periodReturn(last, point);
    this.pnlPct = round2((this.factor - 1) * 100);
    return { pnlPct: this.pnlPct, alert, point };
  }

  // Prix en SOL en vigueur a un slot donne : ceux du premier snapshot qui suit.
  pricesAtSlot(slot) {
    const point = this.points.find((p) => p.slot >= slot) || this.lastPoint;
    return point.pricesSol;
  }

  // Recalcule toute la chaine en ajoutant des entrees de capital externes
  // (depots detectes par la verification), chacune dans sa sous-periode.
  recompute(externalInflows = []) {
    let factor = 1;
    const periods = [];
    for (let i = 1; i < this.points.length; i++) {
      const prev = this.points[i - 1];
      const cur = this.points[i];
      const externalIn = externalInflows
        .filter((f) => f.slot > prev.slot && f.slot <= cur.slot)
        .reduce((s, f) => s + f.valueSol, 0);
      const r = periodReturn(prev, cur, externalIn);
      factor *= 1 + r;
      periods.push({
        fromSlot: prev.slot,
        toSlot: cur.slot,
        startValueSol: prev.value,
        endValueSol: cur.value,
        rentFlowInSol: cur.rentFlowIn,
        rentFlowOutSol: cur.rentFlowOut,
        externalInSol: externalIn,
        returnPct: r * 100,
      });
    }
    return { factor, pnlPct: round2((factor - 1) * 100), periods };
  }

  explain(extra = {}) {
    const last = this.lastPoint;
    return {
      unit: 'SOL',
      method: 'rendement temporel pondere en SOL ; avoirs d avant le match hors jeu',
      formula: 'r_i = (V_i + sorties_i) / (V_(i-1) + entrees_i) - 1 ; performance = (Prod(1 + r_i) - 1) x 100',
      startCapitalSol: this.capitalSol,
      startNativeSol: this.startNativeSol,
      startHoldingsSol: this.startHoldingsSol,
      deadRentAtStartSol: this.startOldRentLamports / LAMPORTS,
      finalValueSol: last.value,
      rentReleasedSol: last.releasedRent,
      rentLockedInNewAccountsSol: last.newRent,
      unpricedAtClose: last.legs.filter((l) => l.unpriced),
      pointCount: this.points.length,
      factor: this.factor,
      rawPerformance: (this.factor - 1) * 100,
      pnlPct: this.pnlPct,
      ...extra,
    };
  }
}

module.exports = {
  valueSnapshot,
  pricesInSol,
  quantitiesOf,
  assessEligibility,
  MatchPerformance,
  periodReturn,
  detectInflow,
  round2,
  START_ALLOWED_MINTS,
  MIN_START_SOL,
  DUST_ABS_SOL,
  DUST_REL,
  HOLDING_NATIVE,
  HOLDING_TOKEN,
  HOLDING_RENT,
};
