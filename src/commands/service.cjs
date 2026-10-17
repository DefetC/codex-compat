// 服务控制：start / pause / stop / restart / status。
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config.cjs');
const platform = require('../platform.cjs');

// 中文注释：路径比较；Windows 不区分大小写，其余平台按原样
function samePath(left, right) {
  if (!left || !right) {
    return false;
  }
  const norm = (value) => {
    const resolved = path.resolve(String(value)).replace(/\\/g, '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(left) === norm(right);
}
const ports = require('../ports.cjs');
const manifestLib = require('../manifest.cjs');
const codexconfig = require('../codexconfig.cjs');
const ccswitch = require('../ccswitch.cjs');
const processes = require('../processes.cjs');
const { waitForHealth } = require('./install.cjs');

// 中文注释：写入/清除「有意停止」标记，避免守护反复拉起
function setHold(home, enabled) {
  return config.setIntentionalStop(home, enabled);
}

// 中文注释：状态查询
async function status(opts = {}) {
  const cfg = config.loadSafe({ home: opts.home }).cfg;
  const probe = await ports.probeCompat(cfg.listen.host, cfg.listen.port);
  // 中文注释：健康端点会带回自己的运行目录；home 不一致说明这个端口属于别的实例，
  // 不能算作「当前运行目录健康」，否则会掩盖本实例其实没起来的事实
  const healthHome = (probe.data && probe.data.home) || null;
  const healthOwnHome = !!(probe.ours && healthHome && samePath(healthHome, cfg.home));
  const healthText = healthOwnHome
    ? '正常（' + (probe.data.version || '?') + '）'
    : (probe.ours
      ? (healthHome ? '端口被另一个实例占用（运行目录 ' + healthHome + '）' : '正常（对端未上报运行目录）')
      : (probe.ours === false ? '未响应' : '未知'));
  const service = platform.serviceStatus();
  const guard = platform.guardStatus();
  let mf = null;
  try {
    mf = manifestLib.read(config.paths(cfg.home).manifestFile);
  } catch (err) {
    mf = null;
  }
  let currentUrl = null;
  let configError = null;
  try {
    const text = fs.readFileSync(path.join(platform.codexHome(), 'config.toml'), 'utf8');
    currentUrl = codexconfig.detectProvider(text, { providerKey: mf && mf.providerKey }).baseUrl;
  } catch (err) {
    configError = String(err && err.message || err);
  }
  const cc = ccswitch.detect();
  const expected = codexconfig.listenUrl(cfg);
  const drift = currentUrl === expected ? '正常' : (currentUrl ? '已漂移（当前 ' + currentUrl + '）' : '未知');
  const lines = [
    'codex-compat 状态',
    '  版本           : ' + config.version(),
    '  运行目录       : ' + cfg.home,
    '  监听地址       : http://' + cfg.listen.host + ':' + cfg.listen.port,
    '  健康检查       : ' + healthText,
    '  上游           : ' + cfg.upstream.host + ':' + cfg.upstream.port + (cfg.upstream.basePath || ''),
    '  Codex base_url : ' + (currentUrl || '（读取失败：' + configError + '）'),
    '  配置一致性     : ' + drift,
    '  常驻服务       : ' + service.detail,
    '  守护任务       : ' + guard.detail,
    '  抢回策略       : ' + cfg.service.reclaim,
    '  DeepSeek 优化  : 提示词=' + (cfg.features.deepseekPrompt ? '开' : '关') + '，子代理角色=' + (cfg.features.deepseekRoles ? '开' : '关'),
    '  CC Switch      : ' + ccswitch.describe(cc),
  ];
  if (mf) {
    lines.push('  安装清单       : ' + mf.installedAt + '（原始 base_url：' + (mf.originalBaseUrl ? mf.originalBaseUrl.value : '未记录') + '）');
  } else {
    lines.push('  安装清单       : 未找到（可能尚未安装）');
  }
  // 中文注释：--verbose 追加路径与原始探测结果
  if (opts.verbose) {
    lines.push('', '详细信息（--verbose）：');
    lines.push('  配置文件       : ' + config.paths(cfg.home).configFile);
    lines.push('  安装清单       : ' + config.paths(cfg.home).manifestFile);
    lines.push('  日志目录       : ' + config.paths(cfg.home).logs);
    lines.push('  映射文件       : ' + config.paths(cfg.home).mappingFile);
    lines.push('  CC Switch 原始 : ' + JSON.stringify(cc));
    lines.push('  健康检查原始   : ' + JSON.stringify(probe.data || null));
  }
  return { ok: true, code: 'status', lines, status: { cfg, health: probe.data || null, healthOwnHome, service, guard, currentUrl, expected, manifest: mf, ccswitch: cc } };
}

// 中文注释：启动或恢复
async function start(opts = {}) {
  const cfg = config.loadSafe({ home: opts.home }).cfg;
  setHold(cfg.home, false);
  const lines = [];
  let service = { ok: true, detail: '未启用自启' };
  let guard = { ok: true, detail: '未启用守护' };
  if (cfg.service.autoStart) {
    service = platform.installService({ cfg });
    lines.push('常驻服务：' + service.detail);
    if (cfg.service.guard) {
      guard = platform.registerGuard({ cfg });
      lines.push('守护任务：' + guard.detail);
    }
  } else {
    lines.push('配置未启用自启，直接以后台进程启动（codex-compat config set service.autoStart true 可开启自启）');
    service = platform.startWatchdogDetached(cfg.home);
  }
  let health = await waitForHealth(cfg.listen.host, cfg.listen.port, 12000, cfg.home);
  if (!health) {
    platform.startWatchdogDetached(cfg.home);
    health = await waitForHealth(cfg.listen.host, cfg.listen.port, 8000, cfg.home);
  }
  lines.push('健康检查：' + (health ? '正常（端口 ' + health.port + ' → ' + health.upstreamPort + '）' : '未通过，请运行 codex-compat doctor'));
  return { ok: !!health, code: health ? 'started' : 'start-failed', lines, message: health ? '已启动' : '启动失败', health };
}

// 中文注释：临时暂停（保留自启注册，下次登录或手动 start 恢复）
async function pause(opts = {}) {
  const cfg = config.loadSafe({ home: opts.home }).cfg;
  setHold(cfg.home, true);
  const result = await processes.killInstance(platform.paths(cfg.home).root, cfg.home);
  const probe = await ports.probeCompat(cfg.listen.host, cfg.listen.port, 800);
  // 中文注释：端口上若是别的运行目录的实例，不算本实例的残留，也不能当作「已释放」
  const foreign = !!(probe.ours && probe.data && probe.data.home && !samePath(probe.data.home, cfg.home));
  const alive = !!(probe.ours && !foreign);
  const ok = result.remaining.length === 0;
  const lines = [
    '已暂停兼容层，保留自启注册（下次登录仍会启动）。',
    '  结束进程：' + (result.killed.length ? result.killed.join(', ') : '无'),
    '  残留进程：' + (result.remaining.length ? result.remaining.join(', ') + '（未能结束，请检查权限）' : '无'),
    '  端口 ' + cfg.listen.port + '：' + (foreign
      ? '由另一个实例占用（运行目录 ' + probe.data.home + '），未处理'
      : (alive ? '仍在监听（可能有残留进程）' : '已释放')),
    '  恢复方式：codex-compat start',
  ];
  return { ok: ok && !alive, code: ok ? 'paused' : 'pause-incomplete', lines, killed: result.killed, remaining: result.remaining };
}

// 中文注释：完全停止并取消自启
async function stop(opts = {}) {
  const paused = await pause(opts);
  const guard = platform.unregisterGuard();
  const service = platform.uninstallService();
  return {
    ok: paused.ok,
    code: 'stopped',
    lines: paused.lines.concat(['', '守护任务：' + guard.detail, '常驻服务：' + service.detail, '已取消自启。重新启用：codex-compat start']),
  };
}

// 中文注释：重启
async function restart(opts = {}) {
  const stopped = await stop(opts);
  const started = await start(opts);
  return { ok: started.ok, code: 'restarted', lines: stopped.lines.concat([''], started.lines) };
}

module.exports = { status, start, pause, stop, restart, setHold, listProcesses: processes.listProcesses };
