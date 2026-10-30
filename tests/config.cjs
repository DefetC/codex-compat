// 配置加载自检：验证「CLI 参数 > 环境变量 > 配置文件 > 默认值」优先级，以及容错、校验、保存回读
// 路径约定：本文件位于 tests/，仓库根是上一级
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config.cjs');

// 中文注释：参与优先级验证的环境变量清单，测试开始前先备份并清空
const ENV_KEYS = [
  'COMPAT_PORT',
  'COMPAT_UPSTREAM_HOST',
  'COMPAT_UPSTREAM_PORT',
  'COMPAT_UPSTREAM_BASE_URL',
  'COMPAT_STRIP_ALWAYS',
  'COMPAT_OUTPUT_TOKEN_REPLAY',
  'COMPAT_REQUEST_COMPRESSION',
  'COMPAT_TRACE',
  'CODEX_COMPAT_HOME',
];
// 中文注释：备份外部环境变量，便于断言结束后恢复
const originalEnv = {};
for (const key of ENV_KEYS) {
  originalEnv[key] = process.env[key];
  delete process.env[key];
}

// 中文注释：每个用例前清空环境变量，避免用例之间相互污染
function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

// 中文注释：测试专用临时 home 目录
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-config-'));

// 中文注释：用例 1 —— 没有任何配置文件时回落到默认值
clearEnv();
const defaults = config.load({ home });
assert.equal(defaults.listen.host, '127.0.0.1');
assert.equal(defaults.listen.port, 15731);
assert.equal(defaults.upstream.mode, 'cc-switch');
assert.equal(defaults.upstream.host, '127.0.0.1');
assert.equal(defaults.upstream.port, 15721);
assert.equal(defaults.upstream.baseUrl, null);
assert.equal(defaults.upstream.basePath, '/v1');
assert.equal(defaults.compat.stripAlways, true);
assert.deepEqual(defaults.compat.thirdPartyPrefixes, ['ccs-', 'ccs/']);
// 兼容策略缺省时仍应保护官方通道，并且不额外信任第三方不透明任务。
assert.equal(defaults.compat.outputTokenReplay, 'auto');
assert.equal(defaults.compat.requestCompression, 'auto');
assert.deepEqual(defaults.compat.opaqueTaskModels, []);
assert.equal(defaults.service.reclaim, 'auto');
assert.equal(defaults.runtime.logLevel, 'info');
// 中文注释：功能开关默认值——目录托管默认关闭（实测 Codex 0.160.1 不拉取 provider 级目录），纯官方保护默认开启
assert.equal(defaults.features.providerCatalog, false);
assert.equal(defaults.features.officialGuard, true);
assert.equal(defaults.features.deepseekPrompt, true);
assert.equal(defaults.features.deepseekRoles, true);
assert.equal(defaults.runtime.verbose, false);
assert.equal(defaults.runtime.lang, 'auto');
assert.equal(defaults.home, home);
// 中文注释：加载过程不得污染导出的默认值常量
assert.equal(config.DEFAULTS.listen.port, 15731);
assert.deepEqual(config.DRIFT_POLICIES, ['auto', 'notify-only', 'off']);

// 中文注释：paths(home) 必须全部落在传入的 home 目录下
const p = config.paths(home);
assert.equal(p.home, home);
assert.equal(p.configFile, path.join(home, 'config.json'));
assert.equal(p.configDir, path.join(home, 'config'));
assert.equal(p.mappingFile, path.join(home, 'config', 'mappings.toml'));
assert.equal(p.manifestFile, path.join(home, 'install-manifest.json'));
assert.equal(p.logs, path.join(home, 'logs'));
assert.equal(p.backups, path.join(home, 'backups'));
assert.equal(p.run, path.join(home, 'run'));
assert.equal(p.state, path.join(home, 'state'));
assert.equal(p.lockFile, path.join(home, 'run', 'watchdog.lock'));
assert.equal(p.intentionalStopFlag, path.join(home, 'run', 'intentional-stop.flag'));

// 中文注释：用例 2 —— 配置文件覆盖默认值
clearEnv();
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  listen: { port: 16001 },
  upstream: { port: 16002 },
  service: { reclaim: 'notify-only' },
}), 'utf8');
const fromFile = config.load({ home });
assert.equal(fromFile.listen.port, 16001);
assert.equal(fromFile.upstream.port, 16002);
assert.equal(fromFile.service.reclaim, 'notify-only');
// 中文注释：文件未覆盖的字段继续沿用默认值
assert.equal(fromFile.listen.host, '127.0.0.1');
assert.equal(fromFile.upstream.mode, 'cc-switch');

// 中文注释：用例 3 —— 环境变量覆盖配置文件
process.env.COMPAT_PORT = '16003';
process.env.COMPAT_UPSTREAM_PORT = '16004';
process.env.COMPAT_UPSTREAM_HOST = '127.0.0.2';
process.env.COMPAT_UPSTREAM_BASE_URL = 'http://file-env.local/v1';
process.env.COMPAT_STRIP_ALWAYS = '0';
process.env.COMPAT_OUTPUT_TOKEN_REPLAY = 'strip';
process.env.COMPAT_REQUEST_COMPRESSION = 'decode';
process.env.COMPAT_TRACE = '1';
const fromEnv = config.load({ home });
assert.equal(fromEnv.listen.port, 16003);
assert.equal(fromEnv.upstream.port, 16004);
assert.equal(fromEnv.upstream.host, '127.0.0.2');
assert.equal(fromEnv.upstream.baseUrl, 'http://file-env.local/v1');
assert.equal(fromEnv.compat.stripAlways, false);
assert.equal(fromEnv.compat.outputTokenReplay, 'strip');
assert.equal(fromEnv.compat.requestCompression, 'decode');
assert.equal(fromEnv.runtime.trace, true);

// 中文注释：用例 4 —— CLI 参数覆盖环境变量与配置文件
const fromCli = config.load({ home, port: 16005, upstreamPort: 16006, reclaim: 'off', outputTokenReplay: 'preserve', requestCompression: 'preserve', opaqueTaskModels: ['vendor/gpt-model'] });
assert.equal(fromCli.listen.port, 16005);
assert.equal(fromCli.upstream.port, 16006);
assert.equal(fromCli.service.reclaim, 'off');
assert.equal(fromCli.compat.outputTokenReplay, 'preserve');
assert.equal(fromCli.compat.requestCompression, 'preserve');
assert.deepEqual(fromCli.compat.opaqueTaskModels, ['vendor/gpt-model']);
assert.equal(fromCli.upstream.host, '127.0.0.2');

// 中文注释：用例 5 —— CODEX_COMPAT_HOME 决定默认 home
clearEnv();
const envHome = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-config-envhome-'));
fs.writeFileSync(path.join(envHome, 'config.json'), JSON.stringify({ listen: { port: 16007 } }), 'utf8');
process.env.CODEX_COMPAT_HOME = envHome;
const fromEnvHome = config.load();
assert.equal(fromEnvHome.home, envHome);
assert.equal(fromEnvHome.listen.port, 16007);

// 中文注释：用例 6 —— parsePort 只接受 1..65535 的整数端口
assert.equal(config.parsePort('15731', 'listen'), 15731);
assert.equal(config.parsePort(15731, 'listen'), 15731);
assert.throws(() => config.parsePort('0', 'listen'), /listen 端口非法/);
assert.throws(() => config.parsePort('65536', 'upstream'), /upstream 端口非法/);
assert.throws(() => config.parsePort('abc', 'listen'), /listen 端口非法/);
assert.throws(() => config.parsePort('15.5', 'listen'), /listen 端口非法/);

// 中文注释：用例 7 —— validate 拒绝非法端口与非法 reclaim
const badListen = structuredClone(config.DEFAULTS);
badListen.listen.port = 0;
assert.throws(() => config.validate(badListen), /listen 端口非法/);
const badUpstream = structuredClone(config.DEFAULTS);
badUpstream.upstream.port = 70000;
assert.throws(() => config.validate(badUpstream), /upstream 端口非法/);
const badReclaim = structuredClone(config.DEFAULTS);
badReclaim.service.reclaim = 'sometimes';
assert.throws(() => config.validate(badReclaim), /service\.reclaim 只能是/);
const badBasePath = structuredClone(config.DEFAULTS);
badBasePath.upstream.basePath = 'v1';
assert.throws(() => config.validate(badBasePath), /upstream\.basePath 必须以 \/ 开头/);
const badPrefixes = structuredClone(config.DEFAULTS);
badPrefixes.compat.thirdPartyPrefixes = ['ccs-', 42];
assert.throws(() => config.validate(badPrefixes), /compat\.thirdPartyPrefixes 必须是字符串数组/);
// 不合法的兼容策略不得被当成 truthy 开关或无条件透传名单。
for (const [key, value] of [['outputTokenReplay', 'unknown'], ['requestCompression', false], ['opaqueTaskModels', ['*']], ['opaqueTaskModels', ['']], ['opaqueTaskModels', [123]], ['stripAlways', 'false']]) {
  const invalid = structuredClone(config.DEFAULTS);
  invalid.compat[key] = value;
  assert.throws(() => config.validate(invalid), new RegExp('compat\\.' + key));
}
// 中文注释：合法配置原样返回
assert.equal(config.validate(structuredClone(config.DEFAULTS)).listen.port, 15731);

// 中文注释：用例 8 —— 配置文件损坏时 load 抛错，loadSafe 退回默认值并给出错误说明
clearEnv();
const brokenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-config-broken-'));
fs.writeFileSync(path.join(brokenHome, 'config.json'), '{ not-json', 'utf8');
assert.throws(() => config.load({ home: brokenHome }), /配置文件解析失败/);
const safe = config.loadSafe({ home: brokenHome });
assert.notEqual(safe.error, null);
assert.ok(String(safe.error).indexOf('配置文件解析失败') >= 0, 'loadSafe.error 必须说明解析失败');
assert.equal(safe.cfg.listen.port, 15731);
assert.equal(safe.cfg.home, brokenHome);
// 中文注释：配置正常时 loadSafe 不返回错误（用干净目录，避免受前面用例写过的配置影响）
const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-config-clean-'));
const safeOk = config.loadSafe({ home: cleanHome });
assert.equal(safeOk.error, null);
assert.equal(safeOk.cfg.listen.port, 15731);

// 中文注释：用例 9 —— save 后 load 必须能读回同一份配置，且不落 home 运行时字段
const toSave = config.load({ home });
toSave.listen.port = 16009;
toSave.service.reclaim = 'notify-only';
toSave.features.deepseekRoles = false;
// 策略必须随正常配置保存回读，不得把名单误存成字符串。
toSave.compat.outputTokenReplay = 'strip';
toSave.compat.requestCompression = 'decode';
toSave.compat.opaqueTaskModels = ['ccs-vendor/gpt-model'];
const savedFile = config.save(toSave, home);
assert.equal(savedFile, path.join(home, 'config.json'));
const rawSaved = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
assert.equal(Object.prototype.hasOwnProperty.call(rawSaved, 'home'), false);
const reloaded = config.load({ home });
assert.equal(reloaded.listen.port, 16009);
assert.equal(reloaded.service.reclaim, 'notify-only');
assert.equal(reloaded.features.deepseekRoles, false);
assert.equal(reloaded.compat.outputTokenReplay, 'strip');
assert.equal(reloaded.compat.requestCompression, 'decode');
assert.deepEqual(reloaded.compat.opaqueTaskModels, ['ccs-vendor/gpt-model']);

// 中文注释：用例 10 —— upstreamBaseUrl 优先使用显式 baseUrl，否则按 host/port/basePath 拼装
// 中文注释：这里同样使用干净目录，才能断言默认端口 15721
const withBaseUrl = config.load({ home: cleanHome });
withBaseUrl.upstream.baseUrl = 'http://gw.local/v1///';
assert.equal(config.upstreamBaseUrl(withBaseUrl), 'http://gw.local/v1');
const withoutBaseUrl = config.load({ home: cleanHome });
assert.equal(config.upstreamBaseUrl(withoutBaseUrl), 'http://127.0.0.1:15721/v1');
// 中文注释：异常端口写入配置后 save 必须被 validate 拦截
const invalidSave = config.load({ home });
invalidSave.listen.port = 99999;
assert.throws(() => config.save(invalidSave, home), /listen 端口非法/);

// 中文注释：断言结束，恢复外部环境变量后清空本次测试用到的键
for (const key of ENV_KEYS) {
  if (originalEnv[key] === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = originalEnv[key];
  }
}
clearEnv();

console.log('CONFIG_TEST_PASS');
