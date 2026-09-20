const { Connection, PublicKey } = require('@solana/web3.js');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
// L'ancien endpoint /price/v2 a ete retire par Jupiter (renvoie "Route not found"),
// ce qui faisait echouer TOUTES les estimations de prix silencieusement et rabattait
// systematiquement les wallets reels sur le mode simule. /price/v3 est l'endpoint actuel.
const PRICE_API = 'https://lite-api.jup.ag/price/v3';
const PRICE_TTL_MS = 3000;

const priceCache = new Map(); // mint -> { price, ts }

async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  throw lastErr;
}

const PRICE_BATCH_SIZE = 50;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getPrices(mints) {
  const now = Date.now();
  const uniqueMints = [...new Set(mints)];
  const need = uniqueMints.filter((m) => {
    const cached = priceCache.get(m);
    return !cached || now - cached.ts > PRICE_TTL_MS;
  });

  if (need.length) {
    // Un wallet actif peut detenir des dizaines de tokens (poussieres de memecoins
    // incluses) : une seule requete avec trop d'ids peut echouer (URL trop longue),
    // ce qui faisait alors retomber TOUS les prix a 0 (SOL inclus). On decoupe donc
    // en petits lots independants.
    await Promise.all(
      chunk(need, PRICE_BATCH_SIZE).map(async (batch) => {
        try {
          const url = `${PRICE_API}?ids=${batch.join(',')}`;
          const res = await fetchWithRetry(url);
          const data = await res.json();
          for (const mint of batch) {
            const price = data?.[mint]?.usdPrice;
            priceCache.set(mint, { price: price ? Number(price) : 0, ts: now });
          }
        } catch (e) {
          for (const mint of batch) if (!priceCache.has(mint)) priceCache.set(mint, { price: 0, ts: now });
        }
      })
    );
  }

  const out = {};
  for (const m of uniqueMints) out[m] = priceCache.get(m)?.price || 0;
  return out;
}

async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}

// Valeur totale du portefeuille (SOL + tokens SPL) en USD
async function getPortfolioValue(pubkeyStr) {
  const snap = await getWalletSnapshot(pubkeyStr);
  return snapshotTotal(snap);
}

// Photo complete du wallet (montants + prix du moment) : sert de reference pour
// isoler la performance de TRADING pure (voir frozenValueRelativeTo ci-dessous).
async function getWalletSnapshot(pubkeyStr) {
  const owner = new PublicKey(pubkeyStr);

  // Le RPC mainnet public est frequemment limite en debit (rate-limit) :
  // on retente quelques fois avant d'abandonner et de retomber en simule.
  const [lamports, tokenAccounts] = await Promise.all([
    withRetry(() => connection.getBalance(owner)),
    withRetry(() => connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })),
  ]);

  const solAmount = lamports / 1e9;
  const tokens = {};
  for (const { account } of tokenAccounts.value) {
    const info = account.data.parsed.info;
    const amount = info.tokenAmount.uiAmount;
    if (amount && amount > 0) tokens[info.mint] = (tokens[info.mint] || 0) + amount;
  }

  const mints = [SOL_MINT, ...Object.keys(tokens)];
  const prices = await getPrices(mints);

  return { solAmount, tokens, prices };
}

function snapshotTotal(snap) {
  let total = snap.solAmount * (snap.prices[SOL_MINT] || 0);
  for (const mint of Object.keys(snap.tokens)) total += snap.tokens[mint] * (snap.prices[mint] || 0);
  return total;
}

// Le solde SOL bouge un peu meme sans trade (frais de reseau sur d'autres actions) :
// on tolere une poussiere de variation avant de considerer que la position a change.
// Les frais reels peuvent aller jusqu'a 0.01 SOL+, donc on ignore les changements jusqu'a 0.05 SOL
const SOL_DUST_EPSILON = 0.05;

// Valeur du wallet en "figeant" le prix des positions qu'on detient encore exactement
// comme a la baseline (donc leur mouvement de marche ne compte pas), et en ne comptant
// au prix courant que les positions reellement modifiees depuis (achat/vente pendant
// le match). Resultat : si le joueur n'a rien trade, le pourcentage reste a 0% pile,
// peu importe si le marche a bouge sur ce qu'il detenait deja avant le match.
function frozenValueRelativeTo(baseline, current) {
  let total = Math.abs(current.solAmount - baseline.solAmount) <= SOL_DUST_EPSILON
    ? baseline.solAmount * (baseline.prices[SOL_MINT] || 0)
    : current.solAmount * (current.prices[SOL_MINT] || 0);

  const allMints = new Set([...Object.keys(baseline.tokens), ...Object.keys(current.tokens)]);
  for (const mint of allMints) {
    const baseAmt = baseline.tokens[mint] || 0;
    const curAmt = current.tokens[mint] || 0;
    if (baseAmt === curAmt) {
      total += baseAmt * (baseline.prices[mint] || 0);
    } else {
      total += curAmt * (current.prices[mint] || 0);
    }
  }
  return total;
}

module.exports = { getPortfolioValue, getWalletSnapshot, snapshotTotal, frozenValueRelativeTo, SOL_MINT };
