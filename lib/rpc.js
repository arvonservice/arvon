// Appels JSON-RPC bruts vers Solana.
//
// Deux raisons de ne pas passer par @solana/web3.js ici :
//  - la version installee (1.95.3) ne sait pas deserialiser les transactions de
//    version 1 que le reseau emet desormais : elle plante sur une reponse que le
//    RPC renvoie pourtant correctement ;
//  - le RPC public renvoie des 429 des qu'on enchaine les requetes. Toutes les
//    requetes passent donc par un limiteur de debit global, avec reprise.

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const MAX_RPS = Number(process.env.RPC_MAX_RPS) || 6;
const TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reservation de creneaux : chaque appel prend le prochain creneau libre. La
// mise a jour est synchrone, donc des appels concurrents ne se chevauchent pas.
let nextSlotAt = 0;
async function throttle() {
  const interval = 1000 / MAX_RPS;
  const now = Date.now();
  const startAt = Math.max(now, nextSlotAt);
  nextSlotAt = startAt + interval;
  if (startAt > now) await sleep(startAt - now);
}

function backoff(attempt) {
  return Math.min(5000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);
}

class RpcError extends Error {
  constructor(error) {
    super(`RPC ${error.code}: ${error.message}`);
    this.code = error.code;
    this.retryable = false;
  }
}

const isRateLimit = (code, message) => code === 429 || /too many requests/i.test(message || '');

async function rpcCall(method, params) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await throttle();
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else if (!res.ok) {
        throw new RpcError({ code: res.status, message: `HTTP ${res.status}` });
      } else {
        const body = await res.json();
        if (!body.error) return body.result;
        if (!isRateLimit(body.error.code, body.error.message)) throw new RpcError(body.error);
        lastErr = new Error(body.error.message);
      }
    } catch (e) {
      if (e instanceof RpcError) throw e;
      lastErr = e;
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(backoff(attempt));
  }
  throw lastErr;
}

module.exports = { rpcCall, RpcError, RPC_URL };
