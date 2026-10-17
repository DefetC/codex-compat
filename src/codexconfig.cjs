// Codex config.toml 读写：定位 provider、读取与改写 base_url。
//
// 只做结构化最小改动：保留注释与其他配置，写入前校验 TOML 语义一致。
const toml = require('@iarna/toml');
const { isDeepStrictEqual } = require('node:util');
const files = require('./config-files.cjs');
const config = require('./config.cjs');

// 中文注释：顶层 base_url（无 model_providers 段）的哨兵 key
const TOP_LEVEL = '__top_level__';

// 中文注释：本机 http 地址判定，用于远程上游风险提示
function isLocalUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(url || ''));
}

// 中文注释：兼容层对外暴露的 base_url
function listenUrl(cfg) {
  return 'http://' + cfg.listen.host + ':' + cfg.listen.port + (cfg.upstream.basePath || '/v1');
}

// 中文注释：从上游 base_url 解析 host / port / 路径前缀
function parseUpstreamUrl(url) {
  try {
    const parsed = new URL(String(url));
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    const basePath = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
    return { host: parsed.hostname, port, basePath, protocol: parsed.protocol };
  } catch (err) {
    return null;
  }
}

// 中文注释：列出所有 model_providers 条目
function providers(parsed) {
  const list = parsed && parsed.model_providers;
  if (!list || typeof list !== 'object' || Array.isArray(list)) {
    return [];
  }
  return Object.entries(list).filter(([, value]) => value && typeof value === 'object');
}

// 中文注释：定位当前生效的 provider；优先显式 key，其次我们自己的地址，再次记录的原上游
function detectProvider(text, options = {}) {
  const parsed = toml.parse(text);
  const list = providers(parsed);
  if (options.providerKey) {
    const hit = list.find(([key]) => key === options.providerKey);
    if (hit) {
      return { key: hit[0], baseUrl: typeof hit[1].base_url === 'string' ? hit[1].base_url : null };
    }
  }
  if (options.expectedUrl) {
    const hit = list.find(([, value]) => value.base_url === options.expectedUrl);
    if (hit) {
      return { key: hit[0], baseUrl: hit[1].base_url };
    }
  }
  if (options.originalUrl) {
    const hit = list.find(([, value]) => value.base_url === options.originalUrl);
    if (hit) {
      return { key: hit[0], baseUrl: hit[1].base_url };
    }
  }
  const locals = list.filter(([, value]) => typeof value.base_url === 'string' && isLocalUrl(value.base_url));
  const preferred = locals.find(([, value]) => /:15721(\/|$)/.test(value.base_url)) || locals[0];
  if (preferred) {
    return { key: preferred[0], baseUrl: preferred[1].base_url };
  }
  const any = list.find(([, value]) => typeof value.base_url === 'string');
  if (any) {
    return { key: any[0], baseUrl: any[1].base_url };
  }
  // 中文注释：兼容旧式顶层 base_url 写法
  if (typeof parsed.base_url === 'string') {
    return { key: TOP_LEVEL, baseUrl: parsed.base_url };
  }
  return { key: null, baseUrl: null };
}

// 中文注释：读取指定 provider 的 base_url
function readBaseUrl(text, key) {
  const parsed = toml.parse(text);
  if (key === TOP_LEVEL) {
    return typeof parsed.base_url === 'string' ? parsed.base_url : null;
  }
  const hit = providers(parsed).find(([name]) => name === key);
  return hit && typeof hit[1].base_url === 'string' ? hit[1].base_url : null;
}

// 中文注释：改写指定 provider 的 base_url，返回新的 TOML 文本
function writeBaseUrl(text, key, url) {
  if (!key) {
    throw new Error('未找到可改写的 model_providers 条目');
  }
  if (key === TOP_LEVEL) {
    return writeTopLevel(text, 'base_url', url);
  }
  return files.setSection(text, ['model_providers', key, 'base_url'], { exists: true, value: url });
}

// 中文注释：安全改写顶层标量；写入后用 TOML 语义比对，除目标键外必须完全一致
function writeTopLevel(text, name, value) {
  const before = toml.parse(text);
  const pattern = new RegExp('^[ \\t]*' + name + '[ \\t]*=[^\\r\\n]*\\r?$', 'm');
  if (!pattern.test(text)) {
    throw new Error('未找到顶层 ' + name + ' 赋值');
  }
  const next = text.replace(pattern, name + ' = ' + JSON.stringify(value));
  const expected = Object.assign({}, before);
  expected[name] = value;
  if (!isDeepStrictEqual(toml.parse(next), expected)) {
    throw new Error('顶层 ' + name + ' 无法安全更新');
  }
  return next;
}

// 中文注释：判断当前 base_url 是否已指向兼容层
function pointsAtCompat(text, cfg) {
  const target = listenUrl(cfg);
  return providers(toml.parse(text)).some(([, value]) => value.base_url === target);
}

// 中文注释：导出默认端口，便于测试与提示
const DEFAULT_UPSTREAM_PORT = config.DEFAULTS.upstream.port;

module.exports = { TOP_LEVEL, isLocalUrl, listenUrl, parseUpstreamUrl, providers, detectProvider, readBaseUrl, writeBaseUrl, pointsAtCompat, DEFAULT_UPSTREAM_PORT };
