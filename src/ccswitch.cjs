// CC Switch 探测：判断本地代理是否开启、Codex 是否处于接管模式、监听地址与端口。
//
// 数据来源（按可靠性排序）：
//   1. live-state.json  apps.codex.mode / attached
//   2. settings.json    enableLocalProxy
//   3. cc-switch.db     proxy_config（仅 Node >= 22 可用，失败自动降级）
//   4. 端口探测（由调用方完成）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 中文注释：CC Switch 数据目录，可用 CC_SWITCH_HOME 覆盖
function ccSwitchHome() {
  return process.env.CC_SWITCH_HOME || path.join(os.homedir(), '.cc-switch');
}

// 中文注释：安全读取 JSON，损坏或缺失返回 null
function readJson(file) {
  try {
    if (!fs.existsSync(file)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

// 中文注释：从 SQLite 读取代理配置；仅 Node >= 22 支持，且不向用户输出实验性告警
function readProxyConfig(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  let sqlite = null;
  const originalEmitWarning = process.emitWarning;
  try {
    process.emitWarning = () => {};
    sqlite = require('node:sqlite');
  } catch (err) {
    return null;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  let db = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const row = db.prepare("select app_type, proxy_enabled, listen_address, listen_port, enabled from proxy_config where app_type = 'codex' limit 1").get();
    if (!row) {
      return null;
    }
    return {
      appType: row.app_type,
      proxyEnabled: !!row.proxy_enabled,
      listenAddress: row.listen_address || null,
      listenPort: Number.isInteger(row.listen_port) ? row.listen_port : null,
      enabled: !!row.enabled,
    };
  } catch (err) {
    return null;
  } finally {
    try {
      if (db) {
        db.close();
      }
    } catch (err) {
      // 中文注释：关闭失败不影响探测结果
    }
  }
}

// 中文注释：汇总探测结果；mode 为 proxy 且 attached 为 true 才算接管生效
function detect() {
  const home = ccSwitchHome();
  const settings = readJson(path.join(home, 'settings.json'));
  const live = readJson(path.join(home, 'live-state.json'));
  const dbProxy = readProxyConfig(path.join(home, 'cc-switch.db'));
  const app = live && live.apps && live.apps.codex ? live.apps.codex : null;
  const mode = app && typeof app.mode === 'string' ? app.mode : null;
  const attached = !!(app && app.attached);
  const installed = !!(settings || live || dbProxy || fs.existsSync(home));
  const listenHost = (dbProxy && dbProxy.listenAddress) || '127.0.0.1';
  const listenPort = (dbProxy && dbProxy.listenPort) || 15721;
  return {
    installed,
    home,
    localProxyEnabled: settings ? settings.enableLocalProxy !== false : null,
    mode,
    attached,
    // 中文注释：live-state.json 使用 snake_case（proxy_route），同时兼容驼峰写法
    proxyRoute: app ? (app.proxy_route || app.proxyRoute || null) : null,
    dbProxy,
    listenHost,
    listenPort,
    takingOver: mode === 'proxy' && attached,
  };
}

// 中文注释：把探测结果转成面向用户的一行结论
function describe(result) {
  if (!result.installed) {
    return '未检测到 CC Switch（可使用自定义上游）';
  }
  if (result.takingOver) {
    return 'CC Switch 已开启本地代理并接管 Codex（' + result.listenHost + ':' + result.listenPort + '）';
  }
  if (result.mode === 'direct') {
    return 'CC Switch 当前为直连模式，兼容层不会生效';
  }
  if (result.mode === null && result.localProxyEnabled === false) {
    return 'CC Switch 本地代理开关未开启';
  }
  return 'CC Switch 状态未知，请检查其本地代理设置';
}

module.exports = { ccSwitchHome, detect, describe, readProxyConfig };
