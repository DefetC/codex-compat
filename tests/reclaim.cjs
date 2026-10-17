// 抢回策略自检：逐条覆盖 healthy / policy-off / external-change / policy-notify-only / throttled / limit-reached / drift-to-original
// 路径约定：本文件位于 tests/，仓库根是上一级
const assert = require('node:assert/strict');
const {
  MIN_INTERVAL_MS,
  MAX_PER_HOUR,
  HOUR_MS,
  evaluate,
  evaluateDrift,
  recordReclaim,
  recordNotify,
  recordHealthy,
} = require('../src/reclaim.cjs');

// 中文注释：固定「当前时间」，避免依赖真实时钟
const NOW = 1700000000000;
// 中文注释：兼容层期望的地址与用户原本的地址
const EXPECTED = 'http://127.0.0.1:15731/v1';
const ORIGINAL = 'http://127.0.0.1:15721/v1';

// 中文注释：常量契约
assert.equal(MIN_INTERVAL_MS, 30 * 1000);
assert.equal(MAX_PER_HOUR, 20);
assert.equal(HOUR_MS, 60 * 60 * 1000);

// 中文注释：reason=healthy —— 地址正常或缺失时不做任何动作
assert.deepEqual(
  evaluate({ currentUrl: EXPECTED, expectedUrl: EXPECTED, now: NOW }),
  { action: 'none', reason: 'healthy' },
);
assert.deepEqual(
  evaluate({ currentUrl: '', expectedUrl: EXPECTED, now: NOW }),
  { action: 'none', reason: 'healthy' },
);

// 中文注释：reason=policy-off —— 策略关闭后即使地址漂移也不动作
assert.deepEqual(
  evaluate({ currentUrl: ORIGINAL, expectedUrl: EXPECTED, originalUrl: ORIGINAL, policy: 'off', now: NOW }),
  { action: 'none', reason: 'policy-off' },
);

// 中文注释：reason=external-change —— 当前地址既不是期望值也不是原值，只通知不改写
assert.deepEqual(
  evaluate({ currentUrl: 'http://other.local/v1', expectedUrl: EXPECTED, originalUrl: ORIGINAL, now: NOW }),
  { action: 'notify', reason: 'external-change' },
);
// 中文注释：已经就本次漂移通知过，则不再重复通知
assert.deepEqual(
  evaluate({
    currentUrl: 'http://other.local/v1',
    expectedUrl: EXPECTED,
    originalUrl: ORIGINAL,
    notifiedForCurrentDrift: true,
    now: NOW,
  }),
  { action: 'none', reason: 'external-change' },
);

// 中文注释：reason=policy-notify-only —— 漂移回原地址但策略只允许通知
assert.deepEqual(
  evaluate({
    currentUrl: ORIGINAL,
    expectedUrl: EXPECTED,
    originalUrl: ORIGINAL,
    policy: 'notify-only',
    now: NOW,
  }),
  { action: 'notify', reason: 'policy-notify-only' },
);
assert.deepEqual(
  evaluate({
    currentUrl: ORIGINAL,
    expectedUrl: EXPECTED,
    originalUrl: ORIGINAL,
    policy: 'notify-only',
    notifiedForCurrentDrift: true,
    now: NOW,
  }),
  { action: 'none', reason: 'policy-notify-only' },
);

// 中文注释：reason=drift-to-original —— 默认 auto 策略下的正常抢回
assert.deepEqual(
  evaluate({ currentUrl: ORIGINAL, expectedUrl: EXPECTED, originalUrl: ORIGINAL, now: NOW }),
  { action: 'reclaim', reason: 'drift-to-original' },
);

// 中文注释：recordReclaim 维护 lastReclaimAt / reclaimCount / 通知标记
const firstReclaim = recordReclaim({ reclaimCount: 0, hourWindowStart: 0, notifiedForCurrentDrift: true }, NOW);
assert.equal(firstReclaim.lastReclaimAt, NOW);
assert.equal(firstReclaim.reclaimCount, 1);
assert.equal(firstReclaim.hourWindowStart, NOW);
assert.equal(firstReclaim.notifiedForCurrentDrift, false);

// 中文注释：reason=throttled —— auto 策略下 30 秒内第二次抢回被节流
const throttledState = {
  currentUrl: ORIGINAL,
  expectedUrl: EXPECTED,
  originalUrl: ORIGINAL,
  policy: 'auto',
  lastReclaimAt: NOW,
  reclaimCount: 1,
  hourWindowStart: NOW,
};
assert.deepEqual(
  evaluate(Object.assign({}, throttledState, { now: NOW + 5 * 1000 })),
  { action: 'none', reason: 'throttled' },
);
// 中文注释：刚好满 30 秒后允许再次抢回
assert.deepEqual(
  evaluate(Object.assign({}, throttledState, { now: NOW + MIN_INTERVAL_MS })),
  { action: 'reclaim', reason: 'drift-to-original' },
);

// 中文注释：reason=limit-reached —— 一小时内达到 20 次上限后只通知
assert.deepEqual(
  evaluate({
    currentUrl: ORIGINAL,
    expectedUrl: EXPECTED,
    originalUrl: ORIGINAL,
    policy: 'auto',
    lastReclaimAt: NOW - MIN_INTERVAL_MS,
    reclaimCount: MAX_PER_HOUR,
    hourWindowStart: NOW - MIN_INTERVAL_MS,
    now: NOW,
  }),
  { action: 'notify', reason: 'limit-reached' },
);
// 中文注释：超过一小时窗口后计数重置，允许继续抢回
assert.deepEqual(
  evaluate({
    currentUrl: ORIGINAL,
    expectedUrl: EXPECTED,
    originalUrl: ORIGINAL,
    policy: 'auto',
    lastReclaimAt: NOW - HOUR_MS - 1,
    reclaimCount: MAX_PER_HOUR,
    hourWindowStart: NOW - HOUR_MS - 1,
    now: NOW,
  }),
  { action: 'reclaim', reason: 'drift-to-original' },
);

// 中文注释：recordReclaim 在窗口过期时重置计数与窗口起点
const expiredWindow = recordReclaim({ reclaimCount: MAX_PER_HOUR, hourWindowStart: NOW - HOUR_MS - 1 }, NOW);
assert.equal(expiredWindow.reclaimCount, 1);
assert.equal(expiredWindow.hourWindowStart, NOW);
// 中文注释：窗口未过期时计数继续累加
const sameWindow = recordReclaim({ reclaimCount: 3, hourWindowStart: NOW - 1000 }, NOW);
assert.equal(sameWindow.reclaimCount, 4);
assert.equal(sameWindow.hourWindowStart, NOW - 1000);

// 中文注释：漂移判定 —— 未漂移 / 策略关闭 / 仅通知 / 节流 / 超限 / 恢复（两类漂移共用同一函数）
assert.deepEqual(evaluateDrift({ drifted: false, now: NOW }), { action: 'none', reason: 'healthy' });
assert.deepEqual(evaluateDrift({ drifted: true, policy: 'off', now: NOW }), { action: 'none', reason: 'policy-off' });
assert.deepEqual(evaluateDrift({ drifted: true, policy: 'notify-only', now: NOW }), { action: 'notify', reason: 'policy-notify-only' });
assert.deepEqual(
  evaluateDrift({ drifted: true, policy: 'notify-only', notifiedForCurrentDrift: true, now: NOW }),
  { action: 'none', reason: 'policy-notify-only' },
);
assert.deepEqual(evaluateDrift({ drifted: true, now: NOW }), { action: 'reclaim', reason: 'mappings-drift' });
// 中文注释：模板拷贝漂移传入自己的原因串，便于日志区分
assert.deepEqual(
  evaluateDrift({ drifted: true, driftReason: 'templates-drift', now: NOW }),
  { action: 'reclaim', reason: 'templates-drift' },
);
assert.deepEqual(
  evaluateDrift({ drifted: true, lastReclaimAt: NOW, reclaimCount: 1, hourWindowStart: NOW, now: NOW + 5 * 1000 }),
  { action: 'none', reason: 'throttled' },
);
assert.deepEqual(
  evaluateDrift({ drifted: true, lastReclaimAt: NOW - MIN_INTERVAL_MS, reclaimCount: MAX_PER_HOUR, hourWindowStart: NOW - MIN_INTERVAL_MS, now: NOW }),
  { action: 'notify', reason: 'limit-reached' },
);
// 中文注释：恢复动作复用同一套节流状态结构
const mappingsReclaim = recordReclaim({ reclaimCount: 0, hourWindowStart: 0, notifiedForCurrentDrift: false }, NOW);
assert.equal(mappingsReclaim.reclaimCount, 1);
assert.equal(mappingsReclaim.lastReclaimAt, NOW);

// 中文注释：recordNotify / recordHealthy 只维护通知标记，不修改其他字段
const notified = recordNotify({ reclaimCount: 2, notifiedForCurrentDrift: false });
assert.equal(notified.notifiedForCurrentDrift, true);
assert.equal(notified.reclaimCount, 2);
const healed = recordHealthy({ reclaimCount: 2, notifiedForCurrentDrift: true });
assert.equal(healed.notifiedForCurrentDrift, false);
assert.equal(healed.reclaimCount, 2);
// 中文注释：状态更新必须返回新对象，不就地修改入参
const base = { reclaimCount: 1, notifiedForCurrentDrift: false };
recordNotify(base);
recordHealthy(base);
recordReclaim(base, NOW);
assert.equal(base.reclaimCount, 1);
assert.equal(base.notifiedForCurrentDrift, false);

console.log('RECLAIM_TEST_PASS');
