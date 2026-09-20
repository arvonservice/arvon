// Configure l'adresse Solana qui recevra la commission de la plateforme (15% par match Cash).
// Sans ce script, la commission reste simplement dans le wallet maison.
//
// Usage : node set_fee_wallet.js TON_ADRESSE_SOLANA

const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');

const address = process.argv[2];
const configPath = path.join(__dirname, 'data', 'escrow-config.json');

if (!address) {
  console.error('Usage : node set_fee_wallet.js TON_ADRESSE_SOLANA');
  process.exit(1);
}

try {
  new PublicKey(address);
} catch (e) {
  console.error("Cette adresse ne ressemble pas a une adresse Solana valide.");
  process.exit(1);
}

if (!fs.existsSync(configPath)) {
  console.error("Le fichier data/escrow-config.json n'existe pas encore. Lance d'abord le serveur une fois (npm start), puis relance ce script.");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
config.feeWalletAddress = address;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

console.log(`Wallet de commission configure : ${address}`);
console.log('Redemarre le serveur (Ctrl+C puis npm start) pour que ca prenne effet.');
