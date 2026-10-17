// provider 目录托管安装回归：没有本地目录时才写 model_catalog_url，restore 能精确回收。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-catinstall-'));

// 中文注释：取一个空闲端口
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

// 中文注释：构造 fixture；withCatalog=true 时预置本地目录文件，
// seedFeatures 会预写 compatHome/config.json，用于显式打开默认关闭的功能开关
function fixture(name, upstreamPort, withCatalog, seedFeatures) {
  const dir = path.join(root, name);
  const home = path.join(dir, 'codex');
  const compatHome = path.join(dir, 'compat');
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  if (seedFeatures) {
    fs.mkdirSync(compatHome, { recursive: true });
    fs.writeFileSync(path.join(compatHome, 'config.json'),
      JSON.stringify({ features: seedFeatures }), 'utf8');
  }
  fs.writeFileSync(path.join(home, 'config.toml'),
    '[model_providers.custom]\nname = "Fake"\nbase_url = "http://127.0.0.1:' + upstreamPort + '/v1"\nwire_api = "responses"\n');
  if (withCatalog) {
    fs.writeFileSync(path.join(home, 'cc-switch-model-catalog.json'),
      JSON.stringify({ models: [{ slug: 'vendor/deepseek-v4.1-flash' }] }));
  }
  fs.writeFileSync(path.join(configDir, 'model.toml'), '[text_files]\nbase_instructions = "prompt.md"\n');
  fs.writeFileSync(path.join(configDir, 'prompt.md'), 'catalog-template\n');
  fs.writeFileSync(path.join(configDir, 'mappings.toml'),
    'version = 1\n[[bindings]]\nmodel_id_like = "deepseek-v4.1-flash"\nmodel_template = "model.toml"\n');
  return { dir, home, compatHome, mappingFile: path.join(configDir, 'mappings.toml') };
}

// 中文注释：带桩执行 install / restore；用异步 spawn 以免阻塞本进程里的假上游
function runCommand(command, fixturePaths, port) {
  const code = [
    "const platform=require('./src/platform.cjs');",
    "const ports=require('./src/ports.cjs');",
    "const processes=require('./src/processes.cjs');",
    "platform.installService=()=>({ok:true,detail:'mock'});",
    "platform.registerGuard=()=>({ok:true,detail:'mock'});",
    "platform.uninstallService=()=>({ok:true,detail:'mock'});",
    "platform.unregisterGuard=()=>({ok:true,detail:'mock'});",
    "platform.startWatchdogDetached=()=>({ok:true,detail:'mock'});",
    "platform.cleanupOwnLegacyTasks=()=>({removed:[],detail:'mock'});",
    "platform.cleanupLegacyTasks=()=>({removed:[],detail:'mock'});",
    "platform.legacyTasks=()=>[];",
    "processes.killInstance=async()=>({killed:[],remaining:[]});",
    "ports.probeCompat=async(host,p)=>(p===" + port + "?{ours:true,data:{name:'codex-compat',version:'t',home:" + JSON.stringify(fixturePaths.compatHome) + "}}:{ours:false,data:null});",
    "process.argv=['node','codex-compat'," + JSON.stringify(command) + ",'--yes','--port'," + JSON.stringify(String(port)) + "];",
    "require('./src/commands/index.cjs').run(process.argv.slice(2)).then((c)=>{process.exitCode=c;});",
  ].join('');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code], {
      cwd: repo,
      env: Object.assign({}, process.env, {
        CODEX_HOME: fixturePaths.home,
        CODEX_COMPAT_HOME: fixturePaths.compatHome,
        CODEX_MAPPING_FILE: fixturePaths.mappingFile,
      }),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

(async () => {
  let upstream = null;
  try {
    upstream = http.createServer((req, res) => {
      if (/\/models$/.test(req.url || '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'vendor/deepseek-v4.1-flash' }, { id: 'gpt-6.1-sol' }] }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;

    // 场景 0：默认配置（provider 目录托管默认关）→ 不得写 URL，也不得生成目录文件
    const defaultOff = fixture('default-off', upstreamPort, false, null);
    const portOff = await freePort();
    const installedOff = await runCommand('install', defaultOff, portOff);
    assert.equal(installedOff.status, 0, '安装应成功：' + installedOff.stdout + installedOff.stderr);
    assert.ok(!fs.readFileSync(path.join(defaultOff.home, 'config.toml'), 'utf8').includes('model_catalog_url'),
      '默认关闭时不得写 provider 目录 URL');
    assert.ok(!fs.existsSync(path.join(defaultOff.compatHome, 'catalog.json')),
      '默认关闭时不得生成目录文件');

    // 场景 1：显式打开开关且没有任何本地目录 → 必须托管 provider 目录
    const bare = fixture('bare', upstreamPort, false, { providerCatalog: true });
    const port = await freePort();
    const installed = await runCommand('install', bare, port);
    assert.equal(installed.status, 0, '安装应成功：' + installed.stdout + installed.stderr);
    const wired = fs.readFileSync(path.join(bare.home, 'config.toml'), 'utf8');
    assert.ok(wired.includes('model_catalog_url = "http://127.0.0.1:' + port + '/__compat/catalog"'),
      '缺少 provider 目录 URL。install 输出：\n' + installed.stdout + '\n--- config.toml ---\n' + wired);
    const generated = JSON.parse(fs.readFileSync(path.join(bare.compatHome, 'catalog.json'), 'utf8'));
    const deepseek = generated.models.find((model) => model.slug === 'vendor/deepseek-v4.1-flash');
    assert.equal(deepseek.base_instructions, 'catalog-template\n', '目录必须注入匹配到的提示词');
    // 中文注释：纯官方保护——命中官方命名的模型绝不注入提示词
    const official = generated.models.find((model) => model.slug === 'gpt-6.1-sol');
    assert.equal(official.base_instructions, undefined, '官方模型不得被注入提示词');

    // 还原后必须回收 model_catalog_url
    const restored = await runCommand('restore', bare, port);
    assert.equal(restored.status, 0, '还原应成功：' + restored.stdout + restored.stderr);
    assert.ok(!fs.readFileSync(path.join(bare.home, 'config.toml'), 'utf8').includes('model_catalog_url'), 'restore 必须回收 provider 目录 URL');

    // 场景 2：开关打开但已有本地目录文件 → 保持文件补丁方式，不得写 provider 目录 URL
    const withCatalog = fixture('with-catalog', upstreamPort, true, { providerCatalog: true });
    const port2 = await freePort();
    const installed2 = await runCommand('install', withCatalog, port2);
    assert.equal(installed2.status, 0, '安装应成功：' + installed2.stdout + installed2.stderr);
    const wired2 = fs.readFileSync(path.join(withCatalog.home, 'config.toml'), 'utf8');
    assert.ok(!wired2.includes('model_catalog_url'), '已有本地目录时不得写 provider 目录 URL');

    console.log('CATALOG_INSTALL_TEST_PASS');
  } finally {
    if (upstream) {
      await new Promise((resolve) => upstream.close(resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
