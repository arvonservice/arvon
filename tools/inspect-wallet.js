// Inspection d'un wallet reel avec le pipeline de production.
//   node tools/inspect-wallet.js <adresse>
//
// Affiche la decomposition complete de l'equity : montant, prix, statut du
// prix et valeur pour chaque actif. C'est l'outil a lancer quand un score
// affiche semble faux.

const { getWalletSnapshot, snapshotMints } = require('../lib/wallet');
const { getPrices } = require('../lib/pricing');
const { valueSnapshot } = require('../lib/performance');

const wallet = process.argv[2];
if (!wallet) {
  console.error('Usage: node tools/inspect-wallet.js <adresse-solana>');
  process.exit(1);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

(async () => {
  const started = Date.now();
  const snapshot = await getWalletSnapshot(wallet);
  const { prices, errors } = await getPrices(snapshotMints(snapshot));
  const v = valueSnapshot(snapshot, prices);

  console.log(`\nWallet   ${wallet}`);
  console.log(`Slot     ${snapshot.slot} (ecart entre lectures : ${snapshot.slotSpread} slots)`);
  console.log(`Latence  ${Date.now() - started} ms`);
  console.log(`Actifs   ${v.breakdown.length} (dont ${snapshot.assets.filter((a) => a.program === 'token-2022').length} Token-2022)\n`);

  console.log(pad('ACTIF', 46), pad('MONTANT', 20), pad('PRIX', 16), pad('STATUT', 9), pad('SRC', 14), 'VALEUR USD');
  console.log('-'.repeat(130));
  const rows = v.breakdown.slice().sort((a, b) => (b.value || 0) - (a.value || 0));
  for (const b of rows) {
    console.log(
      pad(b.label || b.mint, 46),
      pad(b.amount, 20),
      pad(b.price === null ? 'NON COTE' : b.price, 16),
      pad(b.priceStatus, 9),
      pad(b.priceSource, 14),
      b.value === null ? '—' : b.value.toFixed(6)
    );
  }
  console.log('-'.repeat(130));
  console.log(`${pad('EQUITY TOTALE', 46)} ${pad('', 20)} ${pad('', 16)} ${pad('', 9)} ${pad('', 14)} ${v.equity.toFixed(6)}`);
  console.log(`\nCouverture de prix : ${(v.coverage * 100).toFixed(1)}%`);

  if (v.unpricedAssets.length) {
    console.log(`\nACTIFS NON COTES (exclus de l'equity, donc equity sous-evaluee) :`);
    for (const u of v.unpricedAssets) console.log(`  ${u.mint}  montant=${u.amount}`);
  }
  if (errors.length) console.log(`\nErreurs de prix :`, errors);
  if (snapshot.errors.length) console.log(`Erreurs wallet :`, snapshot.errors);
  console.log('');
})().catch((e) => {
  console.error('Echec :', e.message);
  process.exit(1);
});
