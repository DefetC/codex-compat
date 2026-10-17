// 隐私端到端自检（最重要）：兼容层转发必须成功、上游必须收到已改写的正文、事件日志不得落敏感信息
// 路径约定：本文件位于 tests/，仓库根是上一级
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createCompatServer } = require('../src/compat-proxy.cjs');

// 中文注释：鉴权令牌与任务正文，用于验证事件日志不落敏感信息
const SECRET_TOKEN = 'SECRET-TOKEN-12345';
const SECRET_TASK = 'MY_SECRET_TASK_PAYLOAD';

// 中文注释：让服务器监听端口（0 表示系统分配），返回真实端口
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

// 中文注释：发起一次 HTTP 请求，agent=false 避免 keep-alive 连接阻塞关服
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(Object.assign({ agent: false }, options), (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

// 中文注释：等待一小段时间，用于轮询异步落盘的日志
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 中文注释：读取日志目录下全部 compat-*.jsonl 文本
function readEventLog(logDir) {
  if (!fs.existsSync(logDir)) {
    return '';
  }
  return fs.readdirSync(logDir)
    .filter((name) => /^compat-.*\.jsonl$/.test(name))
    .map((name) => fs.readFileSync(path.join(logDir, name), 'utf8'))
    .join('');
}

// 中文注释：轮询等待 rewrite 事件落盘
async function waitForRewriteEvent(logDir, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let text = readEventLog(logDir);
  while (text.indexOf('"event":"rewrite"') < 0 && Date.now() < deadline) {
    await sleep(50);
    text = readEventLog(logDir);
  }
  return text;
}

async function main() {
  // 中文注释：假上游，记录收到的请求路径、请求头与请求体
  const upstreamSeen = { path: null, headers: null, body: '' };
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      upstreamSeen.path = req.url;
      upstreamSeen.headers = req.headers;
      upstreamSeen.body = Buffer.concat(chunks).toString('utf8');
      const payload = JSON.stringify({ ok: true, fromUpstream: true });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  const upstreamPort = await listen(upstream);

  // 中文注释：临时 home 与事件日志目录
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-privacy-home-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-privacy-logs-'));

  // 中文注释：兼容层配置（监听 0 端口，由系统分配，避免与真实实例抢占）
  const cfg = {
    home,
    listen: { host: '127.0.0.1', port: 0 },
    upstream: { host: '127.0.0.1', port: upstreamPort, basePath: '/v1', mode: 'custom' },
    compat: { stripAlways: true, thirdPartyPrefixes: ['ccs-', 'ccs/'] },
    runtime: {},
  };

  const server = createCompatServer({ cfg, logDir });
  const compatPort = await listen(server);

  try {
    // 中文注释：健康检查必须带上名字、上游端口与模式，作为端口身份签名
    const health = await request({ host: '127.0.0.1', port: compatPort, method: 'GET', path: '/__compat/health' });
    assert.equal(health.status, 200);
    const healthJson = JSON.parse(health.text);
    assert.equal(healthJson.name, 'codex-compat');
    assert.equal(healthJson.upstreamPort, upstreamPort);
    assert.equal(healthJson.mode, 'custom');
    assert.equal(typeof healthJson.uptimeMs, 'number');
    assert.equal(typeof healthJson.stats, 'object');

    // 中文注释：请求体包含 spawn_agent 的 encrypted 标记，且任务正文装在 encrypted_content 容器里
    const payload = {
      model: 'gpt-6-luna',
      stream: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请派发子代理' }] },
        { type: 'agent_message', id: 'am_secret', content: [{ type: 'encrypted_content', encrypted_content: SECRET_TASK }] },
      ],
      tools: [
        {
          type: 'function',
          name: 'spawn_agent',
          parameters: {
            type: 'object',
            properties: {
              message: { type: 'string', encrypted: true },
            },
          },
        },
      ],
    };
    const bodyText = JSON.stringify(payload);

    // 中文注释：经兼容层转发；鉴权头必须原样透传到上游
    const forwarded = await request({
      host: '127.0.0.1',
      port: compatPort,
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(bodyText),
        authorization: 'Bearer ' + SECRET_TOKEN,
      },
    }, bodyText);
    assert.equal(forwarded.status, 200, '兼容层必须成功转发上游响应');
    assert.deepEqual(JSON.parse(forwarded.text), { ok: true, fromUpstream: true });

    // 中文注释：上游确实收到了请求，路径与鉴权头保持原样
    assert.equal(upstreamSeen.path, '/v1/responses');
    assert.equal(upstreamSeen.headers.authorization, 'Bearer ' + SECRET_TOKEN);
    assert.equal(upstreamSeen.headers.host, '127.0.0.1:' + upstreamPort);

    // 中文注释：上游收到的正文里 encrypted 标记必须已被剥离
    assert.equal(upstreamSeen.body.indexOf('"encrypted"'), -1, 'encrypted 标记必须从转发正文中剥离');
    const upstreamJson = JSON.parse(upstreamSeen.body);
    assert.equal(upstreamJson.model, 'gpt-6-luna');
    assert.equal(
      Object.prototype.hasOwnProperty.call(upstreamJson.tools[0].parameters.properties.message, 'encrypted'),
      false,
    );
    // 中文注释：明文任务正文必须投影成标准 user 消息后完整送达
    assert.deepEqual(upstreamJson.input[1], {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: SECRET_TASK }],
    });

    // 中文注释：事件日志必须落 rewrite 事件，且不得包含鉴权令牌与任务正文
    const logText = await waitForRewriteEvent(logDir);
    assert.ok(logText.length > 0, '事件日志必须存在');
    assert.ok(logText.indexOf('"event":"rewrite"') >= 0, '事件日志必须包含 rewrite 事件');
    assert.equal(logText.indexOf(SECRET_TOKEN), -1, '事件日志不得包含鉴权令牌');
    assert.equal(logText.indexOf(SECRET_TASK), -1, '事件日志不得包含任务正文');
    // 中文注释：逐行 JSON 必须可解析，避免落盘内容被截断
    for (const line of logText.split('\n').filter((item) => item.trim() !== '')) {
      assert.doesNotThrow(() => JSON.parse(line), '事件日志每一行都必须是合法 JSON');
    }
    const rewriteEvent = logText.split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
      .find((item) => item.event === 'rewrite');
    assert.equal(rewriteEvent.kind, 'official');
    assert.deepEqual(rewriteEvent.stripped, ['spawn_agent']);
    assert.equal(rewriteEvent.projected, 1);

    // 中文注释：健康检查只在兼容层生效，未监听端口不可能是本工具实例
    await close(server);
    const afterClose = await request({
      host: '127.0.0.1',
      port: compatPort,
      method: 'GET',
      path: '/__compat/health',
    }).then(() => 'unexpected-success').catch(() => 'unreachable');
    assert.equal(afterClose, 'unreachable', '兼容层关闭后端口必须不可达');
  } finally {
    // 中文注释：关闭两个服务器、落地日志流，并清理临时目录
    await close(server);
    await close(upstream);
    if (server.compatLog) {
      server.compatLog.close();
    }
    fs.rmSync(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  console.log('PRIVACY_TEST_PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
