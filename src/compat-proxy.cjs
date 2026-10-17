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
const trace = require('./trace.cjs');
const config = require('./config.cjs');
const { rewriteRequest } = require('./rewrite.cjs');
const { normalizeHeaders } = require('./headers.cjs');
const { normalizeOrphanToolOutputs } = require('./compat-input.cjs');
const repairArgs = require('./repair-args.cjs');
const catalog = require('./catalog.cjs');

// 中文注释：启动时间，用于健康检查展示运行时长
const startedAt = Date.now();

// 中文注释：进程级统计
const stats = { requests: 0, rewritten: 0, stripped: 0, projected: 0, orphanOutputs: 0, argsRepaired: 0, rejected: 0, errors: 0 };

// 中文注释：从运行目录推导实例名（instances/<name>/compat → <name>，否则 main）
function instanceName(home) {
  const parts = String(home || '').split(/[\\/]/).filter(Boolean);
  const index = parts.lastIndexOf('instances');
  if (index >= 0 && parts.length > index + 1) {
    return parts[index + 1];
  }
  return 'main';
}

// 中文注释：按内容编码解压请求体
function decodeBody(body, encoding) {
  const value = (encoding || '').toLowerCase();
  try {
    if (value === 'zstd') {
      return Buffer.from(fzstd.decompress(body)).toString('utf8');
    }
    if (value === 'gzip') {
      return zlib.gunzipSync(body).toString('utf8');
    }
    if (value === 'deflate') {
      return zlib.inflateSync(body).toString('utf8');
    }
    return body.toString('utf8');
  } catch (err) {
    return null;
  }
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
      bytes = 0;
    } catch (err) {
      stream = null;
    }
  }
  return {
    write(obj) {
      try {
        roll();
        if (!stream) {
          return;
        }
        const line = JSON.stringify(obj) + '\n';
        bytes += Buffer.byteLength(line);
        stream.write(line);
      } catch (err) {
        // 中文注释：日志失败不能影响转发主链路
      }
    },
    path: () => currentPath,
    close() {
      try {
        if (stream) {
          stream.end();
        }
      } catch (err) {
        // 中文注释：关闭失败忽略
      }
    },
  };
}

// 中文注释：创建兼容层 HTTP 服务；测试可直接调用并传入覆盖配置
function createCompatServer(options = {}) {
  const base = options.cfg || config.loadSafe(options.configInput).cfg;
  const cfg = Object.assign({}, base, options.overrides || {});
  const log = createEventLog(options.logDir || config.paths(cfg.home).logs, cfg.runtime.logMaxBytes || 16 * 1024 * 1024);
  const maxBodyBytes = cfg.runtime.maxBodyBytes || 64 * 1024 * 1024;

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
      received += chunk.length;
      if (received > maxBodyBytes) {
        aborted = true;
        try {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'codex-compat: request body too large' } }));
        } catch (err) {
          // 中文注释：客户端可能已断开，忽略
        }
        req.destroy();
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

      if (req.method === 'POST' && /responses/.test(req.url || '')) {
        const text = decodeBody(body, req.headers['content-encoding']);
        if (text === null) {
          stats.errors++;
          log.write({ ts: new Date().toISOString(), event: 'decode_error', encoding: req.headers['content-encoding'] || null });
        } else {
          let parsed = null;
          try {
            parsed = JSON.parse(text);
            trace.traceRequest(parsed, req.url);
          } catch (err) {
            stats.errors++;
            log.write({ ts: new Date().toISOString(), event: 'parse_error', bytes: body.length });
          }
          if (parsed) {
            const result = rewriteRequest(parsed, {
              stripAlways: cfg.compat.stripAlways,
              thirdPartyPrefixes: cfg.compat.thirdPartyPrefixes,
            });
            if (result.third) {
              result.stat.orphanOutputs = normalizeOrphanToolOutputs(parsed);
            }
            // 中文注释：非法工具参数（值位置上的裸词，如 fork_turns: none）会让网关 400 掉整个请求，
            // 而 Codex 已把坏条目写进会话历史并每轮重放 —— 这里窄范围修复，避免会话被一次手滑打死。
            result.stat.argsRepaired = repairArgs.repairInputArguments(parsed);
            reject = result.reject;
            const changed = result.stat.stripped.length || result.stat.projected || result.stat.orphanOutputs || result.stat.argsRepaired.length;
            if (changed) {
              stats.rewritten++;
            }
            stats.stripped += result.stat.stripped.length;
            stats.projected += result.stat.projected;
            stats.orphanOutputs += result.stat.orphanOutputs;
            stats.argsRepaired += result.stat.argsRepaired.length;
            if (result.stat.argsRepaired.length) {
              // 中文注释：只记工具名与被修的裸词，不记参数正文
              log.write({
                ts: new Date().toISOString(),
                event: 'args_repaired',
                model: parsed.model,
                tools: result.stat.argsRepaired.map(item => item.name),
                tokens: [...new Set(result.stat.argsRepaired.flatMap(item => item.tokens))],
              });
            }
            if (changed || result.stat.opaque || reject) {
              log.write({
                ts: new Date().toISOString(),
                event: 'rewrite',
                model: parsed.model,
                kind: result.official ? 'official' : (result.third ? 'thirdparty' : 'other'),
                stripped: result.stat.stripped,
                projected: result.stat.projected,
                opaque: result.stat.opaque,
                orphanOutputs: result.stat.orphanOutputs,
                argsRepaired: result.stat.argsRepaired.length,
              });
            }
            if (changed) {
              out = Buffer.from(JSON.stringify(parsed), 'utf8');
            }
          }
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
        log.write({ ts: new Date().toISOString(), event: 'upstream_error', message: String(err) });
        try {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'codex-compat: upstream unreachable', detail: String(err) } }));
        } catch (e) {
          // 中文注释：响应头可能已发出，忽略
        }
      });

      proxied.end(out);
    });
  });

  server.compatLog = log;
  server.compatConfig = cfg;
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
    server.compatLog.write({ ts: new Date().toISOString(), event: 'listen_error', message: String(err) });
    console.error('[codex-compat] 监听失败：' + err.message);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    server.compatLog.write({ ts: new Date().toISOString(), event: 'uncaught', message: String(err && err.stack || err) });
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    server.compatLog.write({ ts: new Date().toISOString(), event: 'unhandled_rejection', message: String(err) });
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
