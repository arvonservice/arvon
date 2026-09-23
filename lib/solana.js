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
    console.log(`[prices] Fetching ${need.length} token prices in ${Math.ceil(need.length / PRICE_BATCH_SIZE)} batch(es)`);
    await Promise.all(
      chunk(need, PRICE_BATCH_SIZE).map(async (batch) => {
        try {
          const url = `${PRICE_API}?ids=${batch.join(',')}`;
          const res = await fetchWithRetry(url);
          const data = await res.json();
          let validCount = 0;
          for (const mint of batch) {
            const price = data?.[mint]?.usdPrice;
            if (price !== undefined && price !== null) {
              priceCache.set(mint, { price: Number(price), ts: now, status: 'valid' });
              validCount++;
            } else {
              // Jupiter returned no price: keep existing if available, otherwise mark as unpriced
              if (!priceCache.has(mint)) {
                priceCache.set(mint, { price: null, ts: now, status: 'unpriced' });
              }
            }
          }
          console.log(`[prices] Batch succeeded: ${validCount}/${batch.length} prices from Jupiter`);
        } catch (e) {
          // API failure: keep existing prices (don't zero them out)
          console.warn(`[prices] Batch failed (${e.message}), falling back to stale prices`);
          for (const mint of batch) {
            const existing = priceCache.get(mint);
            if (existing && existing.price !== null) {
              // Keep existing valid price, mark as stale
              priceCache.set(mint, { ...existing, ts: now, status: 'stale' });
            } else if (!priceCache.has(mint)) {
              // No previous price available: mark as unpriced
              priceCache.set(mint, { price: null, ts: now, status: 'unpriced' });
            }
          }
        }
      })
    );
  }

  const out = {};
  const unpricedMints = [];
  for (const m of uniqueMints) {
    const cached = priceCache.get(m);
    if (cached) {
      if (cached.price !== null) {
        out[m] = cached.price;
      } else {
        out[m] = null; // Explicitly mark as unpriced (not 0)
        unpricedMints.push(m);
      }
    } else {
      out[m] = null;
      unpricedMints.push(m);
    }
  }

  return { prices: out, unpricedMints };
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

// Photo complete du wallet (montants + prix du moment)
// Formule de performance: performancePct = ((currentEquity - initialEquity) / initialEquity) * 100
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
  const priceResult = await getPrices(mints);
  const prices = priceResult.prices;
  const unpricedMints = priceResult.unpricedMints;

  return { solAmount, tokens, prices, unpricedMints, timestamp: Date.now() };
}

function snapshotTotal(snap) {
  let total = 0;
  const hasUnpriced = snap.unpricedMints && snap.unpricedMints.length > 0;

  // SOL: use price, or 0 if unavailable (but don't silently fail)
  const solPrice = snap.prices[SOL_MINT];
  if (solPrice !== null && solPrice !== undefined) {
    total += snap.solAmount * solPrice;
  } else if (solPrice === null) {
    console.warn('[snapshotTotal] SOL price unavailable, treating as unpriced');
  }

  // Tokens: use price if available
  for (const mint of Object.keys(snap.tokens)) {
    const price = snap.prices[mint];
    if (price !== null && price !== undefined) {
      total += snap.tokens[mint] * price;
    } else if (price === null) {
      console.warn(`[snapshotTotal] Token ${mint} has no price, excluding from total`);
    }
  }

  return total;
}

module.exports = { getPortfolioValue, getWalletSnapshot, snapshotTotal, SOL_MINT };
