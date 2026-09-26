// Verification anti-triche de fin de match.
//
// Relit toutes les transactions du joueur sur la duree du match et cherche de
// la valeur entree sans contrepartie : un depot depuis un autre wallet, ou des
// fonds glisses a l'interieur d'un swap par un second signataire.
//
// Le verdict ne decide pas de la sanction : game.js l'applique selon le type
// de match (neutralisation en gratuit, disqualification en match a mise).

const { classify, dedupeTransactions, fetchTransaction, signaturesInWindow, TX_TYPE } = require('./txclassify');
const { SOL_MINT } = require('./wallet');

const defaultSource = { fetchTransaction, signaturesInWindow };

const VERDICT = {
  CLEAN: 'clean',
  INFLOWS: 'inflows',
  UNVERIFIED: 'unverified',
};

// En dessous de ce seuil, une entree n'est pas consideree comme une triche :
// des airdrops arrivent sans arret sur Solana. Cumulatif, pour qu'on ne puisse
// pas deposer en plusieurs petites fois.
const MIN_INFLOW_ABS_SOL = Number(process.env.VERIFY_MIN_INFLOW_SOL) || 0.0005;
const MIN_INFLOW_REL = Number(process.env.VERIFY_MIN_INFLOW_REL) || 0.01;

function summarize(c) {
  return {
    signature: c.signature,
    slot: c.slot,
    timestamp: c.timestamp,
    type: c.type,
    walletSigned: c.walletSigned,
    fee: c.fee,
    solSide: c.solSide,
    tokenChanges: c.tokenChanges,
    programs: c.programs,
  };
}

// candidateAccounts : comptes de token dont le contenu a change pendant le
//   match. Un depot de tokens n'apparait que dans l'historique du compte qui le
//   recoit, pas dans celui du wallet : il faut donc aussi les interroger.
// pricesAtSlot(slot) : Map mint -> prix en SOL a ce moment du match.
// rentCounted(address, mint, prices) : la caution de ce compte compte-t-elle
//   dans la valeur ? (cf. MatchPerformance.isRentCounted)
async function verifyWallet({
  wallet,
  fromSlot,
  toSlot,
  candidateAccounts = [],
  pricesAtSlot,
  rentCounted,
  capitalSol,
  ignoredSources = new Set(),
  source = defaultSource,
}) {
  const thresholdSol = Math.max(MIN_INFLOW_ABS_SOL, MIN_INFLOW_REL * capitalSol);
  const report = {
    status: null,
    wallet,
    fromSlot,
    toSlot,
    checkedAt: Date.now(),
    thresholdSol,
    suspectInflowSol: 0,
    inflows: [],
    neutralize: [],
    transactions: [],
    truncated: false,
    errors: [],
  };

  try {
    const seen = new Set();
    const classified = [];

    const load = async (signatures) => {
      for (const s of dedupeTransactions(signatures, seen)) {
        // Une transaction echouee ne deplace rien (hors frais, deja dans le
        // snapshot) : inutile de la telecharger.
        if (s.failed) continue;
        const tx = await source.fetchTransaction(s.signature);
        if (!tx) throw new Error(`transaction ${s.signature} pas encore disponible`);
        classified.push(classify(tx, wallet, { ignoredSources }));
      }
    };

    const walletSigs = await source.signaturesInWindow(wallet, fromSlot, toSlot);
    report.truncated = report.truncated || walletSigs.truncated;
    await load(walletSigs.signatures);

    // Un tour sur les comptes de token : ceux dont le contenu a change, et ceux
    // que les transactions du wallet ont touches.
    const accounts = new Set(candidateAccounts.filter(Boolean));
    for (const c of classified) for (const a of c.touchedAccounts) accounts.add(a);
    for (const address of accounts) {
      const sigs = await source.signaturesInWindow(address, fromSlot, toSlot);
      report.truncated = report.truncated || sigs.truncated;
      await load(sigs.signatures);
    }

    classified.sort((a, b) => a.slot - b.slot);
    report.transactions = classified.map(summarize);

    for (const c of classified) {
      const prices = pricesAtSlot(c.slot);
      const platform = c.type === TX_TYPE.PLATFORM;

      for (const f of [...c.inflows, ...c.injections]) {
        const price = f.kind === 'sol' || f.mint === SOL_MINT ? 1 : prices.get(f.mint);
        const valueSol = price ? f.amount * price : null;
        report.inflows.push({
          signature: c.signature,
          slot: c.slot,
          type: c.type,
          kind: f.kind,
          mint: f.mint,
          amount: f.amount,
          from: f.from || null,
          injected: c.injections.includes(f),
          valueSol,
        });
        // Un token que personne ne cote vaut 0 dans le score : il n'y a rien a
        // neutraliser, et c'est presque toujours du spam.
        if (!(valueSol > 0)) continue;
        report.neutralize.push({ slot: c.slot, valueSol, reason: platform ? 'paiement Arvon' : 'entree externe' });
        if (!platform) report.suspectInflowSol += valueSol;
      }

      // Caution offerte par un tiers : neutralisee si elle compte dans la
      // valeur, mais jamais suspecte (ce sont les spams qui en offrent).
      for (const g of c.rentGifts) {
        if (rentCounted(g.address, g.mint, prices)) {
          report.neutralize.push({ slot: c.slot, valueSol: g.amountSol, reason: 'caution payee par un tiers' });
        }
      }
    }

    if (report.truncated) report.status = VERDICT.UNVERIFIED;
    else report.status = report.suspectInflowSol >= thresholdSol ? VERDICT.INFLOWS : VERDICT.CLEAN;
  } catch (e) {
    report.status = VERDICT.UNVERIFIED;
    report.errors.push(e.message);
  }
  return report;
}

module.exports = { verifyWallet, VERDICT, MIN_INFLOW_ABS_SOL, MIN_INFLOW_REL };
