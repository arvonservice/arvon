// Classification des transactions d'un wallet, pour la verification de fin de
// match.
//
// Principe : ne JAMAIS deduire « la balance a bouge, donc c'est un trade ».
// Un swap echange quelque chose contre autre chose ; un depot fait entrer de la
// valeur sans rien faire sortir. C'est cette structure qu'on lit.
//
// Toutes les lectures passent par lib/rpc.js (appels bruts), car la version de
// @solana/web3.js installee ne sait pas lire les transactions de version 1.

const { rpcCall } = require('./rpc');
const { SOL_MINT, rawToAmount } = require('./wallet');

const TX_TYPE = {
  SWAP: 'SWAP',
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  FEE: 'FEE',
  PLATFORM: 'PLATFORM', // signee par Arvon (gains, remboursements) : jamais une triche
  UNKNOWN: 'UNKNOWN',
};

// Programmes d'echange connus. Sert a confirmer un swap ; la lecture
// structurelle reste la regle (un swap via un programme inconnu est classe
// UNKNOWN, jamais TRANSFER).
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
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', // Pump.fun frais
  'term9YPb9mzAsABaqN71A4xdbxHmpBNZavpBiQKZzN3', // Phantom Terminal
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', // Phoenix
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', // OpenBook
]);

const LAMPORTS = 1e9;
const EPS = 1e-9;
const MAX_TX_VERSION = Number(process.env.MAX_TX_VERSION ?? 1);
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

const keyOf = (k) => (k && k.pubkey ? k.pubkey.toString() : String(k));

function accountKeysOf(tx) {
  return (tx?.transaction?.message?.accountKeys || []).map(keyOf);
}

function signersOf(tx) {
  const set = new Set();
  for (const k of tx?.transaction?.message?.accountKeys || []) {
    if (k && k.signer) set.add(keyOf(k));
  }
  return set;
}

function allInstructions(tx) {
  const list = [...(tx?.transaction?.message?.instructions || [])];
  for (const inner of tx?.meta?.innerInstructions || []) list.push(...(inner.instructions || []));
  return list;
}

function signedAmount(raw, decimals) {
  const negative = raw < 0n;
  const amount = rawToAmount((negative ? -raw : raw).toString(), decimals);
  return negative ? -amount : amount;
}

// Comptes de token du joueur presents dans la transaction, avec leurs soldes
// avant/apres. Les soldes de token portent le proprietaire : c'est ce qui
// permet de voir un depot meme quand le wallet lui-meme n'est pas implique.
function walletTokenAccounts(tx, wallet) {
  const keys = accountKeysOf(tx);
  const map = new Map();
  const touch = (b, field) => {
    if (b.owner !== wallet) return;
    const entry = map.get(b.accountIndex) || {
      index: b.accountIndex,
      address: keys[b.accountIndex],
      mint: b.mint,
      decimals: b.uiTokenAmount?.decimals ?? 0,
      preRaw: 0n,
      postRaw: 0n,
    };
    entry[field] = BigInt(b.uiTokenAmount?.amount || '0');
    map.set(b.accountIndex, entry);
  };
  for (const b of tx?.meta?.preTokenBalances || []) touch(b, 'preRaw');
  for (const b of tx?.meta?.postTokenBalances || []) touch(b, 'postRaw');
  return map;
}

// Transferts entrants dont l'autorite est un AUTRE signataire de la
// transaction : un second wallet du joueur qui glisse des fonds a l'interieur
// d'un swap. Dans un vrai swap, les fonds viennent d'un pool dont l'autorite
// est un programme, jamais d'un signataire.
function findInjections(tx, wallet, accounts, signers) {
  const byAddress = new Map([...accounts.values()].map((a) => [a.address, a]));
  const out = [];
  for (const ix of allInstructions(tx)) {
    const parsed = ix.parsed;
    if (!parsed || typeof parsed !== 'object') continue;
    const info = parsed.info || {};
    const isToken = ix.program === 'spl-token' || ix.program === 'spl-token-2022';
    if (isToken && (parsed.type === 'transfer' || parsed.type === 'transferChecked')) {
      const acct = byAddress.get(info.destination);
      if (!acct) continue;
      const authority = info.authority || info.multisigAuthority;
      if (!authority || authority === wallet || !signers.has(authority)) continue;
      const raw = String(info.amount ?? info.tokenAmount?.amount ?? '0');
      out.push({
        kind: acct.mint === SOL_MINT ? 'sol' : 'token',
        mint: acct.mint,
        amount: rawToAmount(raw, acct.decimals),
        from: authority,
      });
    } else if (ix.program === 'system' && (parsed.type === 'transfer' || parsed.type === 'transferWithSeed')) {
      if (info.destination !== wallet) continue;
      const from = info.sourceBase || info.source;
      if (!from || from === wallet || !signers.has(from)) continue;
      out.push({ kind: 'sol', mint: SOL_MINT, amount: Number(info.lamports || 0) / LAMPORTS, from });
    }
  }
  return out;
}

// ignoredSources : adresses d'Arvon (wallet maison, commission). Une
// transaction qu'elles signent est un paiement de la plateforme.
function classify(tx, wallet, { ignoredSources = new Set() } = {}) {
  const meta = tx?.meta || {};
  const keys = accountKeysOf(tx);
  const signers = signersOf(tx);
  const walletSigned = signers.has(wallet);
  const lamportDelta = (i) => (meta.postBalances?.[i] ?? 0) - (meta.preBalances?.[i] ?? 0);

  // Les frais ne comptent comme depense du joueur que s'il les a payes.
  const fee = keys[0] === wallet ? (meta.fee || 0) / LAMPORTS : 0;
  const walletIndex = keys.indexOf(wallet);
  const nativeDelta = walletIndex >= 0 ? lamportDelta(walletIndex) / LAMPORTS : 0;

  const accounts = walletTokenAccounts(tx, wallet);
  let wrappedDelta = 0;
  let rentDelta = 0;
  const tokenDeltas = new Map();
  const rentGifts = [];
  for (const a of accounts.values()) {
    const rawDelta = a.postRaw - a.preRaw;
    const lamports = lamportDelta(a.index) / LAMPORTS;
    let rentPart = lamports;
    if (a.mint === SOL_MINT) {
      // Compte de SOL wrappe : ses lamports melangent caution et SOL wrappe.
      const wrapped = Number(rawDelta) / LAMPORTS;
      wrappedDelta += wrapped;
      rentPart = lamports - wrapped;
    } else if (rawDelta !== 0n) {
      tokenDeltas.set(a.mint, (tokenDeltas.get(a.mint) || 0) + signedAmount(rawDelta, a.decimals));
    }
    rentDelta += rentPart;
    // Caution payee par un tiers (typiquement : un spam qui ouvre un compte).
    if (!walletSigned && rentPart > EPS) {
      rentGifts.push({ address: a.address, mint: a.mint, amountSol: rentPart });
    }
  }

  const changes = [...tokenDeltas].map(([mint, amount]) => ({ mint, amount }));
  const gained = changes.filter((c) => c.amount > 0);
  const lost = changes.filter((c) => c.amount < 0);
  // Tout le SOL du joueur, quelle que soit sa forme (natif, wrappe, caution),
  // hors frais : ouvrir ou fermer un compte est neutre.
  const solSide = nativeDelta + fee + wrappedDelta + rentDelta;
  const solMoved = Math.abs(solSide) > EPS;

  const programs = new Set(allInstructions(tx).map((ix) => ix.programId).filter(Boolean).map(String));
  const usesDex = [...programs].some((p) => DEX_PROGRAM_IDS.has(p));
  const platform = [...signers].some((s) => ignoredSources.has(s));

  let type = TX_TYPE.UNKNOWN;
  if (platform) type = TX_TYPE.PLATFORM;
  else if (usesDex && (gained.length || lost.length || solMoved)) type = TX_TYPE.SWAP;
  else if (!gained.length && !lost.length && !solMoved) type = TX_TYPE.FEE;
  else if (gained.length && !lost.length && solSide >= -EPS) type = TX_TYPE.TRANSFER_IN;
  else if (lost.length && !gained.length && solSide <= EPS) type = TX_TYPE.TRANSFER_OUT;
  else if (!gained.length && !lost.length) type = solSide > 0 ? TX_TYPE.TRANSFER_IN : TX_TYPE.TRANSFER_OUT;

  // Ce qui est entre sans contrepartie. La caution n'en fait pas partie : elle
  // est traitee a part (rentGifts), car elle vient surtout des spams.
  const inflows = [];
  if (type === TX_TYPE.TRANSFER_IN || type === TX_TYPE.PLATFORM) {
    for (const g of gained) inflows.push({ kind: 'token', mint: g.mint, amount: g.amount });
    const solIn = nativeDelta + fee + wrappedDelta;
    if (solIn > EPS) inflows.push({ kind: 'sol', mint: SOL_MINT, amount: solIn });
  }
  const injections =
    type === TX_TYPE.TRANSFER_IN || type === TX_TYPE.PLATFORM ? [] : findInjections(tx, wallet, accounts, signers);

  return {
    signature: tx?.transaction?.signatures?.[0] || null,
    slot: tx?.slot ?? null,
    timestamp: tx?.blockTime ? tx.blockTime * 1000 : null,
    type,
    succeeded: !meta.err,
    walletSigned,
    fee,
    nativeDelta,
    wrappedDelta,
    rentDelta,
    solSide,
    tokenChanges: changes,
    inflows,
    injections,
    rentGifts,
    touchedAccounts: [...accounts.values()].map((a) => a.address).filter(Boolean),
    programs: [...programs],
  };
}

// Un RPC peut renvoyer deux fois la meme signature. Une transaction deja vue
// ne doit pas etre comptee deux fois.
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

function fetchTransaction(signature) {
  return rpcCall('getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' },
  ]);
}

// Signatures d'une adresse dans la fenetre ]fromSlot, toSlot], des plus
// recentes aux plus anciennes. truncated = on n'a pas pu remonter jusqu'au
// debut de la fenetre : la verification ne peut alors pas conclure.
async function signaturesInWindow(address, fromSlot, toSlot) {
  const out = [];
  let before;
  for (let page = 0; page < MAX_PAGES; page++) {
    const options = { limit: PAGE_SIZE, commitment: 'confirmed' };
    if (before) options.before = before;
    const batch = await rpcCall('getSignaturesForAddress', [address, options]);
    if (!batch || !batch.length) return { signatures: out, truncated: false };
    for (const s of batch) {
      if (s.slot <= fromSlot) return { signatures: out, truncated: false };
      if (s.slot <= toSlot) out.push({ signature: s.signature, slot: s.slot, failed: !!s.err });
    }
    if (batch.length < PAGE_SIZE) return { signatures: out, truncated: false };
    before = batch[batch.length - 1].signature;
  }
  return { signatures: out, truncated: true };
}

module.exports = {
  TX_TYPE,
  DEX_PROGRAM_IDS,
  classify,
  dedupeTransactions,
  fetchTransaction,
  signaturesInWindow,
};
