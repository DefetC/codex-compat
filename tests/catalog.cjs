// provider 目录托管测试：上游 /models → Codex 目录 → 注入模板 → 兼容层端点可读。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const catalog = require('../src/catalog.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-catalog-'));

(async () => {
  let upstream = null;
  let proxy = null;
  try {
    const home = path.join(root, 'compat');
    const mappingDir = path.join(root, 'config');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(mappingDir, { recursive: true });
    fs.writeFileSync(path.join(mappingDir, 'model.toml'), '[text_files]\nbase_instructions = "prompt.md"\n');
    fs.writeFileSync(path.join(mappingDir, 'prompt.md'), 'deepseek-template\n');
    fs.writeFileSync(path.join(mappingDir, 'mappings.toml'), 'version = 1\n[[bindings]]\nmodel_id_like = "deepseek-v4.1-flash"\nmodel_template = "model.toml"\n');

    // 假上游：/v1/models 返回 OpenAI 风格列表
    upstream = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'other/deepseek-v4.1-flash' }, { id: 'gpt-6.1-sol' }] }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;

    // 1) 刷新目录
    const result = await catalog.refresh({
      home,
      upstream: { host: '127.0.0.1', port: upstreamPort, basePath: '/v1', mode: 'custom' },
      mappingFile: path.join(mappingDir, 'mappings.toml'),
    });
    assert.equal(result.ok, true, '目录刷新应成功：' + JSON.stringify(result));
    assert.equal(result.total, 2);
    assert.equal(result.injected.length, 1, '只应注入命中 like 的模型');
    const written = catalog.read(home);
    assert.equal(written.models.length, 2);
    const deepseek = written.models.find((model) => model.slug === 'other/deepseek-v4.1-flash');
    const official = written.models.find((model) => model.slug === 'gpt-6.1-sol');
    assert.equal(deepseek.base_instructions, 'deepseek-template\n', '命中的模型必须带提示词');
    assert.equal(deepseek.multi_agent_version, 'v2');
    assert.equal(official.base_instructions, undefined, '官方模型不得被写入');

    // 2) 上游不可达时保留旧缓存并告警
    const failed = await catalog.refresh({
      home,
      upstream: { host: '127.0.0.1', port: 1, basePath: '/v1' },
      mappingFile: path.join(mappingDir, 'mappings.toml'),
      timeoutMs: 1500,
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.keptCache, true, '失败时必须保留旧目录');
    assert.ok(catalog.read(home), '旧目录仍可读');

    // 3) 兼容层端点返回目录；未生成时 404
    const { createCompatServer } = require('../src/compat-proxy.cjs');
    const cfg = {
      home,
      listen: { host: '127.0.0.1', port: 0 },
      upstream: { host: '127.0.0.1', port: upstreamPort, basePath: '/v1', mode: 'custom' },
      compat: { stripAlways: true, thirdPartyPrefixes: ['ccs-', 'ccs/'] },
      runtime: {},
    };
    proxy = createCompatServer({ cfg, logDir: path.join(root, 'logs') });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const port = proxy.address().port;
    const fetched = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/__compat/catalog', timeout: 3000 }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject);
    });
    assert.equal(fetched.status, 200);
    assert.equal(JSON.parse(fetched.body).models.length, 2);

    const emptyHome = path.join(root, 'empty');
    fs.mkdirSync(emptyHome, { recursive: true });
    const emptyProxy = createCompatServer({ cfg: Object.assign({}, cfg, { home: emptyHome }), logDir: path.join(root, 'logs2') });
    await new Promise((resolve) => emptyProxy.listen(0, '127.0.0.1', resolve));
    const emptyPort = emptyProxy.address().port;
    const missing = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: emptyPort, path: '/__compat/catalog', timeout: 3000 }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    assert.equal(missing, 404, '未生成目录时必须返回 404');
    await new Promise((resolve) => emptyProxy.close(resolve));

    // 4) 健康检查带 home/instance 身份
    const health = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/__compat/health', timeout: 3000 }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      }).on('error', reject);
    });
    assert.equal(health.home, home);
    assert.equal(health.instance, 'main');

    // 5) 原生目录探测：上游自带提示词模板时不得被托管覆盖
    const nativeServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'ccs/x', model_messages: { instructions_template: 'native' } }] }));
    });
    await new Promise((resolve) => nativeServer.listen(0, '127.0.0.1', resolve));
    const nativePort = nativeServer.address().port;
    const nativeProbe = await catalog.probe({ host: '127.0.0.1', port: nativePort, basePath: '/v1' });
    assert.equal(nativeProbe.ok, true);
    assert.equal(nativeProbe.native, true, '原生目录必须被识别');
    const openaiProbe = await catalog.probe({ host: '127.0.0.1', port: upstreamPort, basePath: '/v1' });
    assert.equal(openaiProbe.native, false, '纯 OpenAI 风格列表不应被当成原生目录');
    await new Promise((resolve) => nativeServer.close(resolve));

    console.log('CATALOG_TEST_PASS');
  } finally {
    if (proxy) {
      await new Promise((resolve) => proxy.close(resolve));
    }
    if (upstream) {
      await new Promise((resolve) => upstream.close(resolve));
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
