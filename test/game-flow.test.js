// Test d'integration : matchs complets a travers le vrai moteur de jeu
// (creation, ticks, fin de match, verification, reglement, paiements, stats).
// Blockchain, prix, paiements et base de donnees sont simules ; tout le reste
// est le code de production.

process.env.WALLET_REFRESH_MS = '1';
process.env.VERIFY_RETRY_DELAYS_MS = '1,1,1';

const assert = require('assert');
const path = require('path');
const lib = (m) => path.join(__dirname, '..', 'lib', `${m}.js`);
const patch = (m, overrides) => {
  const real = require(lib(m));
  require.cache[lib(m)].exports = { ...real, ...overrides };
  return real;
};

// ---------------------------------------------------------------- faux monde
const { SOL_MINT } = require(lib('wallet'));
const TOK = 'TOKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const MEME = 'MEMExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

let world;
function resetWorld() {
  world = {
    phase: new Map(), // wallet -> index de l'etat courant
    states: new Map(), // wallet -> [etats]
    usd: { [SOL_MINT]: 100, [TOK]: 0.1, [MEME]: 1 },
    sigs: new Map(),
    txs: new Map(),
    rpcDown: false,
    transfers: [],
    fees: [],
    records: [],
    logs: [],
  };
}
resetWorld();

function state(slot, sol, { tokens = [], accounts = [] } = {}) {
  return {
    wallet: null,
    timestamp: slot * 400,
    slot,
    native: { lamports: Math.round(sol * 1e9), amount: sol },
    rent: { lamports: 0, amount: 0, accounts: 0 },
    assets: tokens.map(([mint, amount]) => ({ mint, amount, raw: '0', decimals: 6, program: 'spl-token', accounts: 1, addresses: [] })),
    tokenAccounts: accounts.map(([address, mint, rentLamports = 2000000]) => ({
      address, mint, raw: '0', decimals: 6, rentLamports, program: 'spl-token',
    })),
    errors: [],
  };
}

patch('wallet', {
  getWalletSnapshot: async (wallet) => {
    const list = world.states.get(wallet);
    return { ...list[world.phase.get(wallet)], wallet };
  },
});
patch('pricing', {
  getPrices: async (mints) => {
    const prices = new Map();
    for (const m of mints) {
      const v = world.usd[m];
      prices.set(m, v === undefined ? { price: null, status: 'UNPRICED' } : { price: v, status: 'FRESH', ageMs: 0 });
    }
    return { prices, errors: [] };
  },
});
patch('rpc', {
  rpcCall: async (method, params) => {
    if (world.rpcDown) throw new Error('RPC indisponible');
    if (method === 'getSignaturesForAddress') return world.sigs.get(params[0]) || [];
    if (method === 'getTransaction') return world.txs.get(params[0]) || null;
    throw new Error(`methode inattendue ${method}`);
  },
});
patch('escrow', {
  houseTransfer: async (to, amount) => world.transfers.push({ to, amount }),
  payFee: async (fee) => world.fees.push(fee),
  getHouseAddress: () => 'HOUSExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  getFeeWalletAddress: () => 'FEExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
});
patch('db', {
  recordMatchResult: (userId, r) => world.records.push({ userId, ...r }),
  setWalletAddress: () => {},
});
require(lib('matchlog')).MatchLogger.prototype.write = async function () {
  world.logs.push(this.toJSON());
};

const { GameEngine } = require(lib('game'));

// ----------------------------------------------------------- outils de match
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEngine() {
  const emits = [];
  const io = { to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }) };
  const engine = new GameEngine(io);
  const player = (id, userId, name, wallet) => {
    const socket = { id, emitted: [], join() {}, leave() {}, emit(e, p) { this.emitted.push({ e, p }); } };
    const p = { id, socket, userId, name, avatar: null, wallet, isBot: false, queueKey: null, matchId: null };
    engine.players.set(id, p);
    return p;
  };
  return { engine, emits, player };
}

const MARC_W = 'MARCWALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LEA_W = 'LEAWALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const ALT_W = 'ALTWALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

// Marc : perd 10 %, puis s'envoie 0,5 SOL depuis un autre wallet.
// Lea : achete TOK qui prend 20 % : +10 % sur son capital.
function scriptCheatMatch() {
  world.states.set(MARC_W, [state(100, 1), state(200, 0.9), state(300, 1.4)]);
  world.states.set(LEA_W, [
    state(100, 1),
    state(200, 0.498, { tokens: [[TOK, 500]], accounts: [['LEA_ATA', TOK]] }),
    state(300, 0.498, { tokens: [[TOK, 500]], accounts: [['LEA_ATA', TOK]] }),
  ]);
  world.phase.set(MARC_W, 0);
  world.phase.set(LEA_W, 0);
  world.sigs.set(MARC_W, [{ signature: 'marc-deposit', slot: 250, err: null }]);
  world.txs.set('marc-deposit', {
    slot: 250,
    blockTime: 1700000000,
    transaction: {
      signatures: ['marc-deposit'],
      message: {
        accountKeys: [{ pubkey: ALT_W, signer: true }, { pubkey: MARC_W, signer: false }],
        instructions: [
          { program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: ALT_W, destination: MARC_W, lamports: 500000000 } } },
        ],
      },
    },
    meta: { err: null, fee: 5000, preBalances: [2000000000, 900000000], postBalances: [1499995000, 1400000000], preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
  });
}

async function playScript(engine, emits, participants, stakes, { nextPrices } = {}) {
  await engine.createMatch('1v1', '1m', participants, stakes);
  const start = emits.find((e) => e.event === 'matchStart' || e.event === 'matchEnd');
  if (!start || start.event !== 'matchStart') return null;
  const matchId = start.payload.matchId;
  clearInterval(engine.matches.get(matchId).tickTimer);

  for (const phase of [1, 2]) {
    for (const p of participants) world.phase.set(p.wallet, phase);
    if (phase === 2 && nextPrices) Object.assign(world.usd, nextPrices);
    await sleep(3);
    await engine.tickMatch(matchId);
  }
  // Deux fins de match simultanees : les gains ne doivent partir qu'une fois.
  await Promise.all([engine.endMatch(matchId), engine.endMatch(matchId)]);
  return emits.find((e) => e.event === 'matchEnd').payload;
}

const byName = (payload, name) => [...payload.teams[0], ...payload.teams[1]].find((p) => p.name === name);
const letterOf = (payload, name) => (payload.teams[0].some((p) => p.name === name) ? 'A' : 'B');
const recordOf = (userId) => world.records.find((r) => r.userId === userId);

// --------------------------------------------------------------------- tests
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('Match a mise : Marc depose en plein match -> disqualifie, Lea touche le pot', async () => {
  resetWorld();
  scriptCheatMatch();
  const { engine, emits, player } = makeEngine();
  const marc = player('s1', 1, 'Marc', MARC_W);
  const lea = player('s2', 2, 'Lea', LEA_W);
  const end = await playScript(engine, emits, [marc, lea], new Map([['s1', 10], ['s2', 10]]), { nextPrices: { [TOK]: 0.12 } });

  assert.ok(emits.some((e) => e.event === 'matchVerifying'), 'le client doit etre prevenu de la verification');
  assert.strictEqual(end.outcome, 'forfeit');
  assert.strictEqual(end.winner, letterOf(end, 'Lea'));
  assert.strictEqual(byName(end, 'Marc').status, 'disqualified');
  assert.strictEqual(byName(end, 'Marc').pnlPct, -10, 'score recalcule sans le depot');
  assert.strictEqual(byName(end, 'Lea').status, 'clean');
  assert.strictEqual(byName(end, 'Lea').pnlPct, 10);

  assert.deepStrictEqual(world.transfers, [{ to: LEA_W, amount: 17 }], 'un seul paiement, a Lea');
  assert.deepStrictEqual(world.fees, [3]);
  assert.strictEqual(recordOf(1).result, 'loss');
  assert.strictEqual(recordOf(1).verification, 'disqualified');
  assert.strictEqual(recordOf(1).netCash, -10);
  assert.strictEqual(recordOf(2).result, 'win');
  assert.strictEqual(recordOf(2).netCash, 7);

  const log = world.logs[world.logs.length - 1];
  const marcLog = log.players.find((p) => p.name === 'Marc');
  assert.strictEqual(marcLog.verification.status, 'inflows');
  assert.strictEqual(marcLog.verification.inflows[0].from, null);
  assert.ok(marcLog.calculation, 'le detail du calcul doit etre dans le journal');
});

test('Match gratuit : meme depot -> neutralise, pas de disqualification', async () => {
  resetWorld();
  scriptCheatMatch();
  const { engine, emits, player } = makeEngine();
  const marc = player('s1', 1, 'Marc', MARC_W);
  const lea = player('s2', 2, 'Lea', LEA_W);
  const end = await playScript(engine, emits, [marc, lea], null, { nextPrices: { [TOK]: 0.12 } });

  assert.strictEqual(byName(end, 'Marc').status, 'neutralized');
  assert.strictEqual(byName(end, 'Marc').pnlPct, -10);
  assert.strictEqual(end.winner, letterOf(end, 'Lea'));
  assert.strictEqual(world.transfers.length, 0);
  assert.strictEqual(recordOf(1).verification, 'neutralized');
});

test('Match a mise : wallet non conforme au depart -> annule, tout le monde rembourse', async () => {
  resetWorld();
  world.states.set(MARC_W, [state(100, 1, { tokens: [[MEME, 50]] })]); // 0,5 SOL de memecoin
  world.states.set(LEA_W, [state(100, 1)]);
  world.phase.set(MARC_W, 0);
  world.phase.set(LEA_W, 0);
  const { engine, emits, player } = makeEngine();
  const marc = player('s1', 1, 'Marc', MARC_W);
  const lea = player('s2', 2, 'Lea', LEA_W);
  const end = await playScript(engine, emits, [marc, lea], new Map([['s1', 10], ['s2', 10]]));

  assert.strictEqual(end, null, 'le match ne doit pas demarrer');
  assert.deepStrictEqual(
    world.transfers.sort((a, b) => a.to.localeCompare(b.to)),
    [{ to: LEA_W, amount: 10 }, { to: MARC_W, amount: 10 }]
  );
  const marcMsg = marc.socket.emitted.find((x) => x.e === 'cashCancelled');
  assert.match(marcMsg.p.reason, /SOL/);
  assert.strictEqual(engine.matches.size, 0);
  assert.strictEqual(marc.matchId, null);
});

test('Match a mise : verification impossible -> reessais puis remboursement de tous', async () => {
  resetWorld();
  scriptCheatMatch();
  world.sigs.delete(MARC_W);
  const { engine, emits, player } = makeEngine();
  const marc = player('s1', 1, 'Marc', MARC_W);
  const lea = player('s2', 2, 'Lea', LEA_W);
  const origin = engine.closeAndVerify.bind(engine);
  engine.closeAndVerify = async (...args) => {
    world.rpcDown = true;
    return origin(...args);
  };
  const end = await playScript(engine, emits, [marc, lea], new Map([['s1', 10], ['s2', 10]]));

  assert.strictEqual(end.outcome, 'refund');
  assert.strictEqual(world.transfers.length, 2);
  assert.ok(world.transfers.every((t) => t.amount === 10));
  assert.strictEqual(world.fees.length, 0, 'pas de commission sur un match rembourse');
  assert.strictEqual(world.records.length, 0, 'un match non verifie ne compte pas dans les stats');
});

test('Joueur au wallet non conforme en match gratuit -> joue hors classement, stats non touchees', async () => {
  resetWorld();
  world.states.set(MARC_W, [state(100, 1, { tokens: [[MEME, 50]] })]);
  world.states.set(LEA_W, [state(100, 1), state(200, 1), state(300, 1)]);
  world.phase.set(MARC_W, 0);
  world.phase.set(LEA_W, 0);
  const { engine, emits, player } = makeEngine();
  const marc = player('s1', 1, 'Marc', MARC_W);
  const lea = player('s2', 2, 'Lea', LEA_W);
  await engine.createMatch('1v1', '1m', [marc, lea], null);
  const matchId = emits.find((e) => e.event === 'matchStart').payload.matchId;
  clearInterval(engine.matches.get(matchId).tickTimer);
  await engine.endMatch(matchId);
  const end = emits.find((e) => e.event === 'matchEnd').payload;

  assert.strictEqual(byName(end, 'Marc').unranked, true);
  assert.ok(!recordOf(1), 'un score simule ne doit pas entrer dans les stats');
  assert.ok(recordOf(2), 'Lea, elle, est classee');
});

(async () => {
  let passed = 0;
  console.log(`\nMatchs complets a travers le moteur - ${tests.length} tests\n`);
  for (const [i, t] of tests.entries()) {
    try {
      await t.fn();
      console.log(`  ok   ${i + 1}. ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL ${i + 1}. ${t.name}`);
      console.log(`         ${e.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} tests passes\n`);
  process.exit(passed === tests.length ? 0 : 1);
})();
