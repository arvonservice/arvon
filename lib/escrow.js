const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  transfer,
} = require('@solana/spl-token');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'escrow-config.json');
const DECIMALS = 6;
const UNIT = 10 ** DECIMALS;
const HOUSE_MIN_SOL_WARNING = 0.02 * 1e9; // en dessous, on previent l'operateur qu'il faut recharger en SOL reel

// Adresse officielle du jeton USDT sur Solana mainnet. A VERIFIER toi-meme
// (ex. sur https://solscan.io) avant de faire confiance a de l'argent reel.
// Redefinissable via la variable d'environnement USDT_MINT_ADDRESS.
const DEFAULT_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const ESCROW_RPC_URL = process.env.ESCROW_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(ESCROW_RPC_URL, 'confirmed');
const mintPubkey = new PublicKey(process.env.USDT_MINT_ADDRESS || DEFAULT_USDT_MINT);

let houseKeypair = null;
let feeWalletPubkey = null;
let ready = false;

function toUnits(dollars) {
  return BigInt(Math.round(dollars * UNIT));
}

function toDollars(units) {
  return Math.round((Number(units) / UNIT) * 100) / 100;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function saveConfig(config) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function checkHouseSol() {
  try {
    const bal = await connection.getBalance(houseKeypair.publicKey);
    if (bal < HOUSE_MIN_SOL_WARNING) {
      console.warn(
        `[escrow] ATTENTION : le wallet maison n'a presque plus de SOL pour payer les frais de transaction.\n` +
        `[escrow] Envoie un peu de SOL REEL (0.05-0.1 SOL suffit) a cette adresse : ${houseKeypair.publicKey.toBase58()}`
      );
    }
  } catch (e) {
    // pas bloquant, on continue
  }
}

async function init() {
  let config = loadConfig();

  if (!config || !config.houseSecretKey) {
    houseKeypair = Keypair.generate();
    saveConfig({ ...(config || {}), houseSecretKey: Array.from(houseKeypair.secretKey) });
    console.log(`[escrow] Nouveau wallet maison (MAINNET, argent reel) : ${houseKeypair.publicKey.toBase58()}`);
    console.log('[escrow] Ce wallet doit recevoir un peu de vrai SOL (0.05-0.1 SOL) pour payer les frais de transaction.');
  } else {
    houseKeypair = Keypair.fromSecretKey(Uint8Array.from(config.houseSecretKey));
  }

  feeWalletPubkey = config && config.feeWalletAddress ? new PublicKey(config.feeWalletAddress) : houseKeypair.publicKey;

  await checkHouseSol();

  ready = true;
  console.log(`[escrow] Pret (MAINNET). Wallet maison : ${houseKeypair.publicKey.toBase58()}`);
  console.log(`[escrow] Jeton USDT utilise : ${mintPubkey.toBase58()}`);
  console.log(`[escrow] Wallet de commission (15%) : ${feeWalletPubkey.toBase58()}${feeWalletPubkey.equals(houseKeypair.publicKey) ? ' (= wallet maison, non configure separement)' : ''}`);
}

function isReady() {
  return ready;
}

function assertReady() {
  if (!ready) throw new Error("Le systeme de mises n'est pas encore pret.");
}

async function getBalance(address) {
  assertReady();
  try {
    const pubkey = new PublicKey(address);
    const ata = await getAssociatedTokenAddress(mintPubkey, pubkey);
    const info = await getAccount(connection, ata);
    return toDollars(info.amount);
  } catch (e) {
    return 0;
  }
}

// Construit une transaction de depot : le joueur transfere `amountDollars` (USDT reel) vers le wallet maison.
// Le wallet maison est deja fee payer et a partiellement signe : le joueur n'a besoin d'aucun SOL.
async function buildDepositTransaction(userAddress, amountDollars) {
  assertReady();

  const userPubkey = new PublicKey(userAddress);
  const userAta = await getAssociatedTokenAddress(mintPubkey, userPubkey);
  const houseAta = await getAssociatedTokenAddress(mintPubkey, houseKeypair.publicKey);

  const tx = new Transaction();
  const userAtaInfo = await connection.getAccountInfo(userAta);
  if (!userAtaInfo) {
    tx.add(createAssociatedTokenAccountInstruction(houseKeypair.publicKey, userAta, userPubkey, mintPubkey));
  }
  tx.add(createTransferInstruction(userAta, houseAta, userPubkey, toUnits(amountDollars)));

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = houseKeypair.publicKey;
  tx.partialSign(houseKeypair);

  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}

// Soumet une transaction de depot signee par le joueur (en plus de la pre-signature maison).
async function submitSignedDeposit(signedBase64) {
  assertReady();
  const buf = Buffer.from(signedBase64, 'base64');
  const sig = await connection.sendRawTransaction(buf, { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

// Transfert depuis le wallet maison vers un joueur (remboursement, gains). Entierement signe par la maison (argent reel).
async function houseTransfer(toAddress, amountDollars) {
  assertReady();
  await checkHouseSol();

  const toPubkey = new PublicKey(toAddress);
  const toAtaAccount = await getOrCreateAssociatedTokenAccount(connection, houseKeypair, mintPubkey, toPubkey);
  const houseAtaAccount = await getOrCreateAssociatedTokenAccount(connection, houseKeypair, mintPubkey, houseKeypair.publicKey);

  const sig = await transfer(
    connection,
    houseKeypair,
    houseAtaAccount.address,
    toAtaAccount.address,
    houseKeypair,
    toUnits(amountDollars)
  );
  return sig;
}

// Transfert de la commission de la plateforme vers le wallet de commission configure (ou le wallet maison par defaut).
async function payFee(amountDollars) {
  if (feeWalletPubkey.equals(houseKeypair.publicKey)) return null; // deja dans le wallet maison, rien a transferer
  return houseTransfer(feeWalletPubkey.toBase58(), amountDollars);
}

function getHouseAddress() {
  return houseKeypair ? houseKeypair.publicKey.toBase58() : null;
}

function getFeeWalletAddress() {
  return feeWalletPubkey ? feeWalletPubkey.toBase58() : null;
}

function getMintAddress() {
  return mintPubkey.toBase58();
}

module.exports = {
  init,
  isReady,
  getBalance,
  buildDepositTransaction,
  submitSignedDeposit,
  houseTransfer,
  payFee,
  getHouseAddress,
  getFeeWalletAddress,
  getMintAddress,
  toUnits,
  toDollars,
};
