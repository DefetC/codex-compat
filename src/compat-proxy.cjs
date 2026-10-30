// codex-compat 兼容层入口：Codex → 本进程 → 上游（CC Switch 或自定义端点）。
//
// 改写规则集中在 src/rewrite.cjs（纯函数），请求头规范化在 src/headers.cjs，
// 本文件只负责 HTTP 收发、日志、健康检查与统计。
const http = require('node:http');
const https = require('node:https');
const fzstd = require('fzstd');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
// 接收正文和解压结果共用默认限额，运行配置可以进一步收紧。
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
// 保留 UTF-8 BOM 给 JSON 解析器检查，不通过替换非法字节悄悄修复正文。
const REQUEST_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const trace = require('./trace.cjs');
const config = require('./config.cjs');
const { rewriteRequest } = require('./rewrite.cjs');
const { normalizeHeaders } = require('./headers.cjs');
const { normalizeOrphanToolOutputs } = require('./compat-input.cjs');
const repairArgs = require('./repair-args.cjs');
const catalog = require('./catalog.cjs');
const { redactValue } = require('./redact.cjs');

// 中文注释：启动时间，用于健康检查展示运行时长
const startedAt = Date.now();

// 中文注释：进程级统计
const stats = { requests: 0, rewritten: 0, stripped: 0, projected: 0, orphanOutputs: 0, argsRepaired: 0, rejected: 0, errors: 0, filteredOutputIncludes: 0, decodedBodies: 0, compactionSummariesProjected: 0 };

// 中文注释：从运行目录推导实例名（instances/<name>/compat → <name>，否则 main）
function instanceName(home) {
  const parts = String(home || '').split(/[\\/]/).filter(Boolean);
  const index = parts.lastIndexOf('instances');
  if (index >= 0 && parts.length > index + 1) {
    return parts[index + 1];
  }
  return 'main';
}

// 按声明的编码解压并严格校验 UTF-8，失败仍兼容旧接口的 null 返回值。
function decodeBody(body, encoding, maxBytes = DEFAULT_MAX_BODY_BYTES, onError) {
  const value = String(encoding || '').trim().toLowerCase();
  try {
    let decoded = body;
    if (value === 'zstd') {
      // fzstd 当前接口先分配解压结果；此处保证超限结果不转发，不宣称消除全部预分配风险。
      decoded = fzstd.decompress(body);
    } else if (value === 'gzip') {
      decoded = zlib.gunzipSync(body, { maxOutputLength: maxBytes });
    } else if (value === 'deflate') {
      decoded = zlib.inflateSync(body, { maxOutputLength: maxBytes });
    } else if (value && value !== 'identity') {
      throw new Error('不支持的请求压缩编码');
    }
    if (decoded.length > maxBytes) {
      const err = new RangeError('解压后的请求正文超限');
      err.code = 'ERR_BUFFER_TOO_LARGE';
      throw err;
    }
    return REQUEST_DECODER.decode(decoded);
  } catch (err) {
    if (typeof onError === 'function') {
      onError(err);
    } else {
      console.error('[codex-compat] 请求正文解码失败', err);
    }
    return null;
  }
}

// 本地错误只返回固定说明，不把 JSON 解析器中的正文片段或认证信息回显。
function respondError(res, status, code, message) {
  const payload = JSON.stringify({ error: { message, type: 'invalid_request_error', code } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

// 中文注释：创建事件日志写入器，达到上限自动滚动
function createEventLog(logDir, maxBytes) {
  let stream = null;
  let bytes = 0;
  let currentPath = null;
  function roll() {
    if (stream && bytes < maxBytes) {
      return;
    }
    try {
      if (stream) {
        stream.end();
      }
      fs.mkdirSync(logDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      currentPath = path.join(logDir, 'compat-' + stamp + '.jsonl');
      stream = fs.createWriteStream(currentPath, { flags: 'a' });
      stream.on('error', (err) => console.error('[codex-compat] 事件日志写入失败', err));
      bytes = 0;
    } catch (err) {
      console.error('[codex-compat] 事件日志打开失败', err);
      stream = null;
    }
  }
  return {
    // 异常对象传入日志 API，但只序列化安全的类型和错误码，禁止落正文片段或密文。
    write(obj, error) {
      try {
        if (error) {
          obj = Object.assign({}, obj, { level: 'error', error: { name: error.name || 'Error', code: error.code === undefined ? null : error.code } });
        }
        roll();
        if (!stream) {
          return;
        }
        // 模型名、工具名等元数据也可能误带凭据，落盘前再做统一兜底。
        const line = JSON.stringify(redactValue(obj)) + '\n';
        bytes += Buffer.byteLength(line);
        stream.write(line);
      } catch (err) {
        // 日志失败不能阻断转发，但必须保留真实异常用于排查日志设施。
        console.error('[codex-compat] 事件日志记录失败', err);
      }
    },
    path: () => currentPath,
    close() {
      try {
        if (stream) {
          stream.end();
          stream = null;
        }
      } catch (err) {
        console.error('[codex-compat] 事件日志关闭失败', err);
      }
    },
  };
}

// 中文注释：创建兼容层 HTTP 服务；测试可直接调用并传入覆盖配置
function createCompatServer(options = {}) {
  const base = options.cfg || config.loadSafe(options.configInput).cfg;
  const cfg = Object.assign({}, base, options.overrides || {});
  const log = createEventLog(options.logDir || config.paths(cfg.home).logs, cfg.runtime.logMaxBytes || 16 * 1024 * 1024);
  // 接收正文与解压结果必须使用同一限额。
  const maxBodyBytes = cfg.runtime.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;

  const server = http.createServer((req, res) => {
    // 中文注释：健康检查端点，同时作为端口身份签名
    if (req.method === 'GET' && req.url === '/__compat/health') {
      // 中文注释：优先报告真实绑定端口，兼容 server.listen(0) 这类临时端口场景
      const address = typeof server.address === 'function' ? server.address() : null;
      const payload = JSON.stringify({
        name: 'codex-compat',
        version: config.version(),
        port: address && address.port ? address.port : cfg.listen.port,
        // 中文注释：home 用于端口复用判据；instance 仅用于展示
        home: cfg.home,
        instance: instanceName(cfg.home),
        upstreamHost: cfg.upstream.host,
        upstreamPort: cfg.upstream.port,
        mode: cfg.upstream.mode,
        uptimeMs: Date.now() - startedAt,
        stats,
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }

    // 中文注释：provider 级模型目录；只读本地缓存文件，不透明转发、不记录认证头
    if (req.method === 'GET' && req.url === '/__compat/catalog') {
      const data = catalog.read(cfg.home);
      if (!data) {
        const payload = JSON.stringify({ error: { message: 'codex-compat: catalog not generated yet', code: 'catalog_missing' } });
        res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      const payload = JSON.stringify(data);
      // 中文注释：目录被 Codex 拉取时记一条事件，便于排查"提示词没生效"
      log.write({ ts: new Date().toISOString(), event: 'catalog_served', models: Array.isArray(data.models) ? data.models.length : 0 });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }

    const chunks = [];
    let received = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) {
        return;
      }
      received += chunk.length;
      if (received > maxBodyBytes) {
        aborted = true;
        stats.requests++;
        stats.rejected++;
        stats.errors++;
        log.write({ ts: new Date().toISOString(), event: 'body_too_large', bytes: received }, new RangeError('接收的请求正文超限'));
        // 丢弃后续字节但不立即销毁响应 socket，确保客户端真正收到 413。
        try {
          respondError(res, 413, 'body_too_large', 'codex-compat: request body too large');
        } catch (err) {
          log.write({ ts: new Date().toISOString(), event: 'response_error' }, err);
        }
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) {
        return;
      }
      const body = Buffer.concat(chunks);
      stats.requests++;
      let out = body;
      let reject = null;

      const pathname = String(req.url || '').split('?')[0];
      if (req.method === 'POST' && /\/responses(?:\/compact)?\/?$/.test(pathname)) {
        const encoding = String(req.headers['content-encoding'] || '').trim().toLowerCase();
        let decodeError = null;
        const text = decodeBody(body, encoding, maxBodyBytes, (err) => {
          decodeError = err;
          // 仅记录已知编码名和异常类型，不落请求头中的任意字符串或解码正文。
          log.write({ ts: new Date().toISOString(), event: 'decode_error', encoding: ['gzip', 'deflate', 'zstd', 'identity', ''].includes(encoding) ? encoding : 'unsupported' }, err);
        });
        if (text === null) {
          stats.errors++;
          stats.rejected++;
          const oversized = decodeError && decodeError.code === 'ERR_BUFFER_TOO_LARGE';
          respondError(res, oversized ? 413 : 400, oversized ? 'body_too_large' : 'decode_error', 'codex-compat: request decoding failed');
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new TypeError('Responses 请求根节点必须是对象');
          }
        } catch (err) {
          stats.errors++;
          stats.rejected++;
          // SyntaxError.message 可能带原始正文，异常只交给元数据日志 API。
          log.write({ ts: new Date().toISOString(), event: 'parse_error', bytes: body.length }, err);
          respondError(res, 400, 'parse_error', 'codex-compat: invalid JSON request object');
          return;
        }
        try {
          trace.traceRequest(parsed, req.url);
          const result = rewriteRequest(parsed, Object.assign({}, cfg.compat, {
            upstream: cfg.upstream,
            // 摘要解析异常也不得带上摘要正文或封装内容。
            onNormalizationError: (err) => log.write({ ts: new Date().toISOString(), event: 'compaction_error' }, err),
          }));
          reject = result.reject;
          if (!reject && result.policy.normalizeOrphanOutputs) {
            result.stat.orphanOutputs = normalizeOrphanToolOutputs(parsed);
          }
          // 非法工具参数仍在原有窄范围内修复，不再把裸词写进日志。
          result.stat.argsRepaired = reject ? [] : repairArgs.repairInputArguments(parsed);
          const changed = result.stat.stripped.length || result.stat.projected || result.stat.orphanOutputs || result.stat.argsRepaired.length || result.stat.filteredIncludes.length || result.stat.compactionSummariesProjected;
          const decoded = !!encoding && encoding !== 'identity' && (changed || result.policy.decodeRequest);
          if (changed) {
            stats.rewritten++;
            out = Buffer.from(JSON.stringify(parsed), 'utf8');
          } else if (decoded) {
            // 无语义变化时保留原 JSON 文本，只改变 HTTP 的压缩表示。
            out = Buffer.from(text, 'utf8');
          }
          stats.stripped += result.stat.stripped.length;
          stats.projected += result.stat.projected;
          stats.orphanOutputs += result.stat.orphanOutputs;
          stats.argsRepaired += result.stat.argsRepaired.length;
          stats.filteredOutputIncludes += result.stat.filteredIncludes.length;
          stats.compactionSummariesProjected += result.stat.compactionSummariesProjected;
          if (decoded && !reject) {
            stats.decodedBodies++;
          }
          if (result.stat.argsRepaired.length) {
            log.write({
              ts: new Date().toISOString(),
              event: 'args_repaired',
              model: parsed.model,
              tools: result.stat.argsRepaired.map(item => item.name),
              count: result.stat.argsRepaired.length,
            });
          }
          if (changed || decoded || result.stat.opaque || reject) {
            log.write({
              ts: new Date().toISOString(),
              event: 'rewrite',
              model: parsed.model,
              kind: result.official ? 'official' : (result.third ? 'thirdparty' : 'other'),
              routeKind: result.policy.routeKind,
              stripped: result.stat.stripped,
              projected: result.stat.projected,
              opaque: result.stat.opaque,
              orphanOutputs: result.stat.orphanOutputs,
              argsRepaired: result.stat.argsRepaired.length,
              filteredOutputIncludes: result.stat.filteredIncludes.length,
              compactionSummariesProjected: result.stat.compactionSummariesProjected,
              decoded: !!decoded && !reject,
              rejected: !!reject,
            });
          }
        } catch (err) {
          stats.errors++;
          stats.rejected++;
          log.write({ ts: new Date().toISOString(), event: 'rewrite_error' }, err);
          respondError(res, 500, 'rewrite_error', 'codex-compat: request rewriting failed');
          return;
        }
      }

      if (reject) {
        stats.rejected++;
        const payload = JSON.stringify({ error: { message: reject, type: 'invalid_request_error', code: 'compat_layer_reject' } });
        res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }

      const headers = normalizeHeaders(req.headers, cfg.upstream.host, cfg.upstream.port);
      delete headers['content-length'];
      headers['content-length'] = Buffer.byteLength(out);
      // 中文注释：改写后原压缩声明失效，必须移除，避免下游按旧编码解析
      if (out !== body) {
        delete headers['content-encoding'];
      }

      // 中文注释：按上游协议选择客户端；https 上游同样支持
      const upstreamSecure = /^https:/i.test(String(cfg.upstream.baseUrl || '')) || cfg.upstream.protocol === 'https:';
      const upstreamClient = upstreamSecure ? https : http;
      const proxied = upstreamClient.request({
        host: cfg.upstream.host,
        port: cfg.upstream.port,
        method: req.method,
        path: req.url,
        headers,
      }, (upstream) => {
        res.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(res);
      });

      // 中文注释：客户端主动断开时（流式取消/切页），上游会报 ECONNRESET，这不是上游故障
      let clientAborted = false;
      req.on('aborted', () => { clientAborted = true; proxied.destroy(); });
      res.on('close', () => {
        if (!res.writableEnded) {
          clientAborted = true;
          proxied.destroy();
        }
      });

      proxied.on('error', (err) => {
        if (clientAborted) {
          log.write({ ts: new Date().toISOString(), event: 'client_aborted', code: err && err.code ? err.code : null });
          return;
        }
        stats.errors++;
        log.write({ ts: new Date().toISOString(), event: 'upstream_error' }, err);
        try {
          if (res.headersSent) {
            res.destroy();
          } else {
            respondError(res, 502, 'upstream_error', 'codex-compat: upstream unreachable');
          }
        } catch (e) {
          log.write({ ts: new Date().toISOString(), event: 'response_error' }, e);
        }
      });

      proxied.end(out);
    });
  });

  server.compatLog = log;
  server.compatConfig = cfg;
  // 中文注释：服务关闭时释放日志流；Windows 上句柄不释放会挡住临时目录删除
  server.on('close', () => log.close());
  return server;
}

// 中文注释：作为主进程启动时监听配置端口
function main() {
  // 中文注释：支持 --home，使进程命令行可被精确识别，并让运行目录一致
  const argv = process.argv.slice(2);
  const homeIndex = argv.indexOf('--home');
  if (homeIndex >= 0 && argv[homeIndex + 1]) {
    process.env.CODEX_COMPAT_HOME = argv[homeIndex + 1];
  }
  const { cfg, error } = config.loadSafe();
  if (error) {
    console.error('[codex-compat] 配置加载失败，已退回默认值：' + error);
  }
  const server = createCompatServer({ cfg });
  server.on('error', (err) => {
    server.compatLog.write({ ts: new Date().toISOString(), event: 'listen_error' }, err);
    console.error('[codex-compat] 监听失败', { name: err.name, code: err.code });
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    server.compatLog.write({ ts: new Date().toISOString(), event: 'uncaught' }, err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    server.compatLog.write({ ts: new Date().toISOString(), event: 'unhandled_rejection' }, err instanceof Error ? err : new Error('未处理的 Promise 拒绝'));
  });
  server.listen(cfg.listen.port, cfg.listen.host, () => {
    server.compatLog.write({
      ts: new Date().toISOString(),
      event: 'started',
      port: cfg.listen.port,
      host: cfg.listen.host,
      upstream: cfg.upstream.host + ':' + cfg.upstream.port,
      stripAlways: cfg.compat.stripAlways,
      version: config.version(),
    });
    console.log('codex-compat listening on http://' + cfg.listen.host + ':' + cfg.listen.port
      + ' -> ' + cfg.upstream.host + ':' + cfg.upstream.port);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createCompatServer, decodeBody, stats, instanceName };
