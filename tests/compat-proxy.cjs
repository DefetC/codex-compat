// 真实 HTTP 边界回归：不能用纯改写通过或上游返回 400 代替本地拒绝证据。
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const config = require('../src/config.cjs');
// 本测试只核对默认事件日志，不把合成任务写入用户启用的 trace 目录。
process.env.COMPAT_TRACE = '0';
const { createCompatServer } = require('../src/compat-proxy.cjs');

// 标准 zstd 原始块，解压后固定为下面的非敏感 JSON，不依赖生产解码器生成期望值。
const ZSTD_REQUEST = Buffer.from('KLUv/SAf+QAAeyJtb2RlbCI6ImdwdC10ZXN0IiwiaW5wdXQiOltdfQ==', 'base64');
// 三种压缩格式共用的原始正文。
const PLAIN_REQUEST = '{"model":"gpt-test","input":[]}';
// 合成凭据只用于检查转发与脱敏，不是任何服务签发的令牌。
const AUTH = 'Bearer SYNTHETIC_PROXY_AUTH_DO_NOT_LOG';
// 合成任务只验证拒绝或字节透传，不证明上游能解密。
const OPAQUE = 'gAAAAAB_SYNTHETIC_PROXY_TASK_DO_NOT_LOG';
// 摘要正文需要完整恢复，但不能出现在默认日志中。
const SUMMARY = 'SYNTHETIC_SUMMARY_DO_NOT_LOG：上轮合计 87。';
// 带 CRLF 的原始 SSE 响应，包括合成输出密文，代理不得重写响应。
const SSE = 'event: response.completed\r\ndata: {"output":[{"encrypted_content":"SYNTHETIC_RESPONSE_CIPHER"}]}\r\n\r\n';

// 监听随机端口，避免干扰本机真实服务。
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// 关闭本测试创建的服务器并等待连接释放。
function close(server) {
  return new Promise((resolve) => {
    if (server.closeAllConnections) {
      server.closeAllConnections();
    }
    server.close(resolve);
  });
}

// 请求有界等待，失败时终止自己的连接，不留下挂起的测试进程。
function request(port, body, encoding, route = '/v1/responses') {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(body);
    const headers = { authorization: AUTH, 'content-type': 'application/json' };
    if (bytes) {
      headers['content-length'] = bytes.length;
    }
    if (encoding) {
      headers['content-encoding'] = encoding;
    }
    const req = http.request({ host: '127.0.0.1', port, path: route, method: bytes ? 'POST' : 'GET', agent: false, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('测试请求超时')));
    req.on('error', reject);
    req.end(bytes);
  });
}

// 覆盖所有边界后统一报告红灯，保证缺失功能不会掩盖后续独立用例。
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-proxy-'));
  const seen = [];
  const failures = [];
  let allowCompressed = false;
  let allowOutputInclude = false;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bytes = Buffer.concat(chunks);
      seen.push({ path: req.url, headers: req.headers, bytes });
      // 外部 JSON API 明确不支持压缩；不是让模拟服务解析乱码后意外崩溃。
      if (req.headers['content-encoding'] && !allowCompressed) {
        res.writeHead(415);
        res.end('模拟 API 不支持压缩');
        return;
      }
      if (!req.headers['content-encoding']) {
        let parsed;
        try {
          parsed = JSON.parse(bytes);
        } catch (err) {
          console.error('模拟 API 收到非法 JSON', err);
          res.writeHead(400);
          res.end('模拟 API 拒绝非法 JSON');
          return;
        }
        // 模拟服务也必须只识别精确选择器，正文中同名字符串不是非法参数。
        if (!allowOutputInclude && parsed && Array.isArray(parsed.include) && parsed.include.includes('output.encrypted_content')) {
          res.writeHead(400);
          res.end('模拟 API 拒绝输出回放选择器');
          return;
        }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-proxy-fixture': 'unchanged' });
      res.write(SSE.slice(0, 17));
      res.end(SSE.slice(17));
    });
  });
  const upstreamPort = await listen(upstream);
  const cfg = structuredClone(config.DEFAULTS);
  cfg.home = home;
  cfg.upstream = { mode: 'custom', host: '127.0.0.1', port: upstreamPort, basePath: '/v1' };
  cfg.runtime.maxBodyBytes = 1024;
  const server = createCompatServer({ cfg });
  const port = await listen(server);

  // 每个用例保留真实断言的堆栈，不能把失败改成默认成功。
  async function check(name, run) {
    try {
      await run();
    } catch (err) {
      failures.push(name);
      console.error('HTTP 回归失败：' + name, err);
    }
  }

  // 所有拒绝都必须由兼容层完成，上游请求数是不可省略的验收条件。
  async function rejectLocally(body, encoding, status = 400) {
    const before = seen.length;
    const result = await request(port, body, encoding);
    assert.equal(result.status, status);
    assert.equal(seen.length, before, '无效或被拒绝的任务不得抵达上游');
  }

  try {
    await check('仅选择器变化必须真正转发', async () => {
      cfg.upstream.mode = 'cc-switch';
      const before = JSON.parse((await request(port, undefined, undefined, '/__compat/health')).bytes).stats;
      const body = { model: 'ccs-vendor/gpt-test', input: [{ role: 'user', content: [{ type: 'input_text', text: 'output.encrypted_content 是普通正文' }] }], include: ['reasoning.encrypted_content', 'output.encrypted_content', 'future.extension'] };
      const result = await request(port, JSON.stringify(body));
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(seen.at(-1).bytes).include, ['reasoning.encrypted_content', 'future.extension']);
      assert.equal(seen.at(-1).headers.authorization, AUTH);
      assert.equal(seen.at(-1).path, '/v1/responses');
      assert.equal(Number(seen.at(-1).headers['content-length']), seen.at(-1).bytes.length);
      assert.equal(result.bytes.toString(), SSE);
      assert.equal(result.headers['x-proxy-fixture'], 'unchanged');
      assert.deepEqual(JSON.parse(seen.at(-1).bytes).input, body.input);
      const after = JSON.parse((await request(port, undefined, undefined, '/__compat/health')).bytes).stats;
      assert.equal(after.filteredOutputIncludes - before.filteredOutputIncludes, 1);
      assert.equal(after.rewritten - before.rewritten, 1);
    });

    await check('自定义同名 GPT 必须使用实际路由', async () => {
      cfg.upstream.mode = 'custom';
      const history = [
        { type: 'message', role: 'assistant', encrypted_content: 'SYNTHETIC_HISTORY_CIPHER', content: [{ type: 'output_text', text: '历史回答' }] },
        { type: 'reasoning', encrypted_content: 'SYNTHETIC_REASONING_CIPHER' },
        { type: 'compaction', encrypted_content: 'gAAAAAB_SYNTHETIC_NATIVE_COMPACTION' },
      ];
      const result = await request(port, JSON.stringify({ model: 'gpt-test', include: ['output.encrypted_content'], input: history }));
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(seen.at(-1).bytes).input, history);
    });

    // 固定 zstd 向量以及标准库生成的 gzip、deflate 均不得残留失效编码声明。
    for (const [encoding, bytes] of [['gzip', zlib.gzipSync(PLAIN_REQUEST)], ['deflate', zlib.deflateSync(PLAIN_REQUEST)], ['zstd', ZSTD_REQUEST]]) {
      await check(encoding + ' 无语义修改仍解压转发', async () => {
        const result = await request(port, bytes, encoding);
        assert.equal(result.status, 200);
        assert.equal(seen.at(-1).bytes.toString(), PLAIN_REQUEST);
        assert.equal(seen.at(-1).headers['content-encoding'], undefined);
        assert.equal(Number(seen.at(-1).headers['content-length']), Buffer.byteLength(PLAIN_REQUEST));
      });
    }

    await check('显式 preserve 保留原始压缩字节', async () => {
      cfg.compat.requestCompression = 'preserve';
      allowCompressed = true;
      const result = await request(port, ZSTD_REQUEST, 'zstd');
      assert.equal(result.status, 200);
      assert.deepEqual(seen.at(-1).bytes, ZSTD_REQUEST);
      assert.equal(seen.at(-1).headers['content-encoding'], 'zstd');
      cfg.compat.requestCompression = 'auto';
      allowCompressed = false;
    });

    await check('正文修改不受 preserve 豁免', async () => {
      cfg.compat.requestCompression = 'preserve';
      const bytes = zlib.gzipSync(JSON.stringify({ model: 'gpt-test', input: [], include: ['output.encrypted_content'] }));
      const result = await request(port, bytes, 'gzip');
      assert.equal(result.status, 200);
      assert.equal(seen.at(-1).headers['content-encoding'], undefined);
      assert.deepEqual(JSON.parse(seen.at(-1).bytes).include, []);
      cfg.compat.requestCompression = 'auto';
    });

    await check('官方 CC Switch 自动保留与显式解压', async () => {
      cfg.upstream.mode = 'cc-switch';
      allowCompressed = true;
      assert.equal((await request(port, ZSTD_REQUEST, 'zstd')).status, 200);
      assert.deepEqual(seen.at(-1).bytes, ZSTD_REQUEST);
      assert.equal(seen.at(-1).headers['content-encoding'], 'zstd');
      cfg.compat.requestCompression = 'decode';
      allowCompressed = false;
      assert.equal((await request(port, ZSTD_REQUEST, 'zstd')).status, 200);
      assert.equal(seen.at(-1).bytes.toString(), PLAIN_REQUEST);
      assert.equal(seen.at(-1).headers['content-encoding'], undefined);
      cfg.compat.requestCompression = 'auto';
      cfg.upstream.mode = 'custom';
    });
    await check('显式输出回放保留', async () => {
      cfg.compat.outputTokenReplay = 'preserve';
      allowOutputInclude = true;
      const body = JSON.stringify({ model: 'gpt-test', input: [], include: ['output.encrypted_content'] });
      assert.equal((await request(port, body)).status, 200);
      assert.equal(seen.at(-1).bytes.toString(), body);
      cfg.compat.outputTokenReplay = 'auto';
      allowOutputInclude = false;
    });

    await check('默认不透明任务本地拒绝', async () => {
      await rejectLocally(JSON.stringify({ model: 'gpt-test', input: [{ type: 'agent_message', content: [{ encrypted_content: OPAQUE }] }] }));
    });
    await check('精确名单不透明任务原样透传', async () => {
      cfg.compat.opaqueTaskModels = ['gpt-test'];
      const input = [{ type: 'agent_message', content: [{ encrypted_content: OPAQUE }] }];
      const result = await request(port, JSON.stringify({ model: 'gpt-test', input }));
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(seen.at(-1).bytes).input, input);
      cfg.compat.opaqueTaskModels = [];
    });
    await check('自定义 GPT 孤立工具输出归一化', async () => {
      const result = await request(port, JSON.stringify({ model: 'gpt-test', input: [{ type: 'function_call_output', call_id: null, output: 'SYNTHETIC_TOOL_RESULT' }] }));
      assert.equal(result.status, 200);
      const item = JSON.parse(seen.at(-1).bytes).input[0];
      assert.equal(item.role, 'user');
      assert.ok(JSON.stringify(item).includes('SYNTHETIC_TOOL_RESULT'));
    });

    await check('参数修复不得记录原始裸词', async () => {
      const input = [{ type: 'function_call', call_id: 'synthetic-call', name: 'ordinary_tool', arguments: '{"choice":SYNTHETIC_BAREWORD_SECRET}' }];
      assert.equal((await request(port, JSON.stringify({ model: 'gpt-test', input }))).status, 200);
      assert.deepEqual(JSON.parse(JSON.parse(seen.at(-1).bytes).input[0].arguments), { choice: 'SYNTHETIC_BAREWORD_SECRET' });
    });

    await check('摘要绕过 CC Switch 时恢复为 user', async () => {
      const input = [{ type: 'compaction', encrypted_content: 'ccswitch-compaction-v1:' + Buffer.from(SUMMARY).toString('base64url') }];
      const result = await request(port, JSON.stringify({ model: 'gpt-test', input }));
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(seen.at(-1).bytes).input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: SUMMARY }] }]);
    });
    await check('摘要经 CC Switch 保持原封装', async () => {
      cfg.upstream.mode = 'cc-switch';
      const input = [{ type: 'compaction', encrypted_content: 'ccswitch-compaction-v1:' + Buffer.from(SUMMARY).toString('base64') }];
      const result = await request(port, JSON.stringify({ model: 'gpt-test', input }));
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(seen.at(-1).bytes).input, input);
      cfg.upstream.mode = 'custom';
    });

    // 损坏和未知版本不能宽松解码后静默丢上下文。
    for (const value of ['ccswitch-compaction-v1:@@@', 'ccswitch-compaction-v1:', 'ccswitch-compaction-v1:Zh', 'ccswitch-compaction-v1:_w', 'ccswitch-compaction-v1:ICAg', 'ccswitch-compaction-v2:YWJj']) {
      await check('损坏摘要拒绝 ' + value, () => rejectLocally(JSON.stringify({ model: 'gpt-test', input: [{ type: 'compaction', encrypted_content: value }] })));
    }
    // 无效 JSON、非对象根和字符串内非法 UTF-8 都应在本地终止。
    for (const body of ['{SYNTHETIC_PARSE_SECRET', 'null', '[]', 'true', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]) {
      await check('JSON/UTF-8 本地拒绝', () => rejectLocally(body));
    }
    for (const encoding of ['gzip', 'deflate', 'zstd', 'unknown']) {
      await check(encoding + ' 损坏正文本地拒绝', () => rejectLocally('SYNTHETIC_DECODE_SECRET', encoding));
    }
    await check('解压结果超限', () => rejectLocally(zlib.gzipSync(JSON.stringify({ model: 'gpt-test', input: 'x'.repeat(2048) })), 'gzip', 413));
    await check('接收正文超限', () => rejectLocally('x'.repeat(2048), undefined, 413));
    await check('无关路径不作 JSON 改写', async () => {
      const body = JSON.stringify({ include: ['output.encrypted_content'] });
      allowOutputInclude = true;
      assert.equal((await request(port, body, undefined, '/v1/not-responses')).status, 200);
      assert.equal(seen.at(-1).bytes.toString(), body);
      allowOutputInclude = false;
    });

    await check('健康统计和默认日志只包含元数据', async () => {
      const health = await request(port, undefined, undefined, '/__compat/health');
      const stats = JSON.parse(health.bytes).stats;
      for (const key of ['filteredOutputIncludes', 'decodedBodies', 'compactionSummariesProjected']) {
        assert.equal(typeof stats[key], 'number');
        assert.ok(stats[key] > 0);
      }
      await close(server);
      const logs = fs.readdirSync(path.join(home, 'logs')).map((name) => fs.readFileSync(path.join(home, 'logs', name), 'utf8')).join('');
      for (const secret of [AUTH, OPAQUE, SUMMARY, 'SYNTHETIC_PARSE_SECRET', 'SYNTHETIC_DECODE_SECRET', 'SYNTHETIC_RESPONSE_CIPHER', 'SYNTHETIC_BAREWORD_SECRET']) {
        assert.equal(logs.includes(secret), false, '默认日志不得包含：' + secret);
        assert.equal(health.bytes.includes(Buffer.from(secret)), false);
      }
    });
  } finally {
    await close(server);
    await close(upstream);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  assert.deepEqual(failures, [], 'HTTP 边界回归必须全部通过');
  console.log('COMPAT_PROXY_TEST_PASS');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
