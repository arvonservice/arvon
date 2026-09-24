// Classification des transactions du wallet pendant un match.
//
// Objectif : ne JAMAIS deduire "la balance a bouge, donc c'est un trade".
// Une variation de balance peut venir d'un swap, d'un transfert, de frais,
// d'un airdrop, d'un wrap/unwrap SOL, d'un autre programme.
//
// Seuls TRANSFER_IN / TRANSFER_OUT sont des flux de capital externes a
// neutraliser. SWAP et FEE sont internes : leur effet doit rester dans la
// performance.

const { connection, SOL_MINT } = require('./wallet');

const TX_TYPE = {
  SWAP: 'SWAP',
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  FEE: 'FEE',
  UNKNOWN: 'UNKNOWN',
};

// Programmes d'echange connus. Une transaction qui en invoque un deplace de la
// valeur entre actifs du meme wallet : ce n'est pas un flux externe.
const DEX_PROGRAM_IDS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter v4
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // Jupiter limit
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS', // Raydium route
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca v2
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora Pools
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // Pump.fun AMM
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', // Phoenix
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', // OpenBook
]);

const MAX_SIGNATURES = 40;
const LAMPORTS = 1e9;

function collectProgramIds(tx) {
  const ids = new Set();
  const msg = tx?.transaction?.message;
  for (const ix of msg?.instructions || []) {
    if (ix.programId) ids.add(ix.programId.toString());
  }
  for (const inner of tx?.meta?.innerInstructions || []) {
    for (const ix of inner.instructions || []) {
      if (ix.programId) ids.add(ix.programId.toString());
    }
  }
  return ids;
}

function nativeDelta(tx, wallet) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const idx = keys.findIndex((k) => (k.pubkey ? k.pubkey.toString() : String(k)) === wallet);
  if (idx < 0) return 0;
  const pre = tx.meta?.preBalances?.[idx];
  const post = tx.meta?.postBalances?.[idx];
  if (pre === undefined || post === undefined) return 0;
  return (post - pre) / LAMPORTS;
}

function tokenDeltas(tx, wallet) {
  const deltas = new Map(); // mint -> delta en unites UI
  const read = (list, sign) => {
    for (const b of list || []) {
      if (b.owner !== wallet) continue;
      const amount = Number(b.uiTokenAmount?.uiAmountString ?? 0);
      deltas.set(b.mint, (deltas.get(b.mint) || 0) + sign * amount);
    }
  };
  read(tx.meta?.preTokenBalances, -1);
  read(tx.meta?.postTokenBalances, +1);
  for (const [mint, d] of deltas) {
    if (Math.abs(d) < 1e-12) deltas.delete(mint);
  }
  return deltas;
}

function classify(tx, wallet) {
  const fee = (tx.meta?.fee || 0) / LAMPORTS;
  const solDelta = nativeDelta(tx, wallet);
  const tokens = tokenDeltas(tx, wallet);
  const programs = collectProgramIds(tx);

  const movements = [...tokens.entries()].map(([mint, amount]) => ({ mint, amount }));
  const gained = movements.filter((m) => m.amount > 0);
  const lost = movements.filter((m) => m.amount < 0);

  // Le SOL natif compte comme un actif deplace, hors frais.
  const solMovement = solDelta + fee; // variation hors frais reseau
  const solMoved = Math.abs(solMovement) > 1e-9;

  const usesDex = [...programs].some((p) => DEX_PROGRAM_IDS.has(p));

  let type = TX_TYPE.UNKNOWN;
  if (usesDex && (gained.length || lost.length || solMoved)) {
    type = TX_TYPE.SWAP;
  } else if (!gained.length && !lost.length && !solMoved) {
    type = TX_TYPE.FEE;
  } else if (gained.length && !lost.length && solMovement >= -1e-9) {
    type = TX_TYPE.TRANSFER_IN;
  } else if (lost.length && !gained.length && solMovement <= 1e-9) {
    type = TX_TYPE.TRANSFER_OUT;
  } else if (!gained.length && !lost.length && solMoved) {
    type = solMovement > 0 ? TX_TYPE.TRANSFER_IN : TX_TYPE.TRANSFER_OUT;
  }

  const rawChanges = movements.slice();
  if (solMoved) rawChanges.push({ mint: SOL_MINT, amount: solMovement, native: true });

  return {
    signature: tx.transaction?.signatures?.[0] || null,
    slot: tx.slot ?? null,
    timestamp: tx.blockTime ? tx.blockTime * 1000 : null,
    type,
    fee,
    solDelta,
    rawChanges,
    programs: [...programs],
    succeeded: !tx.meta?.err,
  };
}

// Valorise un flux externe. Les SWAP et FEE renvoient 0 : ils ne sont pas des
// flux de capital, leur effet doit rester dans la performance.
function flowUsdValue(classified, priceMap) {
  if (classified.type !== TX_TYPE.TRANSFER_IN && classified.type !== TX_TYPE.TRANSFER_OUT) return 0;
  let usd = 0;
  let missing = false;
  for (const change of classified.rawChanges) {
    const quote = priceMap.get(change.mint);
    if (!quote || quote.price === null) {
      missing = true;
      continue;
    }
    usd += change.amount * quote.price;
  }
  return missing ? null : usd;
}

// Un RPC peut renvoyer deux fois la meme signature (reorg, fenetre glissante).
// Une transaction deja vue ne doit pas produire un second flux.
function dedupeTransactions(transactions, seenSignatures) {
  const out = [];
  for (const tx of transactions) {
    if (tx.signature) {
      if (seenSignatures.has(tx.signature)) continue;
      seenSignatures.add(tx.signature);
    }
    out.push(tx);
  }
  return out;
}

// Recupere et classe les transactions confirmees depuis `untilSignature`.
// Renvoie aussi la signature la plus recente pour le prochain appel.
async function fetchClassifiedTransactions(wallet, untilSignature) {
  const { PublicKey } = require('@solana/web3.js');
  const owner = new PublicKey(wallet);

  const options = { limit: MAX_SIGNATURES };
  if (untilSignature) options.until = untilSignature;

  const sigs = await connection.getSignaturesForAddress(owner, options);
  if (!sigs.length) return { transactions: [], newestSignature: untilSignature || null };

  const signatures = sigs.map((s) => s.signature);
  const parsed = await connection.getParsedTransactions(signatures, {
    maxSupportedTransactionVersion: 0,
  });

  const transactions = [];
  for (const tx of parsed) {
    if (!tx) continue;
    const classified = classify(tx, wallet);
    if (classified.succeeded) transactions.push(classified);
  }

  return { transactions, newestSignature: signatures[0] };
}

module.exports = {
  TX_TYPE,
  classify,
  flowUsdValue,
  dedupeTransactions,
  fetchClassifiedTransactions,
  DEX_PROGRAM_IDS,
};
