// 端口选择与占用判定：区分「端口空闲」「本工具旧实例」「被其他程序占用」。
const net = require('node:net');
const http = require('node:http');

// 中文注释：默认监听端口与自动扫描区间
const DEFAULT_PORT = 15731;
const SCAN_FROM = 15732;
const SCAN_TO = 15831;

// 中文注释：尝试绑定端口；能绑定说明空闲
function canBind(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        server.close();
      } catch (err) {
        // 中文注释：关闭失败忽略
      }
      resolve(ok);
    };
    server.once('error', () => done(false));
    server.listen(port, host, () => done(true));
    setTimeout(() => done(false), timeoutMs).unref();
  });
}

// 中文注释：探测端口上是否为 codex-compat 实例（通过健康检查签名）
function probeCompat(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/__compat/health', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ ours: data && data.name === 'codex-compat', data });
        } catch (err) {
          resolve({ ours: false, data: null });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ours: false, data: null }); });
    req.on('error', () => resolve({ ours: false, data: null }));
  });
}

// 中文注释：TCP 可达性探测，用于上游检查
function isReachable(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

// 中文注释：按「用户指定 > 默认端口 > 顺序扫描」挑选可用端口
async function selectListenPort(options = {}) {
  const host = options.host || '127.0.0.1';
  const preferred = Number(options.preferred || DEFAULT_PORT);
  const ownedPort = options.ownedPort ? Number(options.ownedPort) : null;
  // 中文注释：调用方传入的运行目录；只有同一运行目录的实例才允许被复用
  const home = options.home || null;
  // 中文注释：候选顺序必须是「首选端口（用户指定或当前配置）> 清单记录的端口 > 顺序扫描」，
  // 否则用户显式指定的端口会被清单里的旧端口抢先命中。
  const candidates = [];
  const push = (port) => {
    if (port && !candidates.includes(port)) {
      candidates.push(port);
    }
  };
  push(preferred);
  push(ownedPort);
  for (let port = SCAN_FROM; port <= SCAN_TO; port++) {
    push(port);
  }
  const attempts = [];
  for (const port of candidates) {
    if (await canBind(host, port)) {
      return { ok: true, port, reused: false, requested: preferred, attempts };
    }
    if (ownedPort && port === ownedPort) {
      return { ok: true, port, reused: true, requested: preferred, attempts, reason: 'owned-port-in-use' };
    }
    const probe = await probeCompat(host, port);
    attempts.push({ port, ours: probe.ours });
    // 中文注释：新实例不得复用主实例端口；只有明确报告了不同 home 才算外部实例
    // （旧版本实例没有 home 字段，按同 home 兼容处理，避免误开第二个实例）
    const sameHome = !home || !probe.data || !probe.data.home || probe.data.home === home;
    if (probe.ours && sameHome) {
      return { ok: true, port, reused: true, requested: preferred, health: probe.data, attempts };
    }
    if (probe.ours && !sameHome) {
      attempts[attempts.length - 1].otherHome = probe.data && probe.data.home ? probe.data.home : 'unknown';
    }
  }
  return { ok: false, port: null, reused: false, requested: preferred, attempts, reason: '在 ' + DEFAULT_PORT + '–' + SCAN_TO + ' 范围内没有可用端口' };
}

module.exports = { DEFAULT_PORT, SCAN_FROM, SCAN_TO, canBind, probeCompat, isReachable, selectListenPort };
