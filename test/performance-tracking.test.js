// Tests du pipeline de performance et de la verification anti-triche.
// Aucun acces reseau : snapshots, prix et transactions sont synthetiques.

const assert = require('assert');
const { MatchPerformance, assessEligibility, round2 } = require('../lib/performance');
const { STATUS } = require('../lib/pricing');
const { SOL_MINT, USDT_MINT, rentLamportsOf } = require('../lib/wallet');
const { classify, dedupeTransactions, TX_TYPE } = require('../lib/txclassify');
const { verifyWallet, VERDICT } = require('../lib/verification');
const { settleTeamMatch, settleBrMatch } = require('../lib/settlement');
const { PlayerTracker, eligibilityMessage } = require('../lib/playertracker');
const { arbitrate, bestPairByMint } = require('../lib/pricecheck');

const W = 'WALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const ALT = 'ALTWALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const HOUSE = 'HOUSExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const TOK_A = 'TOKENAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const TOK_D = 'DUSTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const SPAM = 'SPAMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const FRESH = 'FRESHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const TERMINAL = 'term9YPb9mzAsABaqN71A4xdbxHmpBNZavpBiQKZzN3';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

let slot = 1000;

// Snapshot de wallet. accounts : comptes de token (adresse, mint, caution).
function snap({ sol, tokens = [], accounts = [] }) {
  slot += 10;
  return {
    wallet: W,
    timestamp: slot * 1000,
    slot,
    native: { lamports: Math.round(sol * 1e9), amount: sol },
    assets: tokens.map((t) => ({ mint: t.mint, raw: '0', decimals: 6, amount: t.amount, program: 'spl-token', accounts: 1 })),
    tokenAccounts: accounts.map((a) => ({
      address: a.address,
      mint: a.mint,
      raw: '0',
      decimals: 6,
      rentLamports: a.rentLamports ?? 2000000,
      program: 'spl-token',
    })),
    errors: [],
  };
}

// Prix en USD, comme les renvoie pricing.js. null = non cote.
function usd(spec) {
  const m = new Map();
  for (const [mint, v] of Object.entries(spec)) {
    if (v === null) m.set(mint, { price: null, status: STATUS.UNPRICED });
    else if (typeof v === 'object') m.set(mint, v);
    else m.set(mint, { price: v, status: STATUS.FRESH });
  }
  return m;
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ===========================================================================
// Modele de performance
// ===========================================================================

test('Ne rien faire = 0 %, meme si le SOL prend 30 %', () => {
  const perf = new MatchPerformance(snap({ sol: 1 }), usd({ [SOL_MINT]: 100 }));
  const r = perf.update(snap({ sol: 1 }), usd({ [SOL_MINT]: 130 }));
  assert.strictEqual(r.pnlPct, 0);
});

test('Acheter un token puis le voir doubler = +50 % sur un capital a moitie investi', () => {
  const perf = new MatchPerformance(snap({ sol: 1 }), usd({ [SOL_MINT]: 100 }));
  const acc = [{ address: 'ATA_A', mint: TOK_A, rentLamports: 2000000 }];
  const p = usd({ [SOL_MINT]: 100, [TOK_A]: 0.1 }); // 0,001 SOL
  const buy = perf.update(snap({ sol: 0.498, tokens: [{ mint: TOK_A, amount: 500 }], accounts: acc }), p);
  assert.strictEqual(buy.pnlPct, 0, "ouvrir la position (caution comprise) n'est pas une perte");
  const up = perf.update(
    snap({ sol: 0.498, tokens: [{ mint: TOK_A, amount: 500 }], accounts: acc }),
    usd({ [SOL_MINT]: 100, [TOK_A]: 0.2 })
  );
  assert.strictEqual(up.pnlPct, 50);
});

test('Ton match reel : -61,1 % et non -8 %', () => {
  const perf = new MatchPerformance(snap({ sol: 0.005866 }), usd({ [SOL_MINT]: 117 }));
  // Achat puis revente : le token est parti, son compte vide reste avec sa caution.
  const end = snap({ sol: 0.000768, accounts: [{ address: 'ATA_TRADE', mint: TOK_A, rentLamports: 1513840 }] });
  const r = perf.update(end, usd({ [SOL_MINT]: 117, [TOK_A]: 0.00001 }));
  assert.strictEqual(r.pnlPct, -61.1);
});

test('Spam : un inconnu ouvre un compte et envoie un token sans prix -> aucun effet', () => {
  const perf = new MatchPerformance(snap({ sol: 1 }), usd({ [SOL_MINT]: 100 }));
  const r = perf.update(
    snap({ sol: 1, tokens: [{ mint: SPAM, amount: 1e9 }], accounts: [{ address: 'ATA_SPAM', mint: SPAM }] }),
    usd({ [SOL_MINT]: 100, [SPAM]: null })
  );
  assert.strictEqual(r.pnlPct, 0, 'ni le token ni la caution offerte ne doivent compter');
  assert.strictEqual(r.alert, null, 'un spam ne doit pas declencher d alerte');
});

test('Fermer ses vieux comptes puis trader : pas d effet de levier', () => {
  const old = Array.from({ length: 19 }, (_, i) => ({ address: `OLD_${i}`, mint: `DEAD_${i}`, rentLamports: 1750000 }));
  const perf = new MatchPerformance(snap({ sol: 0.006, accounts: old }), usd({ [SOL_MINT]: 100 }));
  assert.strictEqual(perf.capitalSol, 0.006, 'la caution morte ne fait pas partie du capital');

  const closed = perf.update(snap({ sol: 0.03925 }), usd({ [SOL_MINT]: 100 }));
  assert.strictEqual(closed.pnlPct, 0, 'recuperer ses cautions n est pas un gain');

  const acc = [{ address: 'ATA_A', mint: TOK_A }];
  perf.update(snap({ sol: 0.00725, tokens: [{ mint: TOK_A, amount: 30 }], accounts: acc }), usd({ [SOL_MINT]: 100, [TOK_A]: 0.1 }));
  const up = perf.update(
    snap({ sol: 0.00725, tokens: [{ mint: TOK_A, amount: 30 }], accounts: acc }),
    usd({ [SOL_MINT]: 100, [TOK_A]: 0.11 })
  );
  // +10 % sur 0,03 SOL investis, rapporte au capital reel de 0,03925 SOL.
  assert.strictEqual(up.pnlPct, 7.64, 'sans correction on afficherait +50 %');
});

test('Fermer de vieux comptes et acheter dans la meme periode : pas de faux gain', () => {
  const perf = new MatchPerformance(
    snap({ sol: 0.006, accounts: [{ address: 'OLD', mint: 'DEAD', rentLamports: 30000000 }] }),
    usd({ [SOL_MINT]: 100 })
  );
  const r = perf.update(
    snap({ sol: 0.014, tokens: [{ mint: TOK_A, amount: 20 }], accounts: [{ address: 'ATA_A', mint: TOK_A }] }),
    usd({ [SOL_MINT]: 100, [TOK_A]: 0.1 })
  );
  assert.strictEqual(r.pnlPct, 0);
});

test('USDT detenu avant le match : 0 % quand le SOL monte', () => {
  const p0 = usd({ [SOL_MINT]: 100, [USDT_MINT]: 1 });
  const perf = new MatchPerformance(snap({ sol: 0.5, tokens: [{ mint: USDT_MINT, amount: 100 }] }), p0);
  assert.strictEqual(perf.capitalSol, 1.5);
  const r = perf.update(snap({ sol: 0.5, tokens: [{ mint: USDT_MINT, amount: 100 }] }), usd({ [SOL_MINT]: 150, [USDT_MINT]: 1 }));
  assert.strictEqual(r.pnlPct, 0);
});

test('Poussiere detenue avant le match qui fait x10 : hors jeu, 0 %', () => {
  const perf = new MatchPerformance(
    snap({ sol: 1, tokens: [{ mint: TOK_D, amount: 1000 }] }),
    usd({ [SOL_MINT]: 100, [TOK_D]: 0.001 })
  );
  const r = perf.update(snap({ sol: 1, tokens: [{ mint: TOK_D, amount: 1000 }] }), usd({ [SOL_MINT]: 100, [TOK_D]: 0.01 }));
  assert.strictEqual(r.pnlPct, 0);
});

test('Revendre une poussiere detenue avant le match : neutre', () => {
  const perf = new MatchPerformance(
    snap({ sol: 1, tokens: [{ mint: TOK_D, amount: 1000 }] }),
    usd({ [SOL_MINT]: 100, [TOK_D]: 0.001 })
  );
  const r = perf.update(snap({ sol: 1.01 }), usd({ [SOL_MINT]: 100, [TOK_D]: 0.001 }));
  assert.strictEqual(r.pnlPct, 0);
});

test('Token achete sans prix : compte 0, puis revalorise des qu il est cote', () => {
  const perf = new MatchPerformance(snap({ sol: 1 }), usd({ [SOL_MINT]: 100 }));
  const acc = [{ address: 'ATA_FRESH', mint: FRESH }];
  const blind = perf.update(
    snap({ sol: 0.498, tokens: [{ mint: FRESH, amount: 1000 }], accounts: acc }),
    usd({ [SOL_MINT]: 100, [FRESH]: null })
  );
  assert.strictEqual(blind.pnlPct, -50.2);
  assert.ok(blind.point.legs.find((l) => l.mint === FRESH).unpriced, 'le token doit etre signale sans prix');
  const priced = perf.update(
    snap({ sol: 0.498, tokens: [{ mint: FRESH, amount: 1000 }], accounts: acc }),
    usd({ [SOL_MINT]: 100, [FRESH]: 0.05 })
  );
  assert.strictEqual(priced.pnlPct, 0);
});

test('Panne des sources de prix : dernier prix connu reporte', () => {
  const perf = new MatchPerformance(snap({ sol: 1 }), usd({ [SOL_MINT]: 100 }));
  const acc = [{ address: 'ATA_A', mint: TOK_A }];
  perf.update(snap({ sol: 0.498, tokens: [{ mint: TOK_A, amount: 500 }], accounts: acc }), usd({ [SOL_MINT]: 100, [TOK_A]: 0.1 }));
  const outage = perf.update(
    snap({ sol: 0.498, tokens: [{ mint: TOK_A, amount: 500 }], accounts: acc }),
    usd({ [SOL_MINT]: 100, [TOK_A]: null })
  );
  assert.strictEqual(outage.pnlPct, 0, 'une panne ne doit pas creer une perte de 50 %');
});

test('Depot neutralise : Marc 1 -> 0,9 SOL, puis +0,5 SOL de depot = -10 %', () => {
  const perf = new MatchPerformance(snap({ sol: 1 }), usd({ [SOL_MINT]: 100 }));
  perf.update(snap({ sol: 0.9 }), usd({ [SOL_MINT]: 100 }));
  const live = perf.update(snap({ sol: 1.4 }), usd({ [SOL_MINT]: 100 }));
  assert.strictEqual(live.pnlPct, 40, 'en direct, le depot gonfle le score');
  assert.ok(live.alert, 'le depot doit declencher une alerte en direct');
  const depositSlot = perf.lastPoint.slot - 1;
  assert.strictEqual(perf.recompute([{ slot: depositSlot, valueSol: 0.5 }]).pnlPct, -10);
});

test('Sans flux, la chaine donne exactement valeur finale / capital - 1', () => {
  const perf = new MatchPerformance(snap({ sol: 1 }), usd({ [SOL_MINT]: 100 }));
  for (const sol of [1.04, 0.97, 1.12, 0.86]) perf.update(snap({ sol }), usd({ [SOL_MINT]: 100 }));
  assert.ok(near(perf.explain().rawPerformance, -14), `${perf.explain().rawPerformance}`);
  assert.strictEqual(perf.recompute([]).pnlPct, -14);
});

test('Un achat normal ne declenche pas d alerte', () => {
  const perf = new MatchPerformance(snap({ sol: 1 }), usd({ [SOL_MINT]: 100 }));
  const r = perf.update(
    snap({ sol: 0.498, tokens: [{ mint: TOK_A, amount: 500 }], accounts: [{ address: 'ATA_A', mint: TOK_A }] }),
    usd({ [SOL_MINT]: 100, [TOK_A]: 0.1 })
  );
  assert.strictEqual(r.alert, null);
});

test('Recuperer ses cautions ne declenche pas d alerte', () => {
  const perf = new MatchPerformance(
    snap({ sol: 0.006, accounts: [{ address: 'OLD', mint: 'DEAD', rentLamports: 30000000 }] }),
    usd({ [SOL_MINT]: 100 })
  );
  assert.strictEqual(perf.update(snap({ sol: 0.036 }), usd({ [SOL_MINT]: 100 })).alert, null);
});

// ===========================================================================
// Depart propre
// ===========================================================================

test('Depart : SOL seul -> autorise', () => {
  const e = assessEligibility(snap({ sol: 1 }), usd({ [SOL_MINT]: 100 }));
  assert.strictEqual(e.eligible, true);
  assert.strictEqual(e.capitalSol, 1);
});

test('Depart : SOL + USDT pour la mise -> autorise, USDT compte dans le capital', () => {
  const e = assessEligibility(snap({ sol: 0.5, tokens: [{ mint: USDT_MINT, amount: 100 }] }), usd({ [SOL_MINT]: 100, [USDT_MINT]: 1 }));
  assert.strictEqual(e.eligible, true);
  assert.strictEqual(e.capitalSol, 1.5);
});

test('Depart : un memecoin significatif -> refuse, avec le token nomme', () => {
  const p = usd({ [SOL_MINT]: 100, [TOK_A]: { price: 0.1, status: STATUS.FRESH, crossCheck: { symbol: 'MEEKO' } } });
  const e = assessEligibility(snap({ sol: 1, tokens: [{ mint: TOK_A, amount: 500 }] }), p);
  assert.strictEqual(e.eligible, false);
  assert.strictEqual(e.problems[0].code, 'unclean-start');
  assert.match(eligibilityMessage(e), /MEEKO/);
});

test('Depart : poussiere sous la tolerance -> autorise, comptee dans le capital', () => {
  const e = assessEligibility(snap({ sol: 1, tokens: [{ mint: TOK_D, amount: 1000 }] }), usd({ [SOL_MINT]: 100, [TOK_D]: 0.001 }));
  assert.strictEqual(e.eligible, true);
  assert.ok(near(e.capitalSol, 1.01));
});

test('Depart : token sans prix (spam) -> ignore', () => {
  const e = assessEligibility(snap({ sol: 1, tokens: [{ mint: SPAM, amount: 1e9 }] }), usd({ [SOL_MINT]: 100, [SPAM]: null }));
  assert.strictEqual(e.eligible, true);
  assert.strictEqual(e.unpriced.length, 1);
});

test('Depart : pas assez de SOL pour payer frais et caution -> refuse', () => {
  const e = assessEligibility(snap({ sol: 0.0008 }), usd({ [SOL_MINT]: 100 }));
  assert.strictEqual(e.eligible, false);
  assert.strictEqual(e.problems[0].code, 'insufficient-sol');
  assert.match(eligibilityMessage(e), /au moins/);
});

// ===========================================================================
// Lecture des transactions
// ===========================================================================

function ptx({ keys, pre, post, preTB = [], postTB = [], ixs = [], inner = [], fee = 5000, sig = 'sig', txSlot = 1500 }) {
  return {
    slot: txSlot,
    blockTime: 1700000000,
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: keys.map((k) => ({ pubkey: k.key, signer: !!k.signer, writable: true })),
        instructions: ixs,
      },
    },
    meta: {
      err: null,
      fee,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: preTB,
      postTokenBalances: postTB,
      innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [],
    },
  };
}
const tb = (accountIndex, mint, owner, raw, decimals = 6) => ({
  accountIndex,
  mint,
  owner,
  uiTokenAmount: { amount: String(raw), decimals },
});
const splTransfer = (source, destination, authority, amount) => ({
  program: 'spl-token',
  programId: TOKEN_PROGRAM,
  parsed: { type: 'transfer', info: { source, destination, authority, amount: String(amount) } },
});

// Swap via Phantom Terminal : 0,5 SOL -> 500 TOK_A, compte ouvert au passage.
const swapTx = () =>
  ptx({
    keys: [{ key: W, signer: true }, { key: 'W_ATA_A' }, { key: 'POOL' }],
    pre: [1000000000, 0, 5000000000],
    post: [497955000, 2040000, 5500000000],
    postTB: [tb(1, TOK_A, W, 500000000)],
    ixs: [{ programId: TERMINAL }],
  });

// Depot de 500 TOK_A sur un compte existant : le wallet n'apparait meme pas.
const tokenDepositTx = () =>
  ptx({
    sig: 'dep',
    keys: [{ key: ALT, signer: true }, { key: 'ALT_ATA_A' }, { key: 'W_ATA_A' }],
    pre: [1000000000, 2040000, 2040000],
    post: [999995000, 2040000, 2040000],
    preTB: [tb(1, TOK_A, ALT, 900000000), tb(2, TOK_A, W, 100000000)],
    postTB: [tb(1, TOK_A, ALT, 400000000), tb(2, TOK_A, W, 600000000)],
    ixs: [splTransfer('ALT_ATA_A', 'W_ATA_A', ALT, 500000000)],
  });

// Depot de 0,5 SOL depuis un autre wallet.
const solDepositTx = (sig = 'soldep') =>
  ptx({
    sig,
    keys: [{ key: ALT, signer: true }, { key: W }],
    pre: [2000000000, 1000000000],
    post: [1499995000, 1500000000],
    ixs: [{ program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: ALT, destination: W, lamports: 500000000 } } }],
  });

test('Swap via Phantom Terminal -> SWAP, rien d entrant', () => {
  const c = classify(swapTx(), W);
  assert.strictEqual(c.type, TX_TYPE.SWAP);
  assert.ok(near(c.solSide, -0.5), `${c.solSide}`);
  assert.strictEqual(c.inflows.length, 0);
});

test('Depot de tokens invisible dans l historique du wallet -> TRANSFER_IN', () => {
  const c = classify(tokenDepositTx(), W);
  assert.strictEqual(c.type, TX_TYPE.TRANSFER_IN);
  assert.strictEqual(c.fee, 0, 'le joueur n a pas paye les frais');
  assert.deepStrictEqual(c.inflows, [{ kind: 'token', mint: TOK_A, amount: 500 }]);
});

test('Depot de SOL depuis un autre wallet -> TRANSFER_IN', () => {
  const c = classify(solDepositTx(), W);
  assert.strictEqual(c.type, TX_TYPE.TRANSFER_IN);
  assert.ok(near(c.inflows[0].amount, 0.5));
});

test('Ouvrir soi-meme un compte de token -> neutre, pas un transfert', () => {
  const c = classify(
    ptx({
      keys: [{ key: W, signer: true }, { key: 'W_ATA_A' }],
      pre: [1000000000, 0],
      post: [997955000, 2040000],
      postTB: [tb(1, TOK_A, W, 0)],
    }),
    W
  );
  assert.strictEqual(c.type, TX_TYPE.FEE);
  assert.strictEqual(c.inflows.length, 0);
});

test('Spam : un inconnu ouvre un compte et y depose un token -> caution offerte reperee', () => {
  const c = classify(
    ptx({
      keys: [{ key: 'SPAMMER', signer: true }, { key: 'W_ATA_SPAM' }, { key: W }],
      pre: [1000000000, 0, 1000000000],
      post: [997955000, 2040000, 1000000000],
      postTB: [tb(1, SPAM, W, 1000000000000)],
    }),
    W
  );
  assert.strictEqual(c.type, TX_TYPE.TRANSFER_IN);
  assert.ok(!c.inflows.some((f) => f.kind === 'sol'), 'la caution n est pas du SOL depose');
  assert.strictEqual(c.rentGifts.length, 1);
  assert.strictEqual(c.rentGifts[0].mint, SPAM);
});

test('Fonds glisses dans un swap par un second signataire -> injection reperee', () => {
  const c = classify(
    ptx({
      keys: [{ key: W, signer: true }, { key: ALT, signer: true }, { key: 'W_ATA_A' }, { key: 'ALT_ATA_A' }],
      pre: [1000000000, 1000000000, 0, 2040000],
      post: [497955000, 1000000000, 2040000, 2040000],
      postTB: [tb(2, TOK_A, W, 1500000000)],
      ixs: [{ programId: JUPITER }],
      inner: [splTransfer('ALT_ATA_A', 'W_ATA_A', ALT, 1000000000)],
    }),
    W
  );
  assert.strictEqual(c.type, TX_TYPE.SWAP);
  assert.strictEqual(c.injections.length, 1);
  assert.strictEqual(c.injections[0].amount, 1000);
  assert.strictEqual(c.injections[0].from, ALT);
});

test('Paiement signe par Arvon -> PLATFORM', () => {
  const c = classify(
    ptx({
      keys: [{ key: HOUSE, signer: true }, { key: 'HOUSE_ATA' }, { key: 'W_ATA_USDT' }],
      pre: [1000000000, 2040000, 2040000],
      post: [999995000, 2040000, 2040000],
      preTB: [tb(2, USDT_MINT, W, 0)],
      postTB: [tb(2, USDT_MINT, W, 17000000)],
      ixs: [splTransfer('HOUSE_ATA', 'W_ATA_USDT', HOUSE, 17000000)],
    }),
    W,
    { ignoredSources: new Set([HOUSE]) }
  );
  assert.strictEqual(c.type, TX_TYPE.PLATFORM);
});

test('Wrapper son SOL -> neutre (caution et SOL wrappe bien separes)', () => {
  const c = classify(
    ptx({
      keys: [{ key: W, signer: true }, { key: 'W_WSOL' }],
      pre: [1000000000, 2040000],
      post: [699995000, 302040000],
      preTB: [tb(1, SOL_MINT, W, 0, 9)],
      postTB: [tb(1, SOL_MINT, W, 300000000, 9)],
    }),
    W
  );
  assert.strictEqual(c.type, TX_TYPE.FEE);
  assert.ok(near(c.wrappedDelta, 0.3));
  assert.ok(near(c.rentDelta, 0));
});

test('Caution d un compte de SOL wrappe : le SOL wrappe n est pas compte deux fois', () => {
  const info = { isNative: true, tokenAmount: { amount: '300000000' } };
  assert.strictEqual(rentLamportsOf({ lamports: 302039280 }, info), 2039280n);
  assert.strictEqual(
    rentLamportsOf({ lamports: 302039280 }, { ...info, rentExemptReserve: { amount: '2039280' } }),
    2039280n
  );
  assert.strictEqual(rentLamportsOf({ lamports: 2039280 }, { isNative: false }), 2039280n);
});

test('Transaction dupliquee comptee une seule fois', () => {
  const seen = new Set();
  assert.strictEqual(dedupeTransactions([{ signature: 'a' }, { signature: 'b' }], seen).length, 2);
  assert.strictEqual(dedupeTransactions([{ signature: 'a' }], seen).length, 0);
});

// ===========================================================================
// Verification de fin de match
// ===========================================================================

function source({ sigs = {}, txs = {}, fail = false, truncated = false } = {}) {
  return {
    signaturesInWindow: async (address) => {
      if (fail) throw new Error('RPC indisponible');
      return { signatures: sigs[address] || [], truncated };
    },
    fetchTransaction: async (sig) => txs[sig] || null,
  };
}

const verify = (overrides) =>
  verifyWallet({
    wallet: W,
    fromSlot: 1000,
    toSlot: 2000,
    pricesAtSlot: () => new Map([[TOK_A, 0.001]]),
    rentCounted: (address, mint, prices) => prices.has(mint),
    capitalSol: 1,
    ...overrides,
  });

test('Verification : aucune transaction -> propre', async () => {
  const r = await verify({ source: source() });
  assert.strictEqual(r.status, VERDICT.CLEAN);
});

test('Verification : depot de 0,5 SOL -> suspect, et neutralisable', async () => {
  const r = await verify({
    source: source({ sigs: { [W]: [{ signature: 'soldep', slot: 1500 }] }, txs: { soldep: solDepositTx() } }),
  });
  assert.strictEqual(r.status, VERDICT.INFLOWS);
  assert.ok(near(r.suspectInflowSol, 0.5));
  assert.ok(near(r.neutralize[0].valueSol, 0.5));
});

test('Verification : depot trouve uniquement via l historique du compte de token', async () => {
  const r = await verify({
    candidateAccounts: ['W_ATA_A'],
    source: source({ sigs: { W_ATA_A: [{ signature: 'dep', slot: 1500 }] }, txs: { dep: tokenDepositTx() } }),
  });
  assert.strictEqual(r.status, VERDICT.INFLOWS, 'le wallet seul ne montre rien : il faut lire le compte');
  assert.ok(near(r.suspectInflowSol, 0.5));
});

test('Verification : petit depot sous le seuil -> propre, mais quand meme neutralise', async () => {
  const tiny = solDepositTx('tiny');
  tiny.meta.preBalances = [2000000000, 1000000000];
  tiny.meta.postBalances = [1999695000, 1000300000];
  const r = await verify({ source: source({ sigs: { [W]: [{ signature: 'tiny', slot: 1500 }] }, txs: { tiny } }) });
  assert.strictEqual(r.status, VERDICT.CLEAN);
  assert.ok(near(r.neutralize[0].valueSol, 0.0003));
});

test('Verification : airdrop spam sans prix -> propre', async () => {
  const spam = ptx({
    sig: 'spam',
    keys: [{ key: 'SPAMMER', signer: true }, { key: 'W_ATA_SPAM' }, { key: W }],
    pre: [1000000000, 0, 1000000000],
    post: [997955000, 2040000, 1000000000],
    postTB: [tb(1, SPAM, W, 1000000000000)],
  });
  const r = await verify({ source: source({ sigs: { [W]: [{ signature: 'spam', slot: 1500 }] }, txs: { spam } }) });
  assert.strictEqual(r.status, VERDICT.CLEAN);
  assert.strictEqual(r.neutralize.length, 0);
});

test('Verification : RPC indisponible ou historique tronque -> non verifie', async () => {
  assert.strictEqual((await verify({ source: source({ fail: true }) })).status, VERDICT.UNVERIFIED);
  assert.strictEqual((await verify({ source: source({ truncated: true }) })).status, VERDICT.UNVERIFIED);
});

// ===========================================================================
// Reglement
// ===========================================================================

const P = (id, stake, pnlPct, status = 'clean', extra = {}) => ({ id, isBot: false, stake, pnlPct, status, ...extra });

test('Reglement 1v1 : le meilleur gagne le pot moins 15 %', () => {
  const s = settleTeamMatch({ teams: [[P('a', 10, 5)], [P('b', 10, -3)]], isCash: true, feeRate: 0.15 });
  assert.strictEqual(s.winner, 'A');
  assert.strictEqual(s.fee, 3);
  assert.deepStrictEqual(s.payouts, [{ id: 'a', amount: 17 }]);
});

test('Reglement : le tricheur a +40 % perd, l honnete a +20 % gagne', () => {
  const s = settleTeamMatch({ teams: [[P('marc', 10, 40, 'disqualified')], [P('lea', 10, 20)]], isCash: true, feeRate: 0.15 });
  assert.strictEqual(s.winner, 'B');
  assert.strictEqual(s.outcome, 'forfeit');
  assert.deepStrictEqual(s.payouts, [{ id: 'lea', amount: 17 }]);
  assert.deepStrictEqual(s.forfeits, [{ id: 'marc', amount: 10 }]);
});

test('Reglement : tricheurs des deux cotes -> honnetes rembourses, tricheurs perdent leur mise', () => {
  const s = settleTeamMatch({
    teams: [
      [P('a1', 10, 9, 'disqualified'), P('a2', 10, 1)],
      [P('b1', 10, 8, 'disqualified'), P('b2', 10, 2)],
    ],
    isCash: true,
    feeRate: 0.15,
  });
  assert.strictEqual(s.outcome, 'void');
  assert.deepStrictEqual(s.refunds.map((r) => r.id).sort(), ['a2', 'b2']);
  assert.deepStrictEqual(s.forfeits.map((r) => r.id).sort(), ['a1', 'b1']);
  assert.strictEqual(s.payouts.length, 0);
});

test('Reglement : verification impossible -> tout le monde rembourse', () => {
  const s = settleTeamMatch({ teams: [[P('a', 10, 5, 'unverified')], [P('b', 10, -3)]], isCash: true, feeRate: 0.15 });
  assert.strictEqual(s.outcome, 'refund');
  assert.strictEqual(s.refunds.length, 2);
  assert.strictEqual(s.payouts.length, 0);
});

test('Reglement : egalite -> mises rendues', () => {
  const s = settleTeamMatch({ teams: [[P('a', 10, 2)], [P('b', 10, 2)]], isCash: true, feeRate: 0.15 });
  assert.strictEqual(s.winner, 'draw');
  assert.strictEqual(s.refunds.length, 2);
});

test('Reglement en equipe : gain proportionnel a la mise de chacun', () => {
  const s = settleTeamMatch({
    teams: [
      [P('a1', 10, 5), P('a2', 30, 3)],
      [P('b1', 20, -1), P('b2', 20, -2)],
    ],
    isCash: true,
    feeRate: 0.15,
  });
  assert.strictEqual(s.fee, 12);
  assert.deepStrictEqual(s.payouts, [{ id: 'a1', amount: 17 }, { id: 'a2', amount: 51 }]);
});

test('Battle Royale : le tricheur en tete est classe dernier, le meilleur honnete gagne', () => {
  const s = settleBrMatch({
    players: [
      P('p1', 5, 50, 'disqualified', { alive: true }),
      P('p2', 5, 20, 'clean', { alive: true }),
      P('p3', 5, -5, 'clean', { alive: false }),
      P('p4', 5, -9, 'clean', { alive: false }),
    ],
    eliminationOrder: ['p4', 'p3'],
    isCash: true,
    feeRate: 0.15,
  });
  assert.deepStrictEqual(s.ranking.map((p) => p.id), ['p2', 'p3', 'p4', 'p1']);
  assert.deepStrictEqual(s.payouts, [{ id: 'p2', amount: 17 }]);
  assert.deepStrictEqual(s.forfeits, [{ id: 'p1', amount: 5 }]);
});

test('Battle Royale : verification impossible -> remboursement', () => {
  const s = settleBrMatch({
    players: [P('p1', 5, 10, 'unverified', { alive: true }), P('p2', 5, 2, 'clean', { alive: true })],
    eliminationOrder: [],
    isCash: true,
    feeRate: 0.15,
  });
  assert.strictEqual(s.outcome, 'refund');
  assert.strictEqual(s.payouts.length, 0);
});

// ===========================================================================
// Suivi joueur
// ===========================================================================

test('Erreur RPC en plein match : derniere valeur conservee', async () => {
  const pt = new PlayerTracker({ playerId: 'p1', name: 'T', wallet: 'adresse-invalide', logger: null });
  pt.perf = new MatchPerformance(snap({ sol: 1 }), usd({ [SOL_MINT]: 100 }));
  pt.pnlPct = pt.perf.update(snap({ sol: 0.92 }), usd({ [SOL_MINT]: 100 })).pnlPct;
  pt.ready = true;
  assert.strictEqual(pt.pnlPct, -8);
  assert.strictEqual(await pt.refresh({ force: true }), -8);
  assert.ok(pt.error);
});

test('Les comptes ouverts pendant le match sont reperes pour la verification', () => {
  const pt = new PlayerTracker({ playerId: 'p1', name: 'T', wallet: W, logger: null });
  const start = snap({ sol: 1, accounts: [{ address: 'OLD', mint: 'DEAD' }] });
  pt.recordAccounts(start);
  pt.perf = new MatchPerformance(start, usd({ [SOL_MINT]: 100 }));
  pt.ready = true;
  const later = snap({ sol: 0.5, accounts: [{ address: 'OLD', mint: 'DEAD' }, { address: 'NEW', mint: TOK_A }] });
  pt.recordAccounts(later);
  assert.deepStrictEqual(pt.changedAccounts(), ['NEW']);
  assert.deepStrictEqual(pt.newAccountMints(later), [TOK_A]);
});

// ===========================================================================
// Contre-verification des prix (DexScreener)
// ===========================================================================

const ref = (spec) => new Map(Object.entries(spec));

test('Prix : sources concordantes -> prix primaire conserve', () => {
  assert.strictEqual(arbitrate(TOK_A, 100, ref({ [TOK_A]: { price: 103, liquidityUsd: 500000 } })).source, 'jupiter');
});

test('Prix : divergence forte sur un pool liquide -> la reference l emporte', () => {
  const v = arbitrate(TOK_A, 0.00003046, ref({ [TOK_A]: { price: 0.000002683, liquidityUsd: 50000 } }));
  assert.strictEqual(v.source, 'dexscreener');
  assert.strictEqual(v.price, 0.000002683);
});

test('Prix : divergence sur un pool illiquide -> ignoree', () => {
  assert.strictEqual(arbitrate(TOK_A, 0.001, ref({ [TOK_A]: { price: 0.05, liquidityUsd: 12 } })).price, 0.001);
});

test('Prix : paire la plus liquide, en jeton de base uniquement', () => {
  const best = bestPairByMint(
    [
      { baseToken: { address: TOK_A, symbol: 'A' }, priceUsd: '1.00', liquidity: { usd: 1000 }, dexId: 'raydium' },
      { baseToken: { address: TOK_A, symbol: 'A' }, priceUsd: '1.30', liquidity: { usd: 90000 }, dexId: 'orca' },
      { baseToken: { address: SPAM, symbol: 'S' }, priceUsd: '9.99', liquidity: { usd: 99999 }, dexId: 'meteora' },
    ],
    [TOK_A]
  );
  assert.strictEqual(best.size, 1);
  assert.strictEqual(best.get(TOK_A).price, 1.3);
});

// ===========================================================================

(async () => {
  let passed = 0;
  const failures = [];
  console.log(`\nPerformance et verification anti-triche - ${tests.length} tests\n`);
  for (const [i, t] of tests.entries()) {
    try {
      await t.fn();
      console.log(`  ok   ${String(i + 1).padStart(2)}. ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL ${String(i + 1).padStart(2)}. ${t.name}`);
      console.log(`         ${e.message}`);
      failures.push(t.name);
    }
  }
  console.log(`\n${passed}/${tests.length} tests passes`);
  if (failures.length) process.exit(1);
  console.log('');
})();
