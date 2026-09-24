// Tests du pipeline de performance. Aucun acces reseau : on injecte des
// snapshots et des cartes de prix synthetiques.

const assert = require('assert');
const { valueSnapshot, PerformanceTracker, round2 } = require('../lib/performance');
const { STATUS } = require('../lib/pricing');
const { SOL_MINT } = require('../lib/wallet');
const { classify, flowUsdValue, dedupeTransactions, TX_TYPE } = require('../lib/txclassify');
const { PlayerTracker } = require('../lib/playertracker');

const TOK_A = 'AaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaa';
const TOK_B = 'BbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbb';
const TOK_NEW = 'NnnnNNNNnnnnNNNNnnnnNNNNnnnnNNNNnnnnNNNNnnn';
const WALLET = 'Wwww1111wwww1111wwww1111wwww1111wwww1111www';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

let clock = 1_700_000_000_000;

function snap({ sol = 0, tokens = [] }) {
  clock += 1000;
  return {
    wallet: WALLET,
    timestamp: clock,
    slot: 1000,
    slots: {},
    slotSpread: 0,
    native: { lamports: Math.round(sol * 1e9), amount: sol },
    assets: tokens.map((t) => ({
      mint: t.mint,
      raw: String(Math.round(t.amount * 10 ** (t.decimals ?? 6))),
      decimals: t.decimals ?? 6,
      amount: t.amount,
      program: t.program || 'spl-token',
      accounts: 1,
    })),
    errors: [],
  };
}

function prices(spec) {
  const m = new Map();
  for (const [mint, v] of Object.entries(spec)) {
    if (v === null) {
      m.set(mint, { price: null, status: STATUS.UNPRICED, ageMs: null, fetchedAt: null });
    } else if (typeof v === 'object') {
      m.set(mint, v);
    } else {
      m.set(mint, { price: v, status: STATUS.FRESH, ageMs: 0, fetchedAt: clock });
    }
  }
  return m;
}

function equityOf(s, p, opts) {
  return valueSnapshot(s, prices(p), opts).equity;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;

// --------------------------------------------------------------------------

test('1. Equity stable -> 0%', () => {
  const s0 = snap({ sol: 10 });
  const t = new PerformanceTracker(valueSnapshot(s0, prices({ [SOL_MINT]: 100 })));
  assert.strictEqual(t.initialEquity, 1000);
  const r = t.update(valueSnapshot(snap({ sol: 10 }), prices({ [SOL_MINT]: 100 })));
  assert.strictEqual(r.pnlPct, 0);
});

test('2. 1000 -> 1100 = +10%', () => {
  const t = new PerformanceTracker(valueSnapshot(snap({ sol: 10 }), prices({ [SOL_MINT]: 100 })));
  const r = t.update(valueSnapshot(snap({ sol: 11 }), prices({ [SOL_MINT]: 100 })));
  assert.strictEqual(r.pnlPct, 10);
});

test('3. 1000 -> 900 = -10%', () => {
  const t = new PerformanceTracker(valueSnapshot(snap({ sol: 10 }), prices({ [SOL_MINT]: 100 })));
  const r = t.update(valueSnapshot(snap({ sol: 9 }), prices({ [SOL_MINT]: 100 })));
  assert.strictEqual(r.pnlPct, -10);
});

test('4. Prix x2 sans aucune transaction -> +100%', () => {
  const holding = { sol: 0, tokens: [{ mint: TOK_A, amount: 100 }] };
  const t = new PerformanceTracker(valueSnapshot(snap(holding), prices({ [SOL_MINT]: 100, [TOK_A]: 1 })));
  assert.strictEqual(t.initialEquity, 100);
  // Quantite identique, seul le prix bouge. C'etait le bug d'origine.
  const r = t.update(valueSnapshot(snap(holding), prices({ [SOL_MINT]: 100, [TOK_A]: 2 })));
  assert.strictEqual(r.pnlPct, 100);
});

test('5. Prix /2 sans transaction -> -50%', () => {
  const holding = { sol: 0, tokens: [{ mint: TOK_A, amount: 100 }] };
  const t = new PerformanceTracker(valueSnapshot(snap(holding), prices({ [TOK_A]: 1, [SOL_MINT]: 100 })));
  const r = t.update(valueSnapshot(snap(holding), prices({ [TOK_A]: 0.5, [SOL_MINT]: 100 })));
  assert.strictEqual(r.pnlPct, -50);
});

test('6. Achat puis revente en perte -> -5%', () => {
  const p = { [SOL_MINT]: 100, [TOK_A]: 1.9 };
  const t = new PerformanceTracker(valueSnapshot(snap({ sol: 10 }), prices(p))); // 1000
  t.update(valueSnapshot(snap({ sol: 0.05, tokens: [{ mint: TOK_A, amount: 500 }] }), prices(p))); // 955
  const r = t.update(valueSnapshot(snap({ sol: 9.5 }), prices(p))); // 950
  assert.strictEqual(r.pnlPct, -5); // 950/1000 - 1
});

test('7. Frais reseau : reels, donc NON neutralises', () => {
  const t = new PerformanceTracker(valueSnapshot(snap({ sol: 10 }), prices({ [SOL_MINT]: 100 })));
  const r = t.update(valueSnapshot(snap({ sol: 9.9 }), prices({ [SOL_MINT]: 100 })));
  assert.strictEqual(r.pnlPct, -1);
  assert.strictEqual(t.totalFlowUsd, 0, 'des frais ne sont pas un flux externe');
});

test('8. Depot externe sans trade -> 0% (flux neutralise)', () => {
  const t = new PerformanceTracker(valueSnapshot(snap({ sol: 10 }), prices({ [SOL_MINT]: 100 })));
  const r = t.update(valueSnapshot(snap({ sol: 15 }), prices({ [SOL_MINT]: 100 })), [
    { type: TX_TYPE.TRANSFER_IN, usdValue: 500 },
  ]);
  assert.strictEqual(r.pnlPct, 0, 'envoyer 500$ ne doit pas valoir +50%');
});

test('9. Retrait externe sans trade -> 0%', () => {
  const t = new PerformanceTracker(valueSnapshot(snap({ sol: 10 }), prices({ [SOL_MINT]: 100 })));
  const r = t.update(valueSnapshot(snap({ sol: 5 }), prices({ [SOL_MINT]: 100 })), [
    { type: TX_TYPE.TRANSFER_OUT, usdValue: -500 },
  ]);
  assert.strictEqual(r.pnlPct, 0, 'retirer 500$ ne doit pas valoir -50%');
});

test('10. Panne Jupiter : prix STALE conserve, aucune perte fantome', () => {
  const holding = { sol: 0, tokens: [{ mint: TOK_A, amount: 100 }] };
  const fresh = prices({ [SOL_MINT]: 100, [TOK_A]: 1 });
  const t = new PerformanceTracker(valueSnapshot(snap(holding), fresh));
  // La source ne repond plus : plus aucune cotation dans la reponse.
  const outage = prices({ [SOL_MINT]: null, [TOK_A]: null });
  const v = valueSnapshot(snap(holding), outage, { carryForward: t.carryForwardPrices() });
  assert.strictEqual(v.equity, 100, 'le dernier prix connu doit etre reporte');
  assert.strictEqual(v.breakdown.find((b) => b.mint === TOK_A).priceSource, 'carry-forward');
  assert.strictEqual(t.update(v).pnlPct, 0);
});

test('11. Token jamais cote acquis en cours de match -> score gele', () => {
  const t = new PerformanceTracker(valueSnapshot(snap({ sol: 10 }), prices({ [SOL_MINT]: 100 })));
  t.update(valueSnapshot(snap({ sol: 9 }), prices({ [SOL_MINT]: 100 })));
  assert.strictEqual(t.pnlPct, -10);

  // Swap vers un token que la source ne cote pas : l'equity serait sous-evaluee.
  const v = valueSnapshot(
    snap({ sol: 0.1, tokens: [{ mint: TOK_NEW, amount: 5000 }] }),
    prices({ [SOL_MINT]: 100, [TOK_NEW]: null }),
    { carryForward: t.carryForwardPrices() }
  );
  const r = t.update(v);
  assert.strictEqual(r.applied, false);
  assert.ok(r.degraded, 'la degradation doit etre signalee');
  assert.strictEqual(r.pnlPct, -10, 'le score ne doit pas chuter a cause d un actif non cote');
});

test('12. Erreur RPC : derniere valeur conservee, jamais de 0', async () => {
  const pt = new PlayerTracker({ playerId: 'p1', name: 'T', wallet: 'adresse-invalide', logger: null });
  pt.tracker = new PerformanceTracker(valueSnapshot(snap({ sol: 10 }), prices({ [SOL_MINT]: 100 })));
  pt.tracker.update(valueSnapshot(snap({ sol: 9.2 }), prices({ [SOL_MINT]: 100 })));
  pt.pnlPct = pt.tracker.pnlPct;
  pt.ready = true;
  assert.strictEqual(pt.pnlPct, -8);

  const after = await pt.refresh({ force: true }); // adresse invalide -> throw -> catch
  assert.strictEqual(after, -8, 'une panne RPC ne doit pas remettre le score a zero');
  assert.ok(pt.error, 'l erreur doit etre exposee');
});

test('13. Token-2022 compte dans l equity', () => {
  const v = valueSnapshot(
    snap({ sol: 1, tokens: [{ mint: TOK_B, amount: 200, program: 'token-2022' }] }),
    prices({ [SOL_MINT]: 100, [TOK_B]: 3 })
  );
  assert.strictEqual(v.equity, 100 + 600);
  assert.strictEqual(v.breakdown.find((b) => b.mint === TOK_B).program, 'token-2022');
});

test('14. Deux tokens a prix differents', () => {
  const holding = {
    sol: 2,
    tokens: [
      { mint: TOK_A, amount: 50 },
      { mint: TOK_B, amount: 30 },
    ],
  };
  const t = new PerformanceTracker(
    valueSnapshot(snap(holding), prices({ [SOL_MINT]: 100, [TOK_A]: 10, [TOK_B]: 5 }))
  );
  assert.strictEqual(t.initialEquity, 200 + 500 + 150); // 850
  // TOK_A +20% (+100$), TOK_B -40% (-60$), SOL stable -> +40$ sur 850$
  const r = t.update(valueSnapshot(snap(holding), prices({ [SOL_MINT]: 100, [TOK_A]: 12, [TOK_B]: 3 })));
  assert.strictEqual(r.pnlPct, 4.71); // 890/850 - 1
});

test('15. Snapshot final different du dernier tick -> le final gagne', () => {
  const t = new PerformanceTracker(valueSnapshot(snap({ sol: 10 }), prices({ [SOL_MINT]: 100 })));
  assert.strictEqual(t.update(valueSnapshot(snap({ sol: 9 }), prices({ [SOL_MINT]: 100 }))).pnlPct, -10);
  const final = t.update(valueSnapshot(snap({ sol: 8.6 }), prices({ [SOL_MINT]: 100 })));
  assert.strictEqual(final.pnlPct, -14);
  const e = t.explain();
  assert.strictEqual(e.initialEquity, 1000);
  assert.strictEqual(e.finalEquity, 860);
  assert.strictEqual(e.finalPnlPct, -14);
});

test('16. Transaction dupliquee comptee une seule fois', () => {
  const seen = new Set();
  const batch = [{ signature: 'sigA', type: TX_TYPE.TRANSFER_IN }, { signature: 'sigB', type: TX_TYPE.SWAP }];
  assert.strictEqual(dedupeTransactions(batch, seen).length, 2);
  // Le RPC renvoie a nouveau sigA dans la fenetre suivante.
  const second = dedupeTransactions([{ signature: 'sigA', type: TX_TYPE.TRANSFER_IN }], seen);
  assert.strictEqual(second.length, 0, 'sigA ne doit pas produire un second flux');
});

// -------- Classification des transactions --------

function tx({ programs = [], solDelta = 0, fee = 5000, pre = [], post = [] }) {
  const lamports = 1_000_000_000;
  return {
    slot: 42,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: [{ pubkey: WALLET }],
        instructions: programs.map((p) => ({ programId: p })),
      },
    },
    meta: {
      err: null,
      fee,
      preBalances: [lamports],
      postBalances: [lamports + Math.round(solDelta * 1e9) - fee],
      preTokenBalances: pre,
      postTokenBalances: post,
      innerInstructions: [],
    },
  };
}

const tb = (mint, amount) => ({
  mint,
  owner: WALLET,
  uiTokenAmount: { uiAmountString: String(amount), decimals: 6 },
});

test('17. Swap via Jupiter classe SWAP (interne, pas un flux)', () => {
  const c = classify(tx({ programs: [JUPITER], solDelta: -1, post: [tb(TOK_A, 500)] }), WALLET);
  assert.strictEqual(c.type, TX_TYPE.SWAP);
  assert.strictEqual(flowUsdValue(c, prices({ [TOK_A]: 2, [SOL_MINT]: 100 })), 0);
});

test('18. Reception de tokens classee TRANSFER_IN et valorisee', () => {
  const c = classify(tx({ solDelta: 0, post: [tb(TOK_A, 100)] }), WALLET);
  assert.strictEqual(c.type, TX_TYPE.TRANSFER_IN);
  assert.strictEqual(flowUsdValue(c, prices({ [TOK_A]: 3, [SOL_MINT]: 100 })), 300);
});

test('19. Envoi de tokens classe TRANSFER_OUT (valeur negative)', () => {
  const c = classify(tx({ solDelta: 0, pre: [tb(TOK_A, 100)] }), WALLET);
  assert.strictEqual(c.type, TX_TYPE.TRANSFER_OUT);
  assert.strictEqual(flowUsdValue(c, prices({ [TOK_A]: 3, [SOL_MINT]: 100 })), -300);
});

test('20. Transaction de frais seuls classee FEE', () => {
  const c = classify(tx({ solDelta: 0 }), WALLET);
  assert.strictEqual(c.type, TX_TYPE.FEE);
  assert.strictEqual(flowUsdValue(c, prices({ [SOL_MINT]: 100 })), 0);
});

test('21. Flux non valorisable -> null (jamais neutralise a l aveugle)', () => {
  const c = classify(tx({ solDelta: 0, post: [tb(TOK_NEW, 10)] }), WALLET);
  assert.strictEqual(c.type, TX_TYPE.TRANSFER_IN);
  assert.strictEqual(flowUsdValue(c, prices({ [TOK_NEW]: null, [SOL_MINT]: 100 })), null);
});

// -------- Invariants structurels --------

test('22. Un actif non cote n est jamais valorise a 0', () => {
  const v = valueSnapshot(
    snap({ sol: 1, tokens: [{ mint: TOK_NEW, amount: 999 }] }),
    prices({ [SOL_MINT]: 100, [TOK_NEW]: null })
  );
  const row = v.breakdown.find((b) => b.mint === TOK_NEW);
  assert.strictEqual(row.price, null, 'price doit etre null, pas 0');
  assert.strictEqual(row.value, null, 'value doit etre null, pas 0');
  assert.strictEqual(v.unpricedAssets.length, 1);
  assert.ok(v.coverage < 1);
});

test('23. Actif non cote des le depart : exclu des deux cotes, sans blocage', () => {
  const holding = { sol: 10, tokens: [{ mint: TOK_NEW, amount: 5 }] };
  const p = prices({ [SOL_MINT]: 100, [TOK_NEW]: null });
  const initial = valueSnapshot(snap(holding), p);
  const t = new PerformanceTracker(initial);
  assert.strictEqual(t.initialEquity, 1000);
  const r = t.update(valueSnapshot(snap({ sol: 11, tokens: [{ mint: TOK_NEW, amount: 5 }] }), p));
  assert.strictEqual(r.applied, true, 'symetrique : ne doit pas geler le score');
  assert.strictEqual(r.pnlPct, 10);
});

test('24. Sans flux, la chaine TWR egale exactement le ratio simple', () => {
  const t = new PerformanceTracker(valueSnapshot(snap({ sol: 10 }), prices({ [SOL_MINT]: 100 })));
  for (const sol of [10.4, 9.7, 11.2, 8.6]) {
    t.update(valueSnapshot(snap({ sol }), prices({ [SOL_MINT]: 100 })));
  }
  const direct = (860 / 1000 - 1) * 100;
  assert.ok(near(t.explain().rawPerformance, direct), `${t.explain().rawPerformance} vs ${direct}`);
  assert.strictEqual(t.pnlPct, -14);
});

test('25. La decomposition explique l equity actif par actif', () => {
  const v = valueSnapshot(
    snap({ sol: 2, tokens: [{ mint: TOK_A, amount: 50 }] }),
    prices({ [SOL_MINT]: 100, [TOK_A]: 4 })
  );
  const sum = v.breakdown.reduce((s, b) => s + (b.value || 0), 0);
  assert.strictEqual(sum, v.equity);
  assert.strictEqual(v.equity, 400);
});

test('26. Le SOL immobilise en rent reste dans l equity', () => {
  const base = snap({ sol: 1 });
  // Ouverture d'une position : 0.002 SOL passent du solde natif au compte de token.
  const avecPosition = {
    ...snap({ sol: 0.998, tokens: [{ mint: TOK_A, amount: 100 }] }),
    rent: { lamports: 2_000_000, amount: 0.002, accounts: 1 },
  };
  const p = prices({ [SOL_MINT]: 100, [TOK_A]: 0 });
  const t = new PerformanceTracker(valueSnapshot(base, p));
  assert.strictEqual(t.initialEquity, 100);

  // Le token vaut 0 : sans la ligne de rent, l'equity tomberait a 99.80.
  const v = valueSnapshot(avecPosition, p);
  assert.strictEqual(round2(v.equity), 100, 'le rent ne doit pas disparaitre du patrimoine');
  const rentRow = v.breakdown.find((b) => b.kind === 'token-account-rent');
  assert.ok(rentRow && rentRow.recoverable === true);
  assert.strictEqual(round2(rentRow.value), 0.2);
});

// --------------------------------------------------------------------------

(async () => {
  let passed = 0;
  const failures = [];
  console.log(`\nPipeline de performance — ${tests.length} tests\n`);
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok   ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL ${t.name}`);
      console.log(`       ${e.message}`);
      failures.push(t.name);
    }
  }
  console.log(`\n${passed}/${tests.length} tests passes`);
  if (failures.length) {
    console.log(`Echecs : ${failures.join(', ')}\n`);
    process.exit(1);
  }
  console.log('');
})();
