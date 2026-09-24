// Lecture des balances on-chain. Aucune notion de prix ici : un snapshot de
// wallet decrit des QUANTITES, pas une valeur. La valorisation est faite
// separement par performance.js (cf. separation prix / balances).

const { Connection, PublicKey } = require('@solana/web3.js');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// Les deux programmes de tokens coexistent sur mainnet. Ne lire que le premier
// rend invisibles toutes les positions Token-2022 : leur valeur disparait de
// l'equity et le joueur encaisse une perte fantome.
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const NATIVE_DECIMALS = 9;

const RPC_ATTEMPTS = 3;
const RPC_TIMEOUT_MS = 8000;

async function withRetry(label, fn) {
  let lastErr;
  for (let i = 0; i < RPC_ATTEMPTS; i++) {
    try {
      return await Promise.race([
        fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), RPC_TIMEOUT_MS)),
      ]);
    } catch (e) {
      lastErr = e;
      if (i < RPC_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}

// Convertit un entier brut (string) + decimales en nombre, sans passer par
// 10**decimals : une seule conversion, donc un seul arrondi.
function rawToAmount(raw, decimals) {
  const s = String(raw);
  if (!decimals) return Number(s);
  const padded = s.padStart(decimals + 1, '0');
  const int = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  return Number(`${int}.${frac}`);
}

function collectAccounts(response, programLabel, into, errors, rent) {
  for (const { account } of response.value) {
    try {
      // Les lamports immobilises dans un compte de token (rent-exempt) sortent
      // du solde natif alors qu'ils appartiennent toujours au joueur et sont
      // recuperables a la fermeture du compte. Les ignorer fait apparaitre
      // l'ouverture d'une position comme une perte seche.
      rent.lamports += account.lamports || 0;
      rent.accounts += 1;

      const info = account.data.parsed.info;
      const mint = info.mint;
      const decimals = info.tokenAmount.decimals;
      const raw = info.tokenAmount.amount; // entier brut, source de verite
      if (!raw || raw === '0') continue;

      const existing = into.get(mint);
      if (existing) {
        // Plusieurs comptes pour le meme mint : on additionne en brut.
        existing.raw = (BigInt(existing.raw) + BigInt(raw)).toString();
        existing.amount = rawToAmount(existing.raw, decimals);
        existing.accounts += 1;
      } else {
        into.set(mint, {
          mint,
          raw: String(raw),
          decimals,
          amount: rawToAmount(raw, decimals),
          program: programLabel,
          accounts: 1,
        });
      }
    } catch (e) {
      errors.push({ component: 'wallet.parseTokenAccount', error: e.message });
    }
  }
}

// Photo des quantites detenues. Immuable une fois renvoyee.
async function getWalletSnapshot(walletAddress) {
  const owner = new PublicKey(walletAddress);
  const errors = [];

  const [solRes, legacyRes, t2022Res] = await Promise.all([
    withRetry('getBalance', () => connection.getBalanceAndContext(owner)),
    withRetry('getTokenAccounts(legacy)', () =>
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })
    ),
    withRetry('getTokenAccounts(token2022)', () =>
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })
    ).catch((e) => {
      // Certains RPC publics refusent ce programId. On degrade proprement au
      // lieu de faire echouer tout le snapshot.
      errors.push({ component: 'wallet.token2022', error: e.message });
      return { context: { slot: null }, value: [] };
    }),
  ]);

  const tokenMap = new Map();
  const rent = { lamports: 0, accounts: 0 };
  collectAccounts(legacyRes, 'spl-token', tokenMap, errors, rent);
  collectAccounts(t2022Res, 'token-2022', tokenMap, errors, rent);

  const slots = {
    sol: solRes.context.slot,
    legacy: legacyRes.context.slot,
    token2022: t2022Res.context.slot,
  };
  const known = [slots.sol, slots.legacy, slots.token2022].filter((s) => typeof s === 'number');
  const slot = known.length ? Math.max(...known) : null;
  const slotSpread = known.length ? Math.max(...known) - Math.min(...known) : 0;
  if (slotSpread > 10) {
    errors.push({ component: 'wallet.slotSpread', error: `balances lues a ${slotSpread} slots d'ecart` });
  }

  return Object.freeze({
    wallet: walletAddress,
    timestamp: Date.now(),
    slot,
    slots,
    slotSpread,
    native: {
      lamports: solRes.value,
      amount: rawToAmount(String(solRes.value), NATIVE_DECIMALS),
    },
    // SOL immobilise en rent dans les comptes de token : appartient au joueur,
    // recuperable, donc compte dans l'equity.
    rent: {
      lamports: rent.lamports,
      amount: rawToAmount(String(rent.lamports), NATIVE_DECIMALS),
      accounts: rent.accounts,
    },
    assets: [...tokenMap.values()],
    errors,
  });
}

// Liste des mints a coter pour ce snapshot (SOL natif inclus via son mint wrappe).
function snapshotMints(snapshot) {
  return [SOL_MINT, ...snapshot.assets.map((a) => a.mint)];
}

module.exports = {
  connection,
  getWalletSnapshot,
  snapshotMints,
  rawToAmount,
  SOL_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
};
