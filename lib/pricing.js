// Moteur de prix. Responsabilite unique : donner un prix USD par mint, avec un
// statut honnete. Ne connait rien des wallets ni des matchs.
//
// Regle absolue : un echec de source ne doit JAMAIS produire price = 0.
// Un actif sans prix est UNPRICED (price === null), jamais zero.

const PRICE_API = 'https://lite-api.jup.ag/price/v3';
const PRICE_BATCH_SIZE = 50;
const HTTP_TIMEOUT_MS = 5000;
const HTTP_ATTEMPTS = 3;

// Un prix est FRESH s'il a ete recupere il y a moins de ca.
const FRESH_MAX_AGE_MS = 6000;
// En dessous de cet age on ne redemande pas la source (evite de marteler l'API).
const REFETCH_INTERVAL_MS = 3000;

const STATUS = {
  FRESH: 'FRESH',
  STALE: 'STALE',
  UNPRICED: 'UNPRICED',
};

// mint -> { price: number|null, fetchedAt: number|null, lastAttemptAt: number }
// fetchedAt est l'instant du dernier prix REEL obtenu. Il n'est jamais avance
// lors d'un echec : c'est ce qui permet de connaitre le vrai age d'un prix.
const cache = new Map();

const stats = { requests: 0, batchOk: 0, batchFail: 0, resolved: 0, unresolved: 0 };

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchWithRetry(url) {
  let lastErr;
  for (let i = 0; i < HTTP_ATTEMPTS; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < HTTP_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  throw lastErr;
}

function classify(entry, now) {
  if (!entry || entry.price === null || entry.fetchedAt === null) {
    return { price: null, status: STATUS.UNPRICED, ageMs: null, fetchedAt: null };
  }
  const ageMs = now - entry.fetchedAt;
  return {
    price: entry.price,
    status: ageMs <= FRESH_MAX_AGE_MS ? STATUS.FRESH : STATUS.STALE,
    ageMs,
    fetchedAt: entry.fetchedAt,
  };
}

async function refreshBatch(batch, now) {
  const url = `${PRICE_API}?ids=${batch.join(',')}`;
  stats.requests++;
  try {
    const res = await fetchWithRetry(url);
    const data = await res.json();
    stats.batchOk++;
    for (const mint of batch) {
      const raw = data?.[mint]?.usdPrice;
      const price = raw === undefined || raw === null ? null : Number(raw);
      const prev = cache.get(mint);
      if (price !== null && Number.isFinite(price) && price > 0) {
        cache.set(mint, { price, fetchedAt: now, lastAttemptAt: now });
      } else {
        // La source ne cote pas ce mint. On conserve le dernier prix connu tel
        // quel (il vieillira en STALE), on ne le remplace surtout pas par 0.
        cache.set(mint, {
          price: prev ? prev.price : null,
          fetchedAt: prev ? prev.fetchedAt : null,
          lastAttemptAt: now,
        });
      }
    }
  } catch (e) {
    stats.batchFail++;
    // Panne reseau / timeout : on ne touche NI au prix NI a fetchedAt.
    // Les prix existants vieillissent naturellement vers STALE.
    for (const mint of batch) {
      const prev = cache.get(mint);
      cache.set(mint, {
        price: prev ? prev.price : null,
        fetchedAt: prev ? prev.fetchedAt : null,
        lastAttemptAt: now,
      });
    }
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

// Renvoie une Map mint -> { price, status, ageMs, fetchedAt }.
// price est null si et seulement si status === UNPRICED.
async function getPrices(mints) {
  const now = Date.now();
  const unique = [...new Set(mints)].filter(Boolean);
  const errors = [];

  const need = unique.filter((m) => {
    const entry = cache.get(m);
    if (!entry) return true;
    return now - entry.lastAttemptAt >= REFETCH_INTERVAL_MS;
  });

  if (need.length) {
    const results = await Promise.all(chunk(need, PRICE_BATCH_SIZE).map((b) => refreshBatch(b, Date.now())));
    for (const r of results) {
      if (!r.ok) errors.push({ component: 'pricing', error: r.error });
    }
  }

  const after = Date.now();
  const out = new Map();
  for (const m of unique) {
    const resolved = classify(cache.get(m), after);
    if (resolved.status === STATUS.UNPRICED) stats.unresolved++;
    else stats.resolved++;
    out.set(m, resolved);
  }
  return { prices: out, errors };
}

// Pour les tests : injecte un prix sans passer par le reseau.
function seedPrice(mint, price, fetchedAt = Date.now()) {
  cache.set(mint, { price, fetchedAt, lastAttemptAt: fetchedAt });
}

function clearCache() {
  cache.clear();
}

module.exports = { getPrices, seedPrice, clearCache, STATUS, FRESH_MAX_AGE_MS, stats };
