// Facade de compatibilite. La logique reelle vit desormais dans :
//   wallet.js      -> lecture des balances (SPL Token + Token-2022)
//   pricing.js     -> prix USD avec statut FRESH / STALE / UNPRICED
//   performance.js -> valorisation et calcul de performance (source de verite)
//   playertracker.js -> orchestration par joueur
//
// Ce fichier ne contient volontairement aucun calcul : il n'existe qu'un seul
// endroit ou la performance est calculee.

const { getWalletSnapshot, snapshotMints, SOL_MINT } = require('./wallet');
const { getPrices } = require('./pricing');
const { valueSnapshot } = require('./performance');

// Valeur totale du portefeuille en USD, prix du moment.
async function getPortfolioValue(pubkeyStr) {
  const snapshot = await getWalletSnapshot(pubkeyStr);
  const { prices } = await getPrices(snapshotMints(snapshot));
  return valueSnapshot(snapshot, prices).equity;
}

// Snapshot deja valorise (quantites + prix + decomposition par actif).
async function getValuedSnapshot(pubkeyStr) {
  const snapshot = await getWalletSnapshot(pubkeyStr);
  const { prices } = await getPrices(snapshotMints(snapshot));
  return valueSnapshot(snapshot, prices);
}

module.exports = { getPortfolioValue, getValuedSnapshot, getWalletSnapshot, SOL_MINT };
