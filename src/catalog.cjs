// 模型目录托管：把上游 /models 转成 Codex 原生目录，并按映射注入提示词模板。
//
// 只写本实例运行目录下的 catalog.json，由兼容层在 /__compat/catalog 提供给 Codex；
// 绝不新建全局 model_catalog_json（那会替换内置目录、导致官方模型消失）。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const config = require('./config.cjs');
const mappings = require('./mappings.cjs');

// 中文注释：缓存文件名
const CATALOG_FILE = 'catalog.json';

// 中文注释：目录文件路径
function catalogPath(home) {
  return path.join(config.paths(home).home, CATALOG_FILE);
}

// 中文注释：上游 /models 地址
function modelsUrl(upstream) {
  const base = upstream.baseUrl
    ? String(upstream.baseUrl).replace(/\/+$/, '')
    : 'http://' + upstream.host + ':' + upstream.port + (upstream.basePath || '/v1');
  return base + '/models';
}

// 中文注释：GET JSON（只读探测，8 秒超时）
function httpGetJson(url, apiKey, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let request;
    try {
      const target = new URL(url);
      const client = target.protocol === 'https:' ? https : http;
      const headers = { accept: 'application/json' };
      if (apiKey) {
        headers.authorization = 'Bearer ' + apiKey;
      }
      request = client.get({
        host: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        headers,
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({ ok: false, status: res.statusCode, error: 'HTTP ' + res.statusCode });
            return;
          }
          try {
            resolve({ ok: true, data: JSON.parse(text) });
          } catch (err) {
            resolve({ ok: false, error: '响应不是合法 JSON' });
          }
        });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message || err) });
      return;
    }
    request.on('timeout', () => { request.destroy(); resolve({ ok: false, error: '请求超时' }); });
    request.on('error', (err) => resolve({ ok: false, error: String(err && err.message || err) }));
  });
}

// 中文注释：从 /models 响应里提取模型 id 列表
function extractModelIds(data) {
  const list = data && Array.isArray(data.data) ? data.data : (Array.isArray(data && data.models) ? data.models : []);
  const ids = list.map((item) => (typeof item === 'string' ? item : (item && (item.id || item.slug)))).filter((id) => typeof id === 'string' && id.trim());
  return Array.from(new Set(ids));
}

// 中文注释：判断上游 /models 是否已经是 Codex 原生目录（带提示词/模板字段）
function isNativeCatalog(data) {
  const list = data && Array.isArray(data.data) ? data.data : (Array.isArray(data && data.models) ? data.models : []);
  return list.some((item) => item && typeof item === 'object'
    && (item.base_instructions || (item.model_messages && item.model_messages.instructions_template)));
}

// 中文注释：探测上游模型端点能力；native=true 表示上游已自带 Codex 原生目录，无需我们托管
async function probe(upstream, apiKey, timeoutMs) {
  const fetched = await httpGetJson(modelsUrl(upstream), apiKey, timeoutMs || 8000);
  if (!fetched.ok) {
    return { ok: false, native: false, error: fetched.error };
  }
  const ids = extractModelIds(fetched.data);
  return { ok: true, native: isNativeCatalog(fetched.data), ids, count: ids.length };
}

// 中文注释：中性能力字段，避免把任何第三方目录内容带进仓库
function neutralEntry(slug) {
  return {
    slug,
    display_name: slug,
    description: slug,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balanced depth for everyday work' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    context_window: 200000,
    max_context_window: 200000,
    auto_compact_token_limit: null,
    effective_context_window_percent: 95,
    input_modalities: ['text'],
    supports_image_detail_original: false,
    supports_parallel_tool_calls: true,
    supports_search_tool: false,
    supports_reasoning_summaries: true,
    support_verbosity: false,
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'bytes', limit: 10000 },
    multi_agent_version: 'v2',
    shell_type: 'shell_command',
    supported_in_api: true,
    visibility: 'list',
    experimental_supported_tools: [],
    additional_speed_tiers: [],
    service_tiers: [],
  };
}

// 中文注释：读取已生成目录；不存在返回 null
function read(home) {
  try {
    const text = fs.readFileSync(catalogPath(home), 'utf8');
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

// 中文注释：从已有 Codex 原生目录文件导入（保留完整元数据，例如 CC Switch 生成的目录）
function importFromFile(home, sourceFile, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  } catch (err) {
    return { ok: false, code: 'source-unreadable', message: '源目录不可读：' + String(err && err.message || err) };
  }
  if (!Array.isArray(parsed.models) || !parsed.models.length) {
    return { ok: false, code: 'source-empty', message: '源目录没有模型：' + sourceFile };
  }
  const entries = structuredClone(parsed.models);
  const applied = applyOverrides(entries, {
    mappingFile: options.mappingFile,
    officialGuard: options.officialGuard,
  });
  const file = write(home, { models: entries, generatedAt: new Date().toISOString(), source: sourceFile });
  return { ok: true, code: 'catalog-imported', file, total: entries.length, injected: applied.injected, warnings: applied.warnings };
}

// 中文注释：为实例决定并生成目录；mode 说明走了哪条路（native-upstream/fetched/imported/no-models）
async function prepareForInstance(options = {}) {
  const probed = await probe(options.upstream, options.apiKey, options.timeoutMs || 6000);
  if (probed.ok && probed.native) {
    return { ok: false, mode: 'native-upstream', message: '上游已提供 Codex 原生模型目录，无需托管（' + probed.count + ' 个模型）' };
  }
  if (probed.ok && probed.count > 0) {
    const refreshed = await refresh(options);
    return Object.assign({ mode: 'fetched' }, refreshed);
  }
  if (options.nativeCatalogFile && fs.existsSync(options.nativeCatalogFile)) {
    const imported = importFromFile(options.home, options.nativeCatalogFile, {
      mappingFile: options.mappingFile,
      officialGuard: options.officialGuard,
    });
    return Object.assign({ mode: 'imported' }, imported);
  }
  return {
    ok: false,
    mode: 'no-models',
    message: probed.ok ? '上游没有返回任何模型，且没有可导入的本地目录' : ('上游模型端点不可用：' + probed.error),
  };
}

// 中文注释：写目录（原子写）
function write(home, catalog) {
  const file = catalogPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

// 中文注释：根据映射给命中的模型挂上模板（文本内容来自模板文件）
function applyOverrides(entries, options) {
  const injected = [];
  const warnings = [];
  if (!options.mappingFile) {
    return { injected, warnings };
  }
  let bindings;
  try {
    bindings = mappings.readBindings({ mappingFile: options.mappingFile }).bindings;
  } catch (err) {
    warnings.push({ code: 'mapping_unreadable', detail: String(err && err.message || err) });
    return { injected, warnings };
  }
  const root = path.dirname(options.mappingFile);
  const claimed = new Set();
  for (const binding of bindings) {
    if (binding.enabled === false) {
      continue;
    }
    const target = mappings.resolveTarget(binding, entries, claimed);
    if (target.warning) {
      warnings.push(target.warning);
      continue;
    }
    const entry = target.model;
    if (options.officialGuard !== false && mappings.isOfficialSlug(entry.slug)) {
      warnings.push({ code: 'official_model_blocked', modelId: entry.slug });
      continue;
    }
    try {
      const settings = mappings.loadModelTemplate(root, binding.model_template);
      Object.assign(entry, settings);
      claimed.add(entry.slug);
      injected.push({ slug: entry.slug, via: target.via });
    } catch (err) {
      warnings.push({ code: 'template_failed', modelId: entry.slug, detail: String(err && err.message || err) });
    }
  }
  return { injected, warnings };
}

// 中文注释：刷新目录：拉取上游模型列表 → 注入模板 → 落盘
async function refresh(options = {}) {
  const home = options.home || config.compatHome();
  const upstream = options.upstream;
  if (!upstream) {
    return { ok: false, code: 'no-upstream', message: '缺少上游信息，无法生成模型目录' };
  }
  const fetched = await httpGetJson(modelsUrl(upstream), options.apiKey, options.timeoutMs || 8000);
  if (!fetched.ok) {
    const cached = read(home);
    return {
      ok: false,
      code: 'fetch-failed',
      message: '拉取上游模型列表失败：' + fetched.error + (cached ? '（已保留旧目录）' : ''),
      keptCache: !!cached,
    };
  }
  const ids = extractModelIds(fetched.data);
  if (!ids.length) {
    return { ok: false, code: 'empty-models', message: '上游没有返回任何模型' };
  }
  const entries = ids.map(neutralEntry);
  const applied = applyOverrides(entries, {
    mappingFile: options.mappingFile,
    officialGuard: options.officialGuard,
  });
  const catalog = { models: entries, generatedAt: new Date().toISOString(), source: modelsUrl(upstream) };
  const file = write(home, catalog);
  return {
    ok: true,
    code: 'catalog-refreshed',
    file,
    total: entries.length,
    injected: applied.injected,
    warnings: applied.warnings,
  };
}

module.exports = { CATALOG_FILE, catalogPath, modelsUrl, httpGetJson, extractModelIds, isNativeCatalog, probe, neutralEntry, read, write, importFromFile, prepareForInstance, applyOverrides, refresh };
