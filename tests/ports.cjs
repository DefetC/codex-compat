// 端口选择与占用判定自检：真实起 TCP/HTTP 服务验证 canBind / probeCompat / isReachable / selectListenPort
// 路径约定：本文件位于 tests/，仓库根是上一级
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { canBind, probeCompat, isReachable, selectListenPort, SCAN_FROM, SCAN_TO } = require('../src/ports.cjs');

// 中文注释：让服务器监听端口（port=0 表示系统分配），返回真实端口
function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

// 中文注释：关闭服务器并等待句柄释放，避免测试进程挂起
function close(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(() => resolve());
  });
}

async function main() {
  // 中文注释：用例 1 —— 被占用端口 canBind=false，释放后 canBind=true
  const occupier = net.createServer();
  const occupiedPort = await listen(occupier);
  assert.equal(await canBind('127.0.0.1', occupiedPort), false, '被占用端口必须判定为不可绑定');
  await close(occupier);
  assert.equal(await canBind('127.0.0.1', occupiedPort), true, '端口释放后必须判定为可绑定');

  // 中文注释：用例 2 —— 健康检查签名匹配才算 codex-compat
  const oursServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'codex-compat', version: 'test' }));
  });
  const oursPort = await listen(oursServer);
  const oursProbe = await probeCompat('127.0.0.1', oursPort);
  assert.equal(oursProbe.ours, true, 'name=codex-compat 必须判定为本工具实例');
  assert.equal(oursProbe.data.name, 'codex-compat');

  // 中文注释：用例 3 —— 返回别的 JSON 不算 codex-compat
  const otherServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'other-app', version: 'test' }));
  });
  const otherPort = await listen(otherServer);
  const otherProbe = await probeCompat('127.0.0.1', otherPort);
  assert.equal(otherProbe.ours, false, '其他应用的 JSON 必须判定为非本工具实例');
  assert.equal(otherProbe.data.name, 'other-app');

  // 中文注释：用例 4 —— 非 JSON 响应同样不算 codex-compat
  const plainServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not json at all');
  });
  const plainPort = await listen(plainServer);
  const plainProbe = await probeCompat('127.0.0.1', plainPort);
  assert.equal(plainProbe.ours, false, '非 JSON 响应必须判定为非本工具实例');
  assert.equal(plainProbe.data, null);

  // 中文注释：用例 5 —— preferred 被外部占用时，必须换到扫描区间内的端口
  const picked = await selectListenPort({ host: '127.0.0.1', preferred: otherPort });
  assert.equal(picked.ok, true, '存在可用端口时必须返回 ok=true');
  assert.notEqual(picked.port, otherPort, '不能选中被外部占用的 preferred 端口');
  assert.ok(
    picked.port >= SCAN_FROM && picked.port <= SCAN_TO,
    '选中的端口必须落在扫描区间 ' + SCAN_FROM + '-' + SCAN_TO + '，实际 ' + picked.port,
  );
  assert.equal(picked.reused, false);
  assert.ok(
    picked.attempts.some((item) => item.port === otherPort && item.ours === false),
    'attempts 必须记录 preferred 端口被外部占用',
  );

  // 中文注释：用例 6 —— preferred 空闲时直接复用该端口
  const spare = net.createServer();
  const sparePort = await listen(spare);
  await close(spare);
  const pickedSpare = await selectListenPort({ host: '127.0.0.1', preferred: sparePort });
  assert.equal(pickedSpare.ok, true);
  assert.equal(pickedSpare.port, sparePort);
  assert.equal(pickedSpare.reused, false);
  assert.deepEqual(pickedSpare.attempts, []);

  // 中文注释：用例 7 —— 已监听端口 isReachable=true，未监听端口 false
  assert.equal(await isReachable('127.0.0.1', oursPort), true, '已监听端口必须可达');
  await close(plainServer);
  assert.equal(await isReachable('127.0.0.1', plainPort), false, '未监听端口必须不可达');

  // 中文注释：用例 8 —— 显式 preferred 必须优先于清单记录的 ownedPort（回归：Cursor 排障发现的顺序 bug）
  const firstFree = net.createServer();
  const firstFreePort = await listen(firstFree);
  await close(firstFree);
  const secondFree = net.createServer();
  const secondFreePort = await listen(secondFree);
  await close(secondFree);
  const pickedPreferred = await selectListenPort({ host: '127.0.0.1', preferred: firstFreePort, ownedPort: secondFreePort });
  assert.equal(pickedPreferred.port, firstFreePort, 'preferred 空闲时必须优先选中 preferred，而不是 ownedPort');
  assert.equal(pickedPreferred.requested, firstFreePort);

  // 中文注释：用例 9 —— preferred 被外部占用时，才回退到清单记录的 ownedPort
  // 中文注释：立即销毁入站连接，避免 probeCompat 超时等待与服务端 close 挂起
  const blocked = net.createServer((socket) => socket.destroy());
  const blockedPort = await listen(blocked);
  const ownedFree = net.createServer();
  const ownedFreePort = await listen(ownedFree);
  await close(ownedFree);
  const pickedOwned = await selectListenPort({ host: '127.0.0.1', preferred: blockedPort, ownedPort: ownedFreePort });
  assert.equal(pickedOwned.port, ownedFreePort, 'preferred 被占用时应回退到 ownedPort');
  await close(blocked);

  await close(oursServer);
  await close(otherServer);
  console.log('PORTS_TEST_PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
