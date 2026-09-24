// Compare l'equity calculee par l'ancien pipeline et par le nouveau, et mesure
// le poids des frais fixes Solana par rapport a la taille du portefeuille.
//   node tools/impact-report.js <adresse>

const { getWalletSnapshot, snapshotMints, connection, SOL_MINT } = require('../lib/wallet');
const { getPrices } = require('../lib/pricing');
const { valueSnapshot } = require('../lib/performance');

const wallet = process.argv[2];
if (!wallet) {
  console.error('Usage: node tools/impact-report.js <adresse-solana>');
  process.exit(1);
}

(async () => {
  const snapshot = await getWalletSnapshot(wallet);
  const { prices } = await getPrices(snapshotMints(snapshot));
  const valuation = valueSnapshot(snapshot, prices);
  const solPrice = prices.get(SOL_MINT).price;

  console.log('\n=== PROGRAMME PAR ACTIF ===');
  for (const a of snapshot.assets) {
    console.log(`  ${a.mint}  program=${a.program}  amount=${a.amount}`);
  }

  // Reproduction du comportement d'avant : uniquement le programme SPL legacy,
  // et un actif non cote purement et simplement exclu de l'equity.
  let legacyEquity = snapshot.native.amount * solPrice;
  const invisible = [];
  for (const a of snapshot.assets) {
    const quote = prices.get(a.mint);
    const usd = quote && quote.price !== null ? a.amount * quote.price : 0;
    if (a.program === 'token-2022') {
      invisible.push({ mint: a.mint, usd });
      continue;
    }
    if (quote && quote.price !== null) legacyEquity += usd;
  }

  console.log('\n=== IMPACT DU BUG TOKEN-2022 ===');
  console.log(`  equity ancien pipeline  : $${legacyEquity.toFixed(6)}`);
  console.log(`  equity nouveau pipeline : $${valuation.equity.toFixed(6)}`);
  const ecart = (legacyEquity / valuation.equity - 1) * 100;
  console.log(`  ecart introduit         : ${ecart.toFixed(2)} %`);
  for (const i of invisible) console.log(`  invisible avant         : ${i.mint} = $${i.usd.toFixed(6)}`);

  console.log('\n=== POIDS DES COUTS FIXES SOLANA ===');
  const rentLamports = await connection.getMinimumBalanceForRentExemption(165);
  const rentSol = rentLamports / 1e9;
  const rentUsd = rentSol * solPrice;
  const swapFeeSol = 0.000005 + 0.0001; // frais de base + priorite typique
  console.log(`  prix SOL                      : $${solPrice.toFixed(2)}`);
  console.log(`  equity totale du wallet       : $${valuation.equity.toFixed(4)}`);
  console.log(`  rent d'un compte de token     : ${rentSol} SOL = $${rentUsd.toFixed(4)}`);
  console.log(`  -> soit                       : ${((rentUsd / valuation.equity) * 100).toFixed(2)} % du portefeuille`);
  console.log(`  frais d'un swap (${swapFeeSol} SOL) : $${(swapFeeSol * solPrice).toFixed(4)}`);
  console.log(`  -> soit                       : ${((swapFeeSol * solPrice / valuation.equity) * 100).toFixed(2)} % du portefeuille`);
  console.log(
    `  aller-retour (2 swaps + 1 compte) : ${(((2 * swapFeeSol * solPrice + rentUsd) / valuation.equity) * 100).toFixed(2)} % du portefeuille\n`
  );
})().catch((e) => {
  console.error('Echec :', e.message);
  process.exit(1);
});
