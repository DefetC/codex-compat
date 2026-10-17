// 预检回归测试：覆盖「base_url 指向本工具端口区间但识别失败时被误当成上游」这一真实事故。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-preflight-'));

// 中文注释：构造隔离的 CODEX_HOME（含 provider 与模型目录）
function fixture(name, baseUrl, manifest) {
  const home = path.join(root, name, 'codex');
  const compatHome = path.join(root, name, 'compat');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(compatHome, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'),
    '[model_providers.custom]\nname = "Fake"\nbase_url = "' + baseUrl + '"\nwire_api = "responses"\n');
  fs.writeFileSync(path.join(home, 'cc-switch-model-catalog.json'), JSON.stringify({ models: [{ slug: 'vendor/auto' }] }));
  if (manifest) {
    fs.writeFileSync(path.join(compatHome, 'install-manifest.json'), JSON.stringify(Object.assign({ version: 1 }, manifest)));
  }
  return { home, compatHome };
}

// 中文注释：在子进程中替换探测类依赖后运行预检，返回结构化结果
function runPreflight(fixturePaths, stubs, options = {}) {
  const code = [
    'const cc = require(' + JSON.stringify(path.join(repo, 'src', 'ccswitch.cjs')) + ');',
    'const ports = require(' + JSON.stringify(path.join(repo, 'src', 'ports.cjs')) + ');',
    'cc.detect = () => (' + JSON.stringify(stubs.cc) + ');',
    'ports.probeCompat = async () => (' + JSON.stringify({ ours: stubs.ours, data: stubs.ours ? { name: 'codex-compat' } : null }) + ');',
    'ports.isReachable = async () => true;',
    'ports.selectListenPort = async () => ({ ok: true, port: ' + stubs.listenPort + ', reused: false, requested: ' + stubs.listenPort + ', attempts: [] });',
    'require(' + JSON.stringify(path.join(repo, 'src', 'preflight.cjs')) + ').run(' + JSON.stringify({ allowRemoteUpstream: options.allowRemoteUpstream === true }) + ').then((result) => {',
    '  process.stdout.write(JSON.stringify({ ok: result.ok, alreadyInstalled: result.alreadyInstalled, upstream: result.upstream, originalBaseUrl: result.originalBaseUrl, errors: result.errors.map((item) => item.id), diagnostics: result.diagnostics }));',
    '}).catch((err) => { process.stderr.write(String(err && err.stack || err)); process.exit(1); });',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: repo,
    env: Object.assign({}, process.env, { CODEX_HOME: fixturePaths.home, CODEX_COMPAT_HOME: fixturePaths.compatHome }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, '预检子进程必须正常退出：' + result.stderr);
  return JSON.parse(result.stdout.trim());
}

// 中文注释：CC Switch 探测结果桩
const CC_OFF = { installed: false, takingOver: false, listenHost: '127.0.0.1', listenPort: 15721 };
const CC_ON = { installed: true, takingOver: true, listenHost: '127.0.0.1', listenPort: 15721, mode: 'proxy', attached: true };

try {
  // 用例 1：base_url 落在本工具端口区间、但既不是本代实例也没有 CC Switch —— 必须报错而不是当成上游
  const foreign = fixture('foreign-port', 'http://127.0.0.1:15735/v1');
  const first = runPreflight(foreign, { ours: false, cc: CC_OFF, listenPort: 15731 });
  assert.equal(first.ok, false, '端口区间内无法识别的地址必须让预检失败');
  assert.ok(first.errors.includes('provider'), '必须给出 provider 错误');
  assert.equal(first.upstream, null, '不得把本工具端口区间里的陌生地址当作上游');
  assert.ok(first.diagnostics && first.diagnostics.ccswitch, '必须返回可供 --verbose 使用的诊断信息');
  assert.ok(Array.isArray(first.diagnostics.portSelection.attempts), '诊断信息必须包含端口尝试明细');

  // 用例 2：同样的地址，但 CC Switch 在接管 —— 视为上一代兼容层，用 CC Switch 重建还原点
  const legacy = fixture('legacy-generation', 'http://127.0.0.1:15735/v1');
  const second = runPreflight(legacy, { ours: false, cc: CC_ON, listenPort: 15731 });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyInstalled, true, '上一代兼容层端口应按已安装处理');
  assert.equal(second.originalBaseUrl.value, 'http://127.0.0.1:15721/v1', '还原点必须来自 CC Switch，而不是当前 base_url');
  assert.equal(second.upstream.port, 15721);

  // 用例 3：区间外的本机地址（例如 CC Switch 15721）应被当作真实上游
  const normal = fixture('normal-upstream', 'http://127.0.0.1:15721/v1');
  const third = runPreflight(normal, { ours: false, cc: CC_OFF, listenPort: 15731 });
  assert.equal(third.ok, true);
  assert.equal(third.alreadyInstalled, false);
  assert.equal(third.originalBaseUrl.value, 'http://127.0.0.1:15721/v1');
  assert.equal(third.upstream.port, 15721);

  // 用例 4：清单端口与当前 base_url 不一致（手工改过端口），仍应识别为本代实例并保留原上游
  const drifted = fixture('drifted-port', 'http://127.0.0.1:15732/v1', {
    installed: true,
    listenPort: 15731,
    providerKey: 'custom',
    originalBaseUrl: { value: 'http://127.0.0.1:15721/v1', hash: 'x', rebuilt: true },
    upstream: { host: '127.0.0.1', port: 15721, basePath: '/v1', mode: 'cc-switch' },
  });
  const fourth = runPreflight(drifted, { ours: true, cc: CC_ON, listenPort: 15731 });
  assert.equal(fourth.ok, true);
  assert.equal(fourth.alreadyInstalled, true, '识别到本代实例时必须按已安装处理');
  assert.equal(fourth.originalBaseUrl.value, 'http://127.0.0.1:15721/v1', '不得用当前 base_url 覆盖清单里的原始上游');
  assert.equal(fourth.upstream.port, 15721);

  // 用例 5：远程上游默认必须被拦住，显式 --allow-remote-upstream 才放行
  const remote = fixture('remote-upstream', 'https://gateway.example.invalid/v1');
  const blockedRemote = runPreflight(remote, { ours: false, cc: CC_OFF, listenPort: 15731 });
  assert.equal(blockedRemote.ok, false, '远程上游默认必须让预检失败');
  assert.ok(blockedRemote.errors.includes('remote-upstream'), '必须给出 remote-upstream 错误');
  const allowedRemote = runPreflight(remote, { ours: false, cc: CC_OFF, listenPort: 15731 }, { allowRemoteUpstream: true });
  assert.equal(allowedRemote.ok, true, '显式允许后远程上游应通过预检');
  assert.equal(allowedRemote.upstream.port, 443);

  console.log('PREFLIGHT_TEST_PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
