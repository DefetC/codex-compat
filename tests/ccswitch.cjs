// CC Switch 探测自检：4 组 fixture 覆盖「未安装 / 本地代理关闭 / 接管生效 / 直连模式」
// 路径约定：本文件位于 tests/，仓库根是上一级
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detect, describe, ccSwitchHome } = require('../src/ccswitch.cjs');

// 中文注释：备份外部 CC_SWITCH_HOME，测试结束前恢复
const originalHome = process.env.CC_SWITCH_HOME;
delete process.env.CC_SWITCH_HOME;

// 中文注释：测试用临时根目录
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-ccswitch-'));

// 中文注释：按 fixture 切换 CC_SWITCH_HOME 并执行探测
function detectWith(home) {
  process.env.CC_SWITCH_HOME = home;
  return detect();
}

// 中文注释：fixture 1 —— 目录不存在，视为未安装
const noneHome = path.join(root, 'none');
const noneResult = detectWith(noneHome);
assert.equal(noneResult.installed, false);
assert.equal(noneResult.takingOver, false);
assert.equal(noneResult.mode, null);
assert.equal(noneResult.attached, false);
assert.equal(noneResult.home, noneHome);
// 中文注释：默认监听地址与端口来自内置兜底值
assert.equal(noneResult.listenHost, '127.0.0.1');
assert.equal(noneResult.listenPort, 15721);
assert.ok(describe(noneResult).includes('未检测到'), 'describe 必须说明未检测到 CC Switch');

// 中文注释：fixture 2 —— settings.json 关闭本地代理
const disabledHome = path.join(root, 'disabled');
fs.mkdirSync(disabledHome, { recursive: true });
fs.writeFileSync(path.join(disabledHome, 'settings.json'), JSON.stringify({ enableLocalProxy: false }), 'utf8');
const disabledResult = detectWith(disabledHome);
assert.equal(disabledResult.installed, true);
assert.equal(disabledResult.localProxyEnabled, false);
assert.equal(disabledResult.mode, null);
assert.equal(disabledResult.attached, false);
assert.equal(disabledResult.takingOver, false);
assert.ok(describe(disabledResult).includes('本地代理开关未开启'), 'describe 必须说明本地代理开关未开启');

// 中文注释：fixture 2 补充 —— settings.json 存在但未显式关闭时视为已开启
const enabledHome = path.join(root, 'enabled');
fs.mkdirSync(enabledHome, { recursive: true });
fs.writeFileSync(path.join(enabledHome, 'settings.json'), JSON.stringify({ enableLocalProxy: true }), 'utf8');
const enabledResult = detectWith(enabledHome);
assert.equal(enabledResult.installed, true);
assert.equal(enabledResult.localProxyEnabled, true);
assert.equal(enabledResult.takingOver, false);

// 中文注释：fixture 3 —— live-state.json 显示 mode=proxy 且 attached=true，判定为已接管
const takeoverHome = path.join(root, 'takeover');
fs.mkdirSync(takeoverHome, { recursive: true });
fs.writeFileSync(
  path.join(takeoverHome, 'live-state.json'),
  JSON.stringify({ apps: { codex: { mode: 'proxy', attached: true, proxyRoute: '/v1' } } }),
  'utf8',
);
const takeoverResult = detectWith(takeoverHome);
assert.equal(takeoverResult.installed, true);
assert.equal(takeoverResult.mode, 'proxy');
assert.equal(takeoverResult.attached, true);
assert.equal(takeoverResult.takingOver, true);
assert.equal(takeoverResult.proxyRoute, '/v1');
assert.equal(takeoverResult.listenHost, '127.0.0.1');
assert.equal(takeoverResult.listenPort, 15721);
assert.ok(describe(takeoverResult).includes('接管'), 'describe 必须说明已接管');
assert.ok(describe(takeoverResult).includes('127.0.0.1:15721'), 'describe 必须带上监听地址');

// 中文注释：fixture 4 —— live-state.json 显示直连模式
const directHome = path.join(root, 'direct');
fs.mkdirSync(directHome, { recursive: true });
fs.writeFileSync(
  path.join(directHome, 'live-state.json'),
  JSON.stringify({ apps: { codex: { mode: 'direct', attached: false } } }),
  'utf8',
);
const directResult = detectWith(directHome);
assert.equal(directResult.installed, true);
assert.equal(directResult.mode, 'direct');
assert.equal(directResult.takingOver, false);
assert.ok(describe(directResult).includes('直连'), 'describe 必须说明直连模式');

// 中文注释：fixture 补充 —— 目录存在但无任何状态文件时，describe 落到「状态未知」
const emptyHome = path.join(root, 'empty');
fs.mkdirSync(emptyHome, { recursive: true });
const emptyResult = detectWith(emptyHome);
assert.equal(emptyResult.installed, true);
assert.equal(emptyResult.mode, null);
assert.equal(emptyResult.localProxyEnabled, null);
assert.ok(describe(emptyResult).includes('状态未知'), 'describe 必须说明状态未知');

// 中文注释：ccSwitchHome 读取环境变量覆盖值
process.env.CC_SWITCH_HOME = takeoverHome;
assert.equal(ccSwitchHome(), takeoverHome);

// 中文注释：断言结束，恢复外部环境变量；原本不存在则清空
if (originalHome === undefined) {
  delete process.env.CC_SWITCH_HOME;
} else {
  process.env.CC_SWITCH_HOME = originalHome;
}

console.log('CCSWITCH_TEST_PASS');
