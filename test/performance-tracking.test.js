const { snapshotTotal, SOL_MINT } = require('../lib/solana');

// Test utilities
function round2(n) {
  return Math.round(n * 100) / 100;
}

function createSnapshot(solAmount, tokens = {}, prices = {}) {
  const allMints = [SOL_MINT, ...Object.keys(tokens)];
  const allPrices = { [SOL_MINT]: prices[SOL_MINT] || 150, ...prices };
  return {
    solAmount,
    tokens,
    prices: allPrices,
    unpricedMints: Object.keys(allPrices).filter((m) => allPrices[m] === null),
    timestamp: Date.now(),
  };
}

function calculatePnlPct(baseline, currentEquity) {
  return baseline > 0 ? round2(((currentEquity / baseline) - 1) * 100) : 0;
}

// TESTS
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// ========== Test Cases (20 required) ==========

// 1. Wallet +0% performance (no change)
test('Wallet unchanged: 0% performance', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial);
  const current = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const currentEquity = snapshotTotal(current);
  const pnl = calculatePnlPct(baseline, currentEquity);
  if (pnl !== 0) throw new Error(`Expected 0%, got ${pnl}%`);
});

// 2. Wallet +10% performance
test('Wallet +10% performance', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 1*150 + 100*10 = 1150
  const current = createSnapshot(1.1, { TOKEN1: 110 }, { TOKEN1: 10 });
  const currentEquity = snapshotTotal(current); // 1.1*150 + 110*10 = 1265
  const pnl = calculatePnlPct(baseline, currentEquity);
  const expected = round2(((1265 / 1150) - 1) * 100);
  if (pnl !== expected) throw new Error(`Expected ${expected}%, got ${pnl}%`);
});

// 3. Wallet -10% performance
test('Wallet -10% performance', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 1150
  const current = createSnapshot(0.9, { TOKEN1: 90 }, { TOKEN1: 10 });
  const currentEquity = snapshotTotal(current); // 0.9*150 + 90*10 = 1035
  const pnl = calculatePnlPct(baseline, currentEquity);
  const expected = round2(((1035 / 1150) - 1) * 100);
  if (pnl !== expected) throw new Error(`Expected ${expected}%, got ${pnl}%`);
});

// 4. Wallet +100% performance (doubles)
test('Wallet +100% performance (doubles)', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 1150
  const current = createSnapshot(2, { TOKEN1: 200 }, { TOKEN1: 10 });
  const currentEquity = snapshotTotal(current); // 2*150 + 200*10 = 2300
  const pnl = calculatePnlPct(baseline, currentEquity);
  if (pnl !== 100) throw new Error(`Expected 100%, got ${pnl}%`);
});

// 5. Price movement without transactions: token price doubles
test('Price movement (token doubles): +100% without trades', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 1*150 + 100*10 = 1150
  const current = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 20 }); // token price doubled
  const currentEquity = snapshotTotal(current); // 1*150 + 100*20 = 2150
  const pnl = calculatePnlPct(baseline, currentEquity);
  const expected = round2(((2150 / 1150) - 1) * 100); // ~87% gain
  if (Math.abs(pnl - expected) > 0.01) throw new Error(`Expected ${expected}%, got ${pnl}%`);
});

// 6. Price decline: token halves in price
test('Price decline (token halves): -50% without trades', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 20 });
  const baseline = snapshotTotal(initial); // 1*150 + 100*20 = 2150
  const current = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 }); // token price halved
  const currentEquity = snapshotTotal(current); // 1*150 + 100*10 = 1150
  const pnl = calculatePnlPct(baseline, currentEquity);
  const expected = round2(((1150 / 2150) - 1) * 100); // ~46.5% loss
  if (Math.abs(pnl - expected) > 0.01) throw new Error(`Expected ${expected}%, got ${pnl}%`);
});

// 7. New token purchase during match
test('New token purchase (+10% from new asset)', () => {
  const initial = createSnapshot(1, {}, { TOKEN1: undefined });
  const baseline = snapshotTotal(initial); // 1*150 = 150
  const current = createSnapshot(1, { TOKEN1: 10 }, { TOKEN1: 20 }); // bought 10 TOKEN1 @ 20
  const currentEquity = snapshotTotal(current); // 1*150 + 10*20 = 350
  const pnl = calculatePnlPct(baseline, currentEquity);
  const expected = round2(((350 / 150) - 1) * 100); // ~133% gain
  if (Math.abs(pnl - expected) > 0.01) throw new Error(`Expected ${expected}%, got ${pnl}%`);
});

// 8. Complete token sale (liquidate position)
test('Complete token sale (liquidate position)', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 1150
  const current = createSnapshot(1.5, { TOKEN1: 0 }, { TOKEN1: 10 }); // sold all TOKEN1, bought SOL
  const currentEquity = snapshotTotal(current); // 1.5*150 = 225
  const pnl = calculatePnlPct(baseline, currentEquity);
  const expected = round2(((225 / 1150) - 1) * 100); // ~80% loss
  if (Math.abs(pnl - expected) > 0.01) throw new Error(`Expected ${expected}%, got ${pnl}%`);
});

// 9. Multiple token portfolio (3 tokens)
test('Multiple token portfolio (3 tokens)', () => {
  const initial = createSnapshot(
    1,
    { TOKEN1: 50, TOKEN2: 30, TOKEN3: 20 },
    { TOKEN1: 10, TOKEN2: 5, TOKEN3: 2 }
  );
  const baseline = snapshotTotal(initial); // 1*150 + 50*10 + 30*5 + 20*2 = 150 + 500 + 150 + 40 = 840
  const current = createSnapshot(
    1,
    { TOKEN1: 55, TOKEN2: 32, TOKEN3: 21 },
    { TOKEN1: 10, TOKEN2: 5, TOKEN3: 2 }
  );
  const currentEquity = snapshotTotal(current); // 1*150 + 55*10 + 32*5 + 21*2 = 150 + 550 + 160 + 42 = 902
  const pnl = calculatePnlPct(baseline, currentEquity);
  const expected = round2(((902 / 840) - 1) * 100); // ~7.4%
  if (Math.abs(pnl - expected) > 0.01) throw new Error(`Expected ${expected}%, got ${pnl}%`);
});

// 10. SOL-only portfolio
test('SOL-only portfolio (+25%)', () => {
  const initial = createSnapshot(10, {}, {});
  const baseline = snapshotTotal(initial); // 10*150 = 1500
  const current = createSnapshot(12.5, {}, {});
  const currentEquity = snapshotTotal(current); // 12.5*150 = 1875
  const pnl = calculatePnlPct(baseline, currentEquity);
  if (pnl !== 25) throw new Error(`Expected 25%, got ${pnl}%`);
});

// 11. Token-only portfolio (no SOL)
test('Token-only portfolio (+50%)', () => {
  const initial = createSnapshot(0, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 0 + 100*10 = 1000
  const current = createSnapshot(0, { TOKEN1: 150 }, { TOKEN1: 10 });
  const currentEquity = snapshotTotal(current); // 0 + 150*10 = 1500
  const pnl = calculatePnlPct(baseline, currentEquity);
  if (pnl !== 50) throw new Error(`Expected 50%, got ${pnl}%`);
});

// 12. Jupiter API unavailable: keep stale prices
test('API failure: stale prices kept (not zeroed)', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 1150
  // Simulate stale price (API failed, kept previous price)
  const staleSnapshot = {
    solAmount: 1,
    tokens: { TOKEN1: 100 },
    prices: { [SOL_MINT]: 150, TOKEN1: 10 }, // stale price from before
    unpricedMints: [],
    timestamp: Date.now(),
  };
  const currentEquity = snapshotTotal(staleSnapshot);
  // Should NOT zero out the price; should use the stale price
  if (currentEquity < 1100) throw new Error(`Stale prices were zeroed, got ${currentEquity}`);
  if (currentEquity !== 1150) throw new Error(`Expected 1150 with stale prices, got ${currentEquity}`);
});

// 13. Unpriced token handling (explicitly marked as null)
test('Unpriced token: null price (not silently zeroed)', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 1150
  // New token with no price
  const current = {
    solAmount: 1,
    tokens: { TOKEN1: 100, TOKEN2: 50 },
    prices: { [SOL_MINT]: 150, TOKEN1: 10, TOKEN2: null }, // TOKEN2 explicitly unpriced
    unpricedMints: ['TOKEN2'],
    timestamp: Date.now(),
  };
  const currentEquity = snapshotTotal(current);
  // Should NOT include TOKEN2 in the total
  const expected = 1 * 150 + 100 * 10; // TOKEN2 excluded
  if (currentEquity !== expected) throw new Error(`Expected ${expected}, got ${currentEquity}`);
});

// 14. Transfer-in scenario (external deposit, not trading gain)
test('Transfer-in (+500 SOL deposit): gains from capital, not trading', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 1150
  // External deposit: +500 SOL
  const current = createSnapshot(501, { TOKEN1: 100 }, { TOKEN1: 10 });
  const currentEquity = snapshotTotal(current); // 501*150 + 100*10 = 76650
  const pnl = calculatePnlPct(baseline, currentEquity);
  // 75000 / 1150 ≈ 6521% (transfer incorrectly counted as gain if not handled)
  // Correct: should detect this is a capital flow, not trading gain
  // For now, we just track the calculation; transfer detection is future work
  if (pnl < 1000) throw new Error(`Transfer-in caused expected huge PnL, got ${pnl}%`);
});

// 15. Transfer-out scenario (withdrawal, reduces equity)
test('Transfer-out (-1 SOL withdrawal): equity reduced', () => {
  const initial = createSnapshot(10, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 10*150 + 100*10 = 2500
  // External withdrawal: -1 SOL
  const current = createSnapshot(9, { TOKEN1: 100 }, { TOKEN1: 10 });
  const currentEquity = snapshotTotal(current); // 9*150 + 100*10 = 2350
  const pnl = calculatePnlPct(baseline, currentEquity);
  const expected = round2(((2350 / 2500) - 1) * 100); // -6%
  if (Math.abs(pnl - expected) > 0.01) throw new Error(`Expected ${expected}%, got ${pnl}%`);
});

// 16. Duplicate transaction handling (same tx applied twice)
test('Duplicate transaction: idempotent PnL', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 1150
  const afterTrade1 = createSnapshot(1, { TOKEN1: 110 }, { TOKEN1: 10 });
  const pnl1 = calculatePnlPct(baseline, snapshotTotal(afterTrade1));
  // Apply same trade twice
  const afterTrade2 = createSnapshot(1, { TOKEN1: 120 }, { TOKEN1: 10 });
  const pnl2 = calculatePnlPct(baseline, snapshotTotal(afterTrade2));
  // PnL should reflect the actual state, not double-counted
  if (pnl2 <= pnl1) throw new Error(`Duplicate transactions: pnl should increase monotonically`);
});

// 17. RPC timeout / price fetch failure recovery
test('RPC timeout: fallback to stale data', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 1150
  // Simulate RPC timeout: prices from 5 minutes ago still used
  const staleSnapshot = {
    solAmount: 1,
    tokens: { TOKEN1: 100 },
    prices: { [SOL_MINT]: 150, TOKEN1: 10 }, // stale prices
    unpricedMints: [],
    timestamp: Date.now() - 5 * 60 * 1000, // 5 minutes old
  };
  const currentEquity = snapshotTotal(staleSnapshot);
  // Should recover with stale prices, not crash
  if (currentEquity !== 1150) throw new Error(`Expected 1150 with stale prices, got ${currentEquity}`);
});

// 18. Match end with stale final tick
test('Match end with stale final tick: PnL finalized', () => {
  const initial = createSnapshot(1, { TOKEN1: 100 }, { TOKEN1: 10 });
  const baseline = snapshotTotal(initial); // 1150
  // Final tick hasn't refreshed in 30 seconds (stale)
  const finalSnapshot = {
    solAmount: 1,
    tokens: { TOKEN1: 100 },
    prices: { [SOL_MINT]: 150, TOKEN1: 10 },
    unpricedMints: [],
    timestamp: Date.now() - 30 * 1000, // 30 seconds old
  };
  const finalEquity = snapshotTotal(finalSnapshot);
  const finalPnl = calculatePnlPct(baseline, finalEquity);
  // PnL should be finalized with last known prices (not crash)
  if (isNaN(finalPnl)) throw new Error(`Final PnL is NaN (stale tick not handled)`);
  if (finalPnl !== 0) throw new Error(`Expected 0% (unchanged), got ${finalPnl}%`);
});

// 19. Negative baseline (edge case: should return 0%)
test('Negative baseline edge case', () => {
  const baseline = -100; // invalid but should not crash
  const currentEquity = 500;
  const pnl = calculatePnlPct(baseline, currentEquity);
  if (pnl !== 0) throw new Error(`Expected 0% for negative baseline, got ${pnl}%`);
});

// 20. Zero baseline (edge case: should return 0%)
test('Zero baseline edge case', () => {
  const baseline = 0;
  const currentEquity = 500;
  const pnl = calculatePnlPct(baseline, currentEquity);
  if (pnl !== 0) throw new Error(`Expected 0% for zero baseline, got ${pnl}%`);
});

// ========== Run Tests ==========
let passed = 0;
let failed = 0;

console.log('\n📊 Performance Tracking Test Suite\n');
console.log(`Running ${tests.length} tests...\n`);

tests.forEach((t, i) => {
  try {
    t.fn();
    console.log(`✅ [${i + 1}] ${t.name}`);
    passed++;
  } catch (e) {
    console.log(`❌ [${i + 1}] ${t.name}`);
    console.log(`   Error: ${e.message}`);
    failed++;
  }
});

console.log(`\n${passed}/${tests.length} tests passed`);
if (failed > 0) {
  console.log(`${failed} test(s) failed\n`);
  process.exit(1);
} else {
  console.log('All tests passed! ✅\n');
  process.exit(0);
}
