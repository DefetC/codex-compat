// 配置中心：统一管理持久化配置、运行目录与参数优先级。
//
// 优先级：CLI 参数 > 环境变量 > 配置文件 > 默认值。
// 兼容历史环境变量（COMPAT_*），保证旧命令仍可用。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OUTPUT_REPLAY_POLICIES, REQUEST_COMPRESSION_POLICIES } = require('./compat-policy.cjs');

// 中文注释：可持久化配置的默认值，字段含义见 README
const DEFAULTS = {
  version: 1,
  listen: { host: '127.0.0.1', port: 15731 },
  upstream: { mode: 'cc-switch', host: '127.0.0.1', port: 15721, baseUrl: null, basePath: '/v1' },
  compat: {
    stripAlways: true,
    thirdPartyPrefixes: ['ccs-', 'ccs/'],
    detection: 'auto',
    // 默认仅按已知路由保留输出回放扩展，不删除任何历史密文。
    outputTokenReplay: OUTPUT_REPLAY_POLICIES.AUTO,
    // 外部路由默认使用无压缩正文，降低第三方 JSON 解码不兼容风险。
    requestCompression: REQUEST_COMPRESSION_POLICIES.AUTO,
    // 非官方不透明任务只给经过验证、显式列出的精确模型透传。
    opaqueTaskModels: [],
  },
  features: {
    deepseekPrompt: true,
    deepseekRoles: true,
    // 中文注释：无全局 catalog 时托管 provider 级模型目录。
    // 实测 Codex 0.160.1 不会为 env_key provider 拉取 model_catalog_url，
    // 因此默认关闭；保留开关以便新版 Codex 支持后启用。
    providerCatalog: false,
    // 中文注释：纯官方保护：命中官方模型命名时拒绝写入提示词/目录
    officialGuard: true,
  },
  service: { autoStart: true, guard: true, reclaim: 'auto', templateRefresh: 'auto' },
  runtime: { logLevel: 'info', trace: false, lang: 'auto', verbose: false },
};

// 中文注释：漂移处理策略：auto 自动恢复/刷新、notify-only 只通知、off 不动作。
// 两类漂移共用：base_url 与目录注入（service.reclaim）、模板拷贝（service.templateRefresh）。
const DRIFT_POLICIES = ['auto', 'notify-only', 'off'];

// 中文注释：仓库根目录（src 的上一级）
function rootDir() {
  return path.resolve(__dirname, '..');
}

// 中文注释：运行态根目录，可通过 CODEX_COMPAT_HOME 覆盖
function compatHome() {
  return process.env.CODEX_COMPAT_HOME || path.join(os.homedir(), '.codex-compat');
}

// 中文注释：读取 package.json 中的版本号，供健康检查与 --version 使用
function version() {
  try {
    return require(path.join(rootDir(), 'package.json')).version || '0.0.0';
  } catch (err) {
    return '0.0.0';
  }
}

// 中文注释：运行目录集合；调用方不自行拼接路径，避免多处口径不一致
function paths(home) {
  const base = home || compatHome();
  return {
    home: base,
    configFile: path.join(base, 'config.json'),
    configDir: path.join(base, 'config'),
    mappingFile: path.join(base, 'config', 'mappings.toml'),
    manifestFile: path.join(base, 'install-manifest.json'),
    logs: path.join(base, 'logs'),
    backups: path.join(base, 'backups'),
    run: path.join(base, 'run'),
    state: path.join(base, 'state'),
    lockFile: path.join(base, 'run', 'watchdog.lock'),
    intentionalStopFlag: path.join(base, 'run', 'intentional-stop.flag'),
  };
}

// 中文注释：仅合并普通对象，数组按整体覆盖处理
function merge(base, override) {
  const next = structuredClone(base);
  if (!override || typeof override !== 'object') {
    return next;
  }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const isPlain = value !== null && typeof value === 'object' && !Array.isArray(value);
    next[key] = isPlain && next[key] && typeof next[key] === 'object' && !Array.isArray(next[key])
      ? merge(next[key], value)
      : structuredClone(value);
  }
  return next;
}

// 中文注释：把端口字符串转成正整数，非法值直接报错而不是静默回退
function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(label + ' 端口非法：' + value);
  }
  return port;
}

// 中文注释：结构校验，避免配置文件被写坏后带病运行
function validate(cfg) {
  parsePort(cfg.listen.port, 'listen');
  parsePort(cfg.upstream.port, 'upstream');
  if (!cfg.upstream.baseUrl && !cfg.upstream.host) {
    throw new Error('upstream 必须提供 host 或 baseUrl');
  }
  if (typeof cfg.upstream.basePath !== 'string' || !cfg.upstream.basePath.startsWith('/')) {
    throw new Error('upstream.basePath 必须以 / 开头');
  }
  if (!cfg.compat || typeof cfg.compat !== 'object' || Array.isArray(cfg.compat)) {
    throw new Error('compat 必须是对象');
  }
  if (cfg.compat.stripAlways !== undefined && typeof cfg.compat.stripAlways !== 'boolean') {
    throw new Error('compat.stripAlways 必须是布尔值');
  }
  // 新字段缺省时兼容旧调用方，显式设置时必须命中约定枚举。
  if (cfg.compat.outputTokenReplay !== undefined && !Object.values(OUTPUT_REPLAY_POLICIES).includes(cfg.compat.outputTokenReplay)) {
    throw new Error('compat.outputTokenReplay 只能是 ' + Object.values(OUTPUT_REPLAY_POLICIES).join(' / '));
  }
  if (cfg.compat.requestCompression !== undefined && !Object.values(REQUEST_COMPRESSION_POLICIES).includes(cfg.compat.requestCompression)) {
    throw new Error('compat.requestCompression 只能是 ' + Object.values(REQUEST_COMPRESSION_POLICIES).join(' / '));
  }
  if (cfg.compat.opaqueTaskModels !== undefined && (!Array.isArray(cfg.compat.opaqueTaskModels) || cfg.compat.opaqueTaskModels.some(model => typeof model !== 'string' || !model || model.trim() !== model || /[*?]/.test(model)))) {
    throw new Error('compat.opaqueTaskModels 必须是无通配符的非空模型名称数组');
  }
  if (!Array.isArray(cfg.compat.thirdPartyPrefixes) || cfg.compat.thirdPartyPrefixes.some(x => typeof x !== 'string')) {
    throw new Error('compat.thirdPartyPrefixes 必须是字符串数组');
  }
  if (!DRIFT_POLICIES.includes(cfg.service.reclaim)) {
    throw new Error('service.reclaim 只能是 ' + DRIFT_POLICIES.join(' / '));
  }
  if (!DRIFT_POLICIES.includes(cfg.service.templateRefresh)) {
    throw new Error('service.templateRefresh 只能是 ' + DRIFT_POLICIES.join(' / '));
  }
  if (cfg.compat.detection !== 'auto' && !Array.isArray(cfg.compat.detection)) {
    throw new Error('compat.detection 只能是 auto 或数组');
  }
  if (!['auto', 'zh', 'en'].includes(cfg.runtime.lang)) {
    throw new Error('runtime.lang 只能是 auto / zh / en');
  }
  for (const key of ['deepseekPrompt', 'deepseekRoles', 'providerCatalog', 'officialGuard']) {
    if (typeof cfg.features[key] !== 'boolean') {
      throw new Error('features.' + key + ' 必须是布尔值');
    }
  }
  if (typeof cfg.runtime.verbose !== 'boolean') {
    throw new Error('runtime.verbose 必须是布尔值');
  }
  return cfg;
}

// 中文注释：环境变量映射，兼容历史 COMPAT_* 变量
function fromEnv(cfg) {
  const next = structuredClone(cfg);
  if (process.env.COMPAT_PORT) {
    next.listen.port = parsePort(process.env.COMPAT_PORT, 'listen');
  }
  if (process.env.COMPAT_UPSTREAM_HOST) {
    next.upstream.host = process.env.COMPAT_UPSTREAM_HOST;
  }
  if (process.env.COMPAT_UPSTREAM_PORT) {
    next.upstream.port = parsePort(process.env.COMPAT_UPSTREAM_PORT, 'upstream');
  }
  if (process.env.COMPAT_UPSTREAM_BASE_URL) {
    next.upstream.baseUrl = process.env.COMPAT_UPSTREAM_BASE_URL;
  }
  if (process.env.COMPAT_STRIP_ALWAYS === '0') {
    next.compat.stripAlways = false;
  }
  if (process.env.COMPAT_STRIP_ALWAYS === '1') {
    next.compat.stripAlways = true;
  }
  // 显式环境变量覆盖文件中的兼容策略，非法值由统一校验拒绝。
  if (process.env.COMPAT_OUTPUT_TOKEN_REPLAY !== undefined) {
    next.compat.outputTokenReplay = process.env.COMPAT_OUTPUT_TOKEN_REPLAY;
  }
  if (process.env.COMPAT_REQUEST_COMPRESSION !== undefined) {
    next.compat.requestCompression = process.env.COMPAT_REQUEST_COMPRESSION;
  }
  if (process.env.COMPAT_TRACE === '1') {
    next.runtime.trace = true;
  }
  return next;
}

// 中文注释：CLI 覆盖项映射，未提供的字段保持原值
function fromOptions(cfg, input = {}) {
  const next = structuredClone(cfg);
  if (input.port !== undefined) {
    next.listen.port = parsePort(input.port, 'listen');
  }
  if (input.upstreamPort !== undefined) {
    next.upstream.port = parsePort(input.upstreamPort, 'upstream');
  }
  if (input.upstreamHost !== undefined) {
    next.upstream.host = String(input.upstreamHost);
  }
  if (input.upstreamBaseUrl !== undefined) {
    next.upstream.baseUrl = String(input.upstreamBaseUrl);
  }
  if (input.upstreamBasePath !== undefined) {
    next.upstream.basePath = String(input.upstreamBasePath);
  }
  // 调用参数优先于环境变量；名单仍须通过精确模型校验。
  if (input.outputTokenReplay !== undefined) {
    next.compat.outputTokenReplay = input.outputTokenReplay;
  }
  if (input.requestCompression !== undefined) {
    next.compat.requestCompression = input.requestCompression;
  }
  if (input.opaqueTaskModels !== undefined) {
    next.compat.opaqueTaskModels = structuredClone(input.opaqueTaskModels);
  }
  if (input.reclaim !== undefined) {
    next.service.reclaim = String(input.reclaim);
  }
  if (input.deepseekPrompt !== undefined) {
    next.features.deepseekPrompt = !!input.deepseekPrompt;
  }
  if (input.deepseekRoles !== undefined) {
    next.features.deepseekRoles = !!input.deepseekRoles;
  }
  if (input.autoStart !== undefined) {
    next.service.autoStart = !!input.autoStart;
  }
  return next;
}

// 中文注释：读取配置文件；文件不存在返回空对象，文件损坏直接报错
function readFileConfig(file) {
  if (!fs.existsSync(file)) {
    return {};
  }
  const text = fs.readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('配置根节点必须是对象');
    }
    return parsed;
  } catch (err) {
    throw new Error('配置文件解析失败：' + file + '（' + err.message + '）');
  }
}

// 中文注释：加载最终生效配置
function load(input = {}) {
  const home = input.home || compatHome();
  const cfg = fromOptions(fromEnv(merge(DEFAULTS, readFileConfig(path.join(home, 'config.json')))), input);
  validate(cfg);
  cfg.home = home;
  return cfg;
}

// 中文注释：关键路径（代理/守护）使用的容错加载；配置损坏时退回默认值并返回错误说明
function loadSafe(input = {}) {
  try {
    return { cfg: load(input), error: null };
  } catch (err) {
    const fallback = fromOptions(fromEnv(merge(DEFAULTS, {})), input);
    fallback.home = input.home || compatHome();
    return { cfg: fallback, error: err.message };
  }
}

// 中文注释：持久化配置（不写入 home 等运行时字段）
function save(cfg, home) {
  const target = home || cfg.home || compatHome();
  validate(cfg);
  const payload = structuredClone(cfg);
  delete payload.home;
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, 'config.json');
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

// 中文注释：确保运行目录存在
function ensureDirs(home) {
  const p = paths(home);
  for (const dir of [p.home, p.logs, p.backups, p.run, p.state]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

// 中文注释：上游基础地址；优先使用显式 baseUrl
function upstreamBaseUrl(cfg) {
  if (cfg.upstream.baseUrl) {
    return cfg.upstream.baseUrl.replace(/\/+$/, '');
  }
  return 'http://' + cfg.upstream.host + ':' + cfg.upstream.port + cfg.upstream.basePath;
}

// 中文注释：写入/清除「有意停止」标记；install/start 必须先清除，否则看门狗会直接退出
function setIntentionalStop(home, enabled) {
  const flag = paths(home).intentionalStopFlag;
  try {
    if (enabled) {
      fs.mkdirSync(path.dirname(flag), { recursive: true });
      fs.writeFileSync(flag, new Date().toISOString(), 'utf8');
    } else if (fs.existsSync(flag)) {
      fs.unlinkSync(flag);
    }
  } catch (err) {
    // 中文注释：标记写入失败不阻断主流程
  }
  return flag;
}

// 中文注释：是否处于有意停止状态
function isIntentionalStopped(home) {
  try {
    return fs.existsSync(paths(home).intentionalStopFlag);
  } catch (err) {
    return false;
  }
}

module.exports = {
  DEFAULTS,
  DRIFT_POLICIES,
  rootDir,
  compatHome,
  version,
  paths,
  load,
  loadSafe,
  save,
  validate,
  ensureDirs,
  merge,
  parsePort,
  upstreamBaseUrl,
  setIntentionalStop,
  isIntentionalStopped,
};
