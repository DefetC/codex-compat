#!/usr/bin/env node
// 看门狗：监督兼容层进程、同步模型映射、检测并抢回被改走的 base_url。
//
//   进程守护：异常退出后自动重启；连续快速失败则指数退避并最终放弃
//   配置抢回：每 30 秒检查一次 base_url 漂移，策略 auto / notify-only / off
//   映射守护：同期检查模型目录里的提示词注入是否被外部重生成抹掉，同一策略处理
//   单实例：锁文件记录 pid，避免多个看门狗争抢同一个端口
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config.cjs');
const platform = require('./platform.cjs');
const manifest = require('./manifest.cjs');
const codexconfig = require('./codexconfig.cjs');
const reclaim = require('./reclaim.cjs');
const mappings = require('./mappings.cjs');
const templatesLib = require('./templates.cjs');
const files = require('./config-files.cjs');

// 中文注释：命令行参数 --home，用于非默认运行目录
const argv = process.argv.slice(2);
function argValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}
const HOME = argValue('--home') || config.compatHome();
const P = config.paths(HOME);
const ENTRY = path.join(__dirname, 'compat-proxy.cjs');
const WATCH_LOG = path.join(P.logs, 'watchdog.jsonl');
const MAX_LOG_BYTES = 8 * 1024 * 1024;

const MAX_FAST_FAILURES = 10;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
// 中文注释：运行超过该时长视为健康，重置退避计数
const HEALTHY_UPTIME_MS = 30000;
// 中文注释：配置漂移检查间隔
const DRIFT_INTERVAL_MS = 30000;

let child = null;
let stopping = false;
let fastFailures = 0;
let startedAt = 0;
let driftTimer = null;
let driftState = { lastReclaimAt: 0, reclaimCount: 0, hourWindowStart: Date.now(), notifiedForCurrentDrift: false };
// 中文注释：映射漂移状态独立于 base_url 漂移，各自节流、互不占用配额
let mappingsState = { lastReclaimAt: 0, reclaimCount: 0, hourWindowStart: Date.now(), notifiedForCurrentDrift: false };
// 中文注释：模板拷贝（第一跳）漂移状态同样独立
let templatesState = { lastReclaimAt: 0, reclaimCount: 0, hourWindowStart: Date.now(), notifiedForCurrentDrift: false };

// 中文注释：日志超过上限时滚动一次，避免无限增长
function rotateLogIfNeeded() {
  try {
    if (fs.existsSync(WATCH_LOG) && fs.statSync(WATCH_LOG).size > MAX_LOG_BYTES) {
      fs.renameSync(WATCH_LOG, WATCH_LOG + '.1');
    }
  } catch (err) {
    // 中文注释：滚动失败不影响主流程
  }
}

// 中文注释：结构化日志；失败不影响重启逻辑
function log(obj) {
  try {
    fs.mkdirSync(P.logs, { recursive: true });
    rotateLogIfNeeded();
    fs.appendFileSync(WATCH_LOG, JSON.stringify(Object.assign({ ts: new Date().toISOString(), pid: process.pid }, obj)) + '\n');
  } catch (err) {
    // 中文注释：日志写入失败忽略
  }
}

// 中文注释：进程是否仍在运行
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// 中文注释：获取单实例锁；已有存活实例时返回 false
function acquireLock() {
  try {
    fs.mkdirSync(P.run, { recursive: true });
    if (fs.existsSync(P.lockFile)) {
      const raw = fs.readFileSync(P.lockFile, 'utf8').trim();
      const other = parseInt(raw, 10);
      if (!isNaN(other) && other !== process.pid && isAlive(other)) {
        log({ event: 'lock_held', by: other });
        return false;
      }
      log({ event: 'stale_lock', stale: raw });
    }
    fs.writeFileSync(P.lockFile, String(process.pid), 'utf8');
    return true;
  } catch (err) {
    // 中文注释：锁机制失败时保守放行，避免完全无法启动
    return true;
  }
}

// 中文注释：释放锁
function releaseLock() {
  try {
    if (fs.existsSync(P.lockFile) && fs.readFileSync(P.lockFile, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(P.lockFile);
    }
  } catch (err) {
    // 中文注释：忽略
  }
}

// 中文注释：指数退避时长
function backoffMs() {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, Math.min(fastFailures, 6)), MAX_BACKOFF_MS);
}

// 中文注释：启动兼容层子进程
function start() {
  if (stopping) {
    return;
  }
  startedAt = Date.now();
  log({ event: 'spawn', entry: ENTRY });
  // 中文注释：把 --home 传给代理进程，便于按运行目录精确识别与结束进程
  child = spawn(process.execPath, [ENTRY, '--home', HOME], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { CODEX_COMPAT_HOME: HOME }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (data) => log({ event: 'stdout', text: String(data).trim().slice(0, 400) }));
  child.stderr.on('data', (data) => log({ event: 'stderr', text: String(data).trim().slice(0, 400) }));
  child.on('exit', (code, signal) => {
    const uptime = Date.now() - startedAt;
    log({ event: 'exit', code, signal, uptimeMs: uptime });
    child = null;
    if (stopping) {
      return;
    }
    // 中文注释：用户主动暂停时不自动拉起
    if (config.isIntentionalStopped(HOME)) {
      log({ event: 'intentional_stop', action: 'skip_restart' });
      return;
    }
    if (uptime > HEALTHY_UPTIME_MS) {
      fastFailures = 0;
    } else {
      fastFailures++;
    }
    if (fastFailures >= MAX_FAST_FAILURES) {
      log({ event: 'giving_up', fastFailures });
      stopping = true;
      releaseLock();
      process.exit(1);
      return;
    }
    const delay = backoffMs();
    log({ event: 'restart_scheduled', delayMs: delay, fastFailures });
    setTimeout(start, delay);
  });
}

// 中文注释：读取当前 provider 的 base_url，缺失或不可读返回 null
function currentBaseUrl(mf, cfg) {
  try {
    const text = fs.readFileSync(platform.paths(HOME).config, 'utf8');
    const detected = codexconfig.detectProvider(text, {
      providerKey: mf.providerKey,
      expectedUrl: codexconfig.listenUrl(cfg),
    });
    return { text, key: detected.key, url: detected.baseUrl };
  } catch (err) {
    return null;
  }
}

// 中文注释：映射同步的目标 CODEX_HOME；多开实例必须同步到它自己的 CODEX_HOME
function targetCodexHome() {
  try {
    return require('./instances.cjs').instanceCodexHome(HOME) || platform.codexHome();
  } catch (err) {
    return platform.codexHome();
  }
}

// 中文注释：执行一次映射同步；错误不得阻断兼容层启动
function syncMappings() {
  const target = targetCodexHome();
  const result = mappings.apply({ home: target, officialGuard: config.loadSafe({ home: HOME }).cfg.features.officialGuard });
  log({ event: 'mappings_applied', targetCodexHome: target, ...result });
  return result;
}

// 中文注释：执行一次漂移检查；返回本次动作，便于测试与日志
function checkDrift() {
  if (config.isIntentionalStopped(HOME)) {
    return { action: 'none', reason: 'paused' };
  }
  const { cfg, error } = config.loadSafe({ home: HOME });
  if (error) {
    log({ event: 'config_error', message: error });
    return { action: 'none', reason: 'config-error' };
  }
  const mf = (() => {
    try {
      return manifest.read(P.manifestFile);
    } catch (err) {
      return null;
    }
  })();
  if (!mf || !mf.installed || !mf.providerKey || !mf.originalBaseUrl) {
    return { action: 'none', reason: 'not-installed' };
  }
  const current = currentBaseUrl(mf, cfg);
  if (!current) {
    log({ event: 'drift_read_failed' });
    return { action: 'none', reason: 'read-failed' };
  }
  const expectedUrl = codexconfig.listenUrl(cfg);
  const decision = reclaim.evaluate({
    currentUrl: current.url,
    expectedUrl,
    originalUrl: mf.originalBaseUrl.value,
    policy: cfg.service.reclaim,
    lastReclaimAt: driftState.lastReclaimAt,
    reclaimCount: driftState.reclaimCount,
    hourWindowStart: driftState.hourWindowStart,
    notifiedForCurrentDrift: driftState.notifiedForCurrentDrift,
  });

  if (decision.reason === 'healthy') {
    driftState = reclaim.recordHealthy(driftState);
    return decision;
  }
  if (decision.action === 'none' && decision.reason === 'throttled') {
    return decision;
  }
  if (decision.action === 'reclaim') {
    try {
      const next = codexconfig.writeBaseUrl(current.text, mf.providerKey, expectedUrl);
      files.atomicWrite(platform.paths(HOME).config, next, current.text);
      driftState = reclaim.recordReclaim(driftState);
      log({ event: 'reclaim', provider: mf.providerKey, from: current.url, to: expectedUrl });
      platform.notifyAsync('codex-compat 已自动抢回配置', 'Codex 的 base_url 被改回了上游地址，已自动恢复为兼容层。');
      return { action: 'reclaim', reason: decision.reason };
    } catch (err) {
      log({ event: 'reclaim_failed', message: String(err) });
      platform.notifyAsync('codex-compat 抢回失败', '请运行 codex-compat doctor 查看详情。');
      return { action: 'none', reason: 'reclaim-failed' };
    }
  }
  if (decision.action === 'notify') {
    driftState = reclaim.recordNotify(driftState);
    log({ event: 'drift_notice', reason: decision.reason, current: current.url });
    const message = decision.reason === 'external-change'
      ? 'Codex 的 base_url 被改成了未知地址，兼容层未做改动。'
      : (decision.reason === 'limit-reached'
        ? '配置被反复改回上游，已超过自动抢回上限，请检查 CC Switch 设置。'
        : '检测到 base_url 漂移，当前策略为仅通知。');
    platform.notifyAsync('codex-compat 配置提醒', message);
    return decision;
  }
  return decision;
}

// 中文注释：模型目录由 cc-switch 维护，它重新生成目录时会静默抹掉本工具注入的提示词模板，
// 而只在启动时同步一次意味着注入失效后没人知道。这里用无副作用的 dryRun 预演比对，
// 漂移时按 reclaim 策略恢复并通知，策略与节流语义与 base_url 抢回一致。
function checkMappingsDrift() {
  if (config.isIntentionalStopped(HOME)) {
    return { action: 'none', reason: 'paused' };
  }
  const { cfg, error } = config.loadSafe({ home: HOME });
  if (error) {
    return { action: 'none', reason: 'config-error' };
  }
  const mf = (() => {
    try {
      return manifest.read(P.manifestFile);
    } catch (err) {
      return null;
    }
  })();
  if (!mf || !mf.installed) {
    return { action: 'none', reason: 'not-installed' };
  }
  const options = { home: targetCodexHome(), officialGuard: cfg.features.officialGuard };
  let drifted = false;
  try {
    drifted = mappings.apply({ ...options, dryRun: true }).changed === true;
  } catch (err) {
    log({ event: 'mappings_check_failed', message: String(err && err.message || err) });
    return { action: 'none', reason: 'check-failed' };
  }
  const decision = reclaim.evaluateDrift({
    drifted,
    policy: cfg.service.reclaim,
    lastReclaimAt: mappingsState.lastReclaimAt,
    reclaimCount: mappingsState.reclaimCount,
    hourWindowStart: mappingsState.hourWindowStart,
    notifiedForCurrentDrift: mappingsState.notifiedForCurrentDrift,
  });

  if (decision.reason === 'healthy') {
    mappingsState = reclaim.recordHealthy(mappingsState);
    return decision;
  }
  if (decision.action === 'none' && decision.reason === 'throttled') {
    return decision;
  }
  if (decision.action === 'reclaim') {
    try {
      // 中文注释：不传 forceRoles：角色文件被人改过时只恢复模型目录，与启动同步保持一致
      const result = mappings.apply(options);
      mappingsState = reclaim.recordReclaim(mappingsState);
      log({ event: 'mappings_reapplied', reason: decision.reason, changed: result.changed, files: result.files, warnings: result.warnings });
      platform.notifyAsync('codex-compat 已恢复提示词注入', '模型目录里的提示词模板被外部重新生成覆盖，已按映射重新写入。');
      return { action: 'reclaim', reason: decision.reason };
    } catch (err) {
      log({ event: 'mappings_reapply_failed', message: String(err && err.message || err) });
      platform.notifyAsync('codex-compat 提示词注入恢复失败', '请运行 codex-compat repair 查看详情。');
      return { action: 'none', reason: 'reapply-failed' };
    }
  }
  if (decision.action === 'notify') {
    mappingsState = reclaim.recordNotify(mappingsState);
    log({ event: 'mappings_drift_notice', reason: decision.reason });
    const message = decision.reason === 'limit-reached'
      ? '提示词模板被反复覆盖，已超过自动恢复上限，请检查 CC Switch 的模型目录设置。'
      : '检测到提示词模板注入漂移，当前策略为仅通知。';
    platform.notifyAsync('codex-compat 提示词提醒', message);
    return decision;
  }
  return decision;
}

// 中文注释：第一跳漂移：seed() 只落位一次，包内模板后来更新也到不了运行目录，而第二跳读的正是那份拷贝。
// 用无副作用的 dryRun 预演比对，按 service.templateRefresh 策略刷新（被本地改过的永不自动覆盖）或只通知。
function checkTemplateDrift() {
  if (config.isIntentionalStopped(HOME)) {
    return { action: 'none', reason: 'paused' };
  }
  const { cfg, error } = config.loadSafe({ home: HOME });
  if (error) {
    return { action: 'none', reason: 'config-error' };
  }
  let probe;
  try {
    probe = templatesLib.sync({ home: HOME, dryRun: true, pkgVersion: config.version() });
  } catch (err) {
    log({ event: 'templates_check_failed', message: String(err && err.message || err) });
    return { action: 'none', reason: 'check-failed' };
  }
  const decision = reclaim.evaluateDrift({
    drifted: templatesLib.drifted(probe) || probe.written.length > 0,
    policy: cfg.service.templateRefresh,
    driftReason: 'templates-drift',
    lastReclaimAt: templatesState.lastReclaimAt,
    reclaimCount: templatesState.reclaimCount,
    hourWindowStart: templatesState.hourWindowStart,
    notifiedForCurrentDrift: templatesState.notifiedForCurrentDrift,
  });

  if (decision.reason === 'healthy') {
    templatesState = reclaim.recordHealthy(templatesState);
    return decision;
  }
  if (decision.action === 'none') {
    return decision;
  }
  // 中文注释：本地改过的文件按设计永不自动覆盖（dryRun 的 written 为空说明没有可自动刷新的东西），
  // 这类漂移只能通知一次、等人工决定：既不反复写空，也不每 30 秒刷屏（状态恢复健康后才允许再提醒）。
  if (decision.action === 'reclaim' && probe.written.length === 0) {
    if (templatesState.notifiedForCurrentDrift) {
      return { action: 'none', reason: 'needs-human-notified' };
    }
    templatesState = reclaim.recordNotify(templatesState);
    log({ event: 'templates_drift_notice', reason: 'needs-human', outdated: probe.outdated, edited: probe.edited, blocked: probe.blocked });
    platform.notifyAsync('codex-compat 模板需要人工处理', templatesLib.describe(probe));
    return { action: 'notify', reason: 'needs-human' };
  }
  if (decision.action === 'reclaim') {
    try {
      const done = templatesLib.sync({ home: HOME, policy: 'auto', pkgVersion: config.version() });
      templatesState = reclaim.recordReclaim(templatesState);
      log({ event: 'templates_refreshed', reason: decision.reason, written: done.written, adopted: done.adopted, skipped: done.edited, changeId: done.changeId, backup: done.backup });
      platform.notifyAsync('codex-compat 已刷新提示词模板', templatesLib.describe(done));
      return { action: 'reclaim', reason: decision.reason };
    } catch (err) {
      log({ event: 'templates_refresh_failed', message: String(err && err.message || err) });
      platform.notifyAsync('codex-compat 模板刷新失败', '请运行 codex-compat repair --refresh-templates 查看详情。');
      return { action: 'none', reason: 'refresh-failed' };
    }
  }
  if (decision.action === 'notify') {
    templatesState = reclaim.recordNotify(templatesState);
    log({ event: 'templates_drift_notice', reason: decision.reason, outdated: probe.outdated, edited: probe.edited });
    const message = decision.reason === 'limit-reached'
      ? '模板刷新过于频繁，已改为只提醒；请检查运行目录里的模板文件。'
      : '包内模板有更新，当前策略为手动刷新（菜单「模板自动刷新」可改为自动）。';
    platform.notifyAsync('codex-compat 模板提醒', message);
    return decision;
  }
  return decision;
}

// 中文注释：启动周期性漂移检查
function startDriftMonitor() {
  if (driftTimer) {
    return;
  }
  driftTimer = setInterval(() => {
    try {
      checkDrift();
    } catch (err) {
      log({ event: 'drift_error', message: String(err) });
    }
    try {
      checkMappingsDrift();
    } catch (err) {
      log({ event: 'mappings_drift_error', message: String(err) });
    }
    try {
      checkTemplateDrift();
    } catch (err) {
      log({ event: 'templates_drift_error', message: String(err) });
    }
  }, DRIFT_INTERVAL_MS);
  driftTimer.unref();
}

// 中文注释：优雅退出
function shutdown(signal) {
  stopping = true;
  log({ event: 'shutdown', signal });
  if (driftTimer) {
    clearInterval(driftTimer);
    driftTimer = null;
  }
  if (child) {
    try {
      child.kill();
    } catch (err) {
      // 中文注释：进程可能已退出
    }
  }
  releaseLock();
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => releaseLock());

if (require.main === module) {
  // 中文注释：处于「有意停止」状态时安静退出，避免守护反复拉起
  if (config.isIntentionalStopped(HOME)) {
    log({ event: 'intentional_stop', action: 'exit' });
    process.exit(0);
  }
  // 中文注释：取不到锁说明已有实例在跑，安静退出
  if (!acquireLock()) {
    process.exit(0);
  }
  log({ event: 'watchdog_started', home: HOME });

  // 中文注释：启动时同步映射；错误不得阻断兼容层启动
  try {
    syncMappings();
  } catch (err) {
    console.error('[watchdog] 映射同步失败', err);
    log({ event: 'mappings_failed', message: String(err && err.message || err) });
  }

  // 中文注释：启动时也把第一跳（包内模板 → 运行目录）按策略同步一次；同样不得阻断启动
  try {
    const policy = config.loadSafe({ home: HOME }).cfg.service.templateRefresh;
    const result = templatesLib.sync({ home: HOME, policy, pkgVersion: config.version() });
    log({ event: 'templates_synced', policy, written: result.written, adopted: result.adopted, skipped: result.edited, changeId: result.changeId });
  } catch (err) {
    console.error('[watchdog] 模板同步失败', err);
    log({ event: 'templates_sync_failed', message: String(err && err.message || err) });
  }

  start();
  startDriftMonitor();
}

module.exports = { checkDrift, checkMappingsDrift, checkTemplateDrift, startDriftMonitor, HOME, P };
