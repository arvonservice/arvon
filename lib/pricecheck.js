// Contre-verification des prix via DexScreener (source independante, sans cle).
//
// Jupiter agrege des routes ; DexScreener lit directement les pools. Sur un
// memecoin peu liquide les deux peuvent diverger de plusieurs ordres de
// grandeur. Quand c'est le cas, on veut le savoir et trancher explicitement
// plutot que de faire confiance a une seule source.

const API = 'https://api.dexscreener.com/latest/dex/tokens';

// L'API plafonne sa reponse a 30 paires pour TOUTE la requete. Un actif tres
// apparie (SOL, USDC) consomme la totalite du quota et evince les memecoins,
// qui sont justement ceux qu'on veut verifier. On isole donc les majeurs et on
// garde de petits lots pour le reste.
const MAJOR_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
const BATCH_SIZE = 3;
const TIMEOUT_MS = 6000;
const REFETCH_INTERVAL_MS = Number(process.env.PRICECHECK_INTERVAL_MS) || 10000;

// En dessous de ce niveau de liquidite, le prix d'un pool n'est pas fiable :
// on l'enregistre pour le diagnostic mais on ne s'en sert pas pour arbitrer.
const MIN_LIQUIDITY_USD = Number(process.env.PRICECHECK_MIN_LIQUIDITY) || 1000;

// Ecart relatif au-dela duquel on considere que les deux sources ne parlent
// pas du meme actif et qu'il faut trancher.
const DIVERGENCE_THRESHOLD = Number(process.env.PRICECHECK_THRESHOLD) || 0.1;

const cache = new Map(); // mint -> { price, liquidityUsd, dex, symbol, fetchedAt, lastAttemptAt }

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// DexScreener renvoie toutes les paires ou le mint apparait, y compris comme
// jeton de cotation. On ne garde que celles ou il est le jeton de base, et
// parmi elles la plus liquide : c'est le prix le moins manipulable.
function bestPairByMint(pairs, requested) {
  const wanted = new Set(requested);
  const best = new Map();
  for (const p of pairs || []) {
    const mint = p?.baseToken?.address;
    if (!mint || !wanted.has(mint)) continue;
    const price = Number(p.priceUsd);
    if (!Number.isFinite(price) || price <= 0) continue;
    const liquidityUsd = Number(p.liquidity?.usd) || 0;
    const current = best.get(mint);
    if (!current || liquidityUsd > current.liquidityUsd) {
      best.set(mint, { price, liquidityUsd, dex: p.dexId, symbol: p.baseToken.symbol });
    }
  }
  return best;
}

async function queryPairs(mints) {
  const res = await fetch(`${API}/${mints.join(',')}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return bestPairByMint(data.pairs, mints);
}

// Un mint absent de la reponse groupee peut avoir ete evince par un voisin trop
// apparie. On le redemande seul avant de conclure qu'il n'a pas de pool.
async function refreshBatch(batch, now) {
  const best = await queryPairs(batch);
  const missing = batch.filter((m) => !best.has(m));

  if (missing.length && batch.length > 1) {
    const retries = await Promise.all(
      missing.map((m) => queryPairs([m]).catch(() => new Map()))
    );
    for (const r of retries) for (const [mint, v] of r) best.set(mint, v);
  }

  for (const mint of batch) {
    const found = best.get(mint);
    const prev = cache.get(mint);
    if (found) {
      cache.set(mint, { ...found, fetchedAt: now, lastAttemptAt: now });
    } else {
      // Aucune paire : ce n'est pas une erreur, beaucoup de mints n'ont pas de
      // pool reference. On conserve ce qu'on avait.
      cache.set(mint, { ...(prev || { price: null, liquidityUsd: 0 }), lastAttemptAt: now });
    }
  }
}

// Renvoie une Map mint -> { price, liquidityUsd, dex, symbol } pour les mints
// connus de DexScreener. Ne leve jamais : une panne de la contre-verification
// ne doit pas empecher un match de se jouer.
async function crossCheckPrices(mints) {
  const now = Date.now();
  const unique = [...new Set(mints)].filter(Boolean);
  const errors = [];

  const need = unique.filter((m) => {
    const e = cache.get(m);
    return !e || now - e.lastAttemptAt >= REFETCH_INTERVAL_MS;
  });

  if (need.length) {
    // Les majeurs partent seuls, le reste en petits lots.
    const groups = [
      ...need.filter((m) => MAJOR_MINTS.has(m)).map((m) => [m]),
      ...chunk(need.filter((m) => !MAJOR_MINTS.has(m)), BATCH_SIZE),
    ];
    await Promise.all(
      groups.map((b) =>
        refreshBatch(b, Date.now()).catch((e) => {
          errors.push({ component: 'pricecheck', error: e.message });
          for (const mint of b) {
            const prev = cache.get(mint);
            cache.set(mint, { ...(prev || { price: null, liquidityUsd: 0 }), lastAttemptAt: Date.now() });
          }
        })
      )
    );
  }

  const out = new Map();
  for (const m of unique) {
    const e = cache.get(m);
    if (e && e.price) out.set(m, e);
  }
  return { reference: out, errors };
}

// Compare un prix primaire a la reference et decide lequel retenir.
// L'arbitrage n'a lieu que si la reference est adossee a une liquidite reelle.
function arbitrate(mint, primaryPrice, reference) {
  const ref = reference.get(mint);
  if (!ref || !ref.price) return null;

  const trusted = ref.liquidityUsd >= MIN_LIQUIDITY_USD;
  if (primaryPrice === null || primaryPrice === undefined) {
    // Jupiter ne cote pas : DexScreener sauve l'actif d'un statut UNPRICED.
    return trusted
      ? { price: ref.price, source: 'dexscreener', reason: 'primaire absent', reference: ref, divergence: null }
      : null;
  }

  const divergence = Math.abs(ref.price - primaryPrice) / primaryPrice;
  if (divergence <= DIVERGENCE_THRESHOLD) {
    return { price: primaryPrice, source: 'jupiter', reason: 'sources concordantes', reference: ref, divergence };
  }
  if (!trusted) {
    return {
      price: primaryPrice,
      source: 'jupiter',
      reason: 'divergence ignoree : liquidite de reference insuffisante',
      reference: ref,
      divergence,
    };
  }
  // Divergence reelle entre deux sources liquides : la reference l'emporte.
  return { price: ref.price, source: 'dexscreener', reason: 'divergence arbitree', reference: ref, divergence };
}

function clearCache() {
  cache.clear();
}

module.exports = {
  crossCheckPrices,
  arbitrate,
  bestPairByMint,
  clearCache,
  MIN_LIQUIDITY_USD,
  DIVERGENCE_THRESHOLD,
};
