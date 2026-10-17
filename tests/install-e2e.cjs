// 安装端到端测试：真实改写 config.toml → 真实启动兼容层转发 → 真实还原。
//
// 不注册任何系统服务：服务与健康检查在子进程中被桩替换，但代理转发使用真实进程。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const nodeExe = process.execPath;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-e2e-'));
const codexHome = path.join(root, 'codex');
const compatHome = path.join(root, 'compat');
const mappingDir = path.join(root, 'mapping');

// 中文注释：等待端口就绪
function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const request = http.get({ host: '127.0.0.1', port, path: '/__compat/health', timeout: 800 }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (data.name === 'codex-compat') {
              resolve(data);
              return;
            }
          } catch (err) {
            // 中文注释：未就绪继续等待
          }
          retry();
        });
      });
      request.on('timeout', () => { request.destroy(); retry(); });
      request.on('error', () => retry());
    };
    const retry = () => {
      if (Date.now() > deadline) {
        resolve(null);
        return;
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}

// 中文注释：取一个当前空闲端口
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// 中文注释：向兼容层发一次请求
function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/responses',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, headers),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

// 中文注释：结束进程树，避免残留代理进程
function killTree(pid) {
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (err) { /* 中文注释：忽略 */ }
  }
}

// 中文注释：子进程环境
function childEnv() {
  return Object.assign({}, process.env, {
    CODEX_HOME: codexHome,
    CODEX_COMPAT_HOME: compatHome,
    CODEX_MAPPING_FILE: path.join(mappingDir, 'mappings.toml'),
  });
}

// 中文注释：带桩执行一个命令（避免注册系统服务 / 避免真实健康等待）
function runCommandStub(command, listenPort, upstreamPort) {
  // 中文注释：完整 argv，子进程里直接复用，避免拼接引号
  const argv = ['node', 'codex-compat'].concat(String(command).split(' ')).concat(['--yes', '--port', String(listenPort)]);
  const code = [
    "const platform=require('./src/platform.cjs');",
    "const ports=require('./src/ports.cjs');",
    "const processes=require('./src/processes.cjs');",
    "platform.installService=()=>({ok:true,detail:'mock-service'});",
    "platform.registerGuard=()=>({ok:true,detail:'mock-guard'});",
    "platform.uninstallService=()=>({ok:true,detail:'mock-service-removed'});",
    "platform.unregisterGuard=()=>({ok:true,detail:'mock-guard-removed'});",
    "platform.startWatchdogDetached=()=>({ok:true,detail:'mock-fallback'});",
    "platform.cleanupOwnLegacyTasks=()=>({removed:[],detail:'mock-cleanup'});",
    "platform.cleanupLegacyTasks=()=>({removed:[],detail:'mock-cleanup'});",
    "platform.legacyTasks=()=>[];",
    "processes.killInstance=async()=>({killed:[],remaining:[]});",
    // 中文注释：只有目标监听端口才算本工具实例；上游端口必须如实返回 false，否则预检会误判
    "ports.probeCompat=async(host,port)=>(port===" + listenPort + "?{ours:true,data:{name:'codex-compat',version:'test',port:" + listenPort + ",upstreamPort:" + upstreamPort + "}}:{ours:false,data:null});",
    // 中文注释：argv[0]=node、argv[1]=脚本名，真实参数从索引 2 开始
    'process.argv=' + JSON.stringify(argv) + ';',
    "require('./src/commands/index.cjs').run(process.argv.slice(2)).then((c)=>{process.exitCode=c;});",
  ].join('');
  return spawnSync(nodeExe, ['-e', code], { cwd: repo, env: childEnv(), encoding: 'utf8', windowsHide: true });
}

(async () => {
  let watchdog = null;
  let upstream = null;
  try {
    // 准备目录与映射
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(mappingDir, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'cc-switch-model-catalog.json'), JSON.stringify({ models: [{ slug: 'vendor/auto' }] }));
    fs.writeFileSync(path.join(mappingDir, 'model.toml'), '[settings]\ndefault_reasoning_level = "high"\n');
    fs.writeFileSync(path.join(mappingDir, 'mappings.toml'), 'version = 1\n[[bindings]]\nmodel_id = "vendor/auto"\nmodel_template = "model.toml"\n');

    // 假上游
    const received = [];
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;
    const listenPort = await freePort();
    const originalUrl = 'http://127.0.0.1:' + upstreamPort + '/v1';
    fs.writeFileSync(path.join(codexHome, 'config.toml'),
      '[model_providers.custom]\nname = "Fake"\nbase_url = "' + originalUrl + '"\nwire_api = "responses"\n');

    // 1) 安装
    const installed = runCommandStub('install', listenPort, upstreamPort);
    assert.equal(installed.status, 0, '安装应成功：' + installed.stdout + installed.stderr);
    const wired = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.ok(wired.includes('base_url = "http://127.0.0.1:' + listenPort + '/v1"'), 'base_url 应指向兼容层');
    const manifestPath = path.join(compatHome, 'install-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.installed, true);
    assert.equal(manifest.providerKey, 'custom');
    assert.equal(manifest.listenPort, listenPort);
    assert.equal(manifest.originalBaseUrl && manifest.originalBaseUrl.value, originalUrl,
      '清单必须记录原始上游，实际为 ' + JSON.stringify(manifest.originalBaseUrl));
    assert.ok(fs.existsSync(path.join(compatHome, 'config', 'mappings.toml')), '应落位用户级配置');

    // 2) 真实启动看门狗并转发
    watchdog = spawn(nodeExe, [path.join(repo, 'src', 'watchdog.cjs'), '--home', compatHome], {
      cwd: repo,
      env: childEnv(),
      stdio: 'ignore',
      windowsHide: true,
    });
    const health = await waitHealth(listenPort, 20000);
    assert.ok(health, '兼容层应在 20 秒内就绪');
    const response = await post(listenPort, {
      model: 'gpt-6',
      input: [
        { type: 'additional_tools', tools: [{ name: 'spawn_agent', parameters: { properties: { message: { type: 'string', encrypted: true } } } }] },
        { type: 'agent_message', content: [{ type: 'input_text', text: 'TASK_HEADER' }, { encrypted_content: 'PLAINTEXT_TASK' }] },
      ],
    }, { authorization: 'Bearer E2E-SECRET-TOKEN' });
    assert.equal(response.status, 200);
    assert.equal(received.length, 1, '上游应收到一次请求');
    assert.ok(!received[0].body.includes('"encrypted"'), '转发前必须剥离 encrypted 标记');
    assert.ok(received[0].body.includes('PLAINTEXT_TASK'), '任务正文必须保留给上游');
    assert.equal(received[0].headers.host, '127.0.0.1:' + upstreamPort, 'Host 头必须重写为上游');
    assert.equal(received[0].headers.authorization, 'Bearer E2E-SECRET-TOKEN', '认证头必须透传');

    // 2.1) 非法工具参数（值位置裸词）必须在转发前被修好：否则网关会 400 掉整个请求，
    //      而 Codex 已把坏条目写进会话历史，该会话此后每轮都失败。
    const repaired = await post(listenPort, {
      model: 'ccs-deepseek/auto(free)',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fork_turns: none' }] },
        { type: 'function_call', name: 'spawn_agent', call_id: 'call-e2e', arguments: '{"agent_type": "deepseek_auto", "fork_turns": none}' },
        { type: 'function_call_output', call_id: 'call-e2e', output: 'failed to parse function arguments' },
      ],
    });
    assert.equal(repaired.status, 200);
    assert.equal(received.length, 2, '上游应收到第二次请求');
    const repairedBody = received[1].body;
    const repairedParsed = JSON.parse(repairedBody);
    const repairedCall = repairedParsed.input.find((item) => item.type === 'function_call');
    assert.ok(repairedCall.arguments.includes('"fork_turns": "none"'), '转发出去的 arguments 必须是合法 JSON：' + repairedCall.arguments);
    assert.equal(JSON.parse(repairedCall.arguments).fork_turns, 'none', '裸词必须被补成字符串 none');
    assert.equal(repairedParsed.input[0].content[0].text, 'fork_turns: none', '普通消息正文里的同样文字不得被改动');
    const healthAfter = await waitHealth(listenPort, 5000);
    assert.ok(healthAfter && healthAfter.stats && healthAfter.stats.argsRepaired >= 1,
      '健康检查必须统计到参数修复次数：' + JSON.stringify(healthAfter && healthAfter.stats));

    killTree(watchdog.pid);
    watchdog = null;
    await new Promise((resolve) => setTimeout(resolve, 800));

    // 3) 还原
    const restored = runCommandStub('restore', listenPort, upstreamPort);
    assert.equal(restored.status, 0, '还原应成功：' + restored.stdout + restored.stderr);
    const after = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.ok(after.includes('base_url = "' + originalUrl + '"'), 'base_url 必须还原为原始上游');
    const afterManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(afterManifest.installed, false, '还原后清单应标记未安装');

    // 4) 卸载（含 --purge）：配置保持还原后的原上游，运行目录被清理
    const removed = runCommandStub('uninstall --purge', listenPort, upstreamPort);
    assert.equal(removed.status, 0, '卸载应成功：' + removed.stdout + removed.stderr);
    assert.equal(fs.existsSync(compatHome), false, '--purge 必须删除运行目录');
    const afterUninstall = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.ok(afterUninstall.includes('base_url = "' + originalUrl + '"'), '卸载后 base_url 必须停留在原始上游');

    console.log('INSTALL_E2E_TEST_PASS：安装改写、真实转发（剥离标记/Host 重写/认证头透传）、按清单还原、卸载清理全部通过。');
  } finally {
    if (watchdog) {
      killTree(watchdog.pid);
    }
    if (upstream) {
      await new Promise((resolve) => upstream.close(resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
