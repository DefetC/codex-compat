// 配置抢回策略（纯函数）：判断 base_url 漂移后应该抢回、仅通知还是不动。

// 中文注释：默认节流参数
const MIN_INTERVAL_MS = 30 * 1000;
const MAX_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

// 中文注释：根据当前地址与策略给出动作
function evaluate(state) {
  const {
    currentUrl,
    expectedUrl,
    originalUrl,
    policy = 'auto',
    lastReclaimAt = 0,
    reclaimCount = 0,
    hourWindowStart = 0,
    notifiedForCurrentDrift = false,
    now = Date.now(),
  } = state;

  if (!currentUrl || currentUrl === expectedUrl) {
    return { action: 'none', reason: 'healthy' };
  }
  if (policy === 'off') {
    return { action: 'none', reason: 'policy-off' };
  }
  const isOriginal = !!originalUrl && currentUrl === originalUrl;
  if (!isOriginal) {
    return { action: notifiedForCurrentDrift ? 'none' : 'notify', reason: 'external-change' };
  }
  if (policy === 'notify-only') {
    return { action: notifiedForCurrentDrift ? 'none' : 'notify', reason: 'policy-notify-only' };
  }
  if (now - lastReclaimAt < MIN_INTERVAL_MS) {
    return { action: 'none', reason: 'throttled' };
  }
  if (reclaimCount >= MAX_PER_HOUR && now - hourWindowStart < HOUR_MS) {
    return { action: 'notify', reason: 'limit-reached' };
  }
  return { action: 'reclaim', reason: 'drift-to-original' };
}

// 中文注释：通用漂移动作判定，服务于两类漂移：目录注入（mappings）与模板拷贝（templates）。
// auto 先恢复再通知，notify-only 只通知，off 不动作；节流参数共用，但两类漂移各自持有状态，互不占配额。
function evaluateDrift(state) {
  const {
    drifted = false,
    policy = 'auto',
    driftReason = 'mappings-drift',
    lastReclaimAt = 0,
    reclaimCount = 0,
    hourWindowStart = 0,
    notifiedForCurrentDrift = false,
    now = Date.now(),
  } = state;

  if (!drifted) {
    return { action: 'none', reason: 'healthy' };
  }
  if (policy === 'off') {
    return { action: 'none', reason: 'policy-off' };
  }
  if (policy === 'notify-only') {
    return { action: notifiedForCurrentDrift ? 'none' : 'notify', reason: 'policy-notify-only' };
  }
  if (now - lastReclaimAt < MIN_INTERVAL_MS) {
    return { action: 'none', reason: 'throttled' };
  }
  if (reclaimCount >= MAX_PER_HOUR && now - hourWindowStart < HOUR_MS) {
    return { action: 'notify', reason: 'limit-reached' };
  }
  return { action: 'reclaim', reason: driftReason };
}

// 中文注释：抢回成功后更新统计状态
function recordReclaim(state, now = Date.now()) {
  const next = Object.assign({}, state);
  if (!next.hourWindowStart || now - next.hourWindowStart >= HOUR_MS) {
    next.hourWindowStart = now;
    next.reclaimCount = 0;
  }
  next.lastReclaimAt = now;
  next.reclaimCount = (next.reclaimCount || 0) + 1;
  next.notifiedForCurrentDrift = false;
  return next;
}

// 中文注释：记录已就当前漂移发过通知，避免刷屏
function recordNotify(state) {
  return Object.assign({}, state, { notifiedForCurrentDrift: true });
}

// 中文注释：漂移恢复后重置通知标记
function recordHealthy(state) {
  return Object.assign({}, state, { notifiedForCurrentDrift: false });
}

module.exports = { MIN_INTERVAL_MS, MAX_PER_HOUR, HOUR_MS, evaluate, evaluateDrift, recordReclaim, recordNotify, recordHealthy };
