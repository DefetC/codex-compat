// 实例（多开 / lab）管理：目录扫描注册表、密钥隔离、Codex 配置生成与生命周期编排。
//
// 设计要点：
//   1. 每个实例是 <compat home>/instances/<name>/ 下的自包含目录，注册表用目录扫描实现，不依赖中心文件；
//   2. 实例自带 codex/（作为 CODEX_HOME）与 compat/（作为兼容层运行目录），彼此完全隔离；
//   3. 任何输出只打印密钥掩码，明文仅落在实例的 secrets.env 与 run 子进程的环境变量里。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const toml = require('@iarna/toml');
const config = require('./config.cjs');
const platform = require('./platform.cjs');
const ports = require('./ports.cjs');
const processes = require('./processes.cjs');
const codexconfig = require('./codexconfig.cjs');
const files = require('./config-files.cjs');

// 中文注释：实例监听端口的扫描区间（含两端）
const PORT_FROM = 15900;
const PORT_TO = 16000;

// 中文注释：实例类型标识，当前只支持 lab（多开实验实例）
const INSTANCE_KIND = 'lab';

// 中文注释：默认的密钥环境变量名，未指定 --key-env 时使用
const DEFAULT_KEY_ENV = 'CODEX_COMPAT_LAB_KEY';

// 中文注释：模型目录托管模式取值——auto 自动挑选、instructions 走提示词文件、catalog 走 provider 级目录、none 都不写
const CATALOG_MODE_AUTO = 'auto';
const CATALOG_MODE_INSTRUCTIONS = 'instructions';
const CATALOG_MODE_CATALOG = 'catalog';
const CATALOG_MODE_NONE = 'none';

// 中文注释：允许的模型目录托管模式
const CATALOG_MODES = [CATALOG_MODE_AUTO, CATALOG_MODE_INSTRUCTIONS, CATALOG_MODE_CATALOG, CATALOG_MODE_NONE];

// 中文注释：默认走 model_instructions_file：不依赖 Codex 是否支持 provider 级目录
const DEFAULT_CATALOG_MODE = CATALOG_MODE_INSTRUCTIONS;

// 中文注释：密钥文件名（放在实例目录下，与 codex/compat 目录同级）
const SECRETS_FILE = 'secrets.env';

// 中文注释：实例元数据文件名
const META_FILE = 'instance.json';

// 中文注释：cc-switch 默认上游（本机 15721 的 /v1）
const CCSWITCH_UPSTREAM = {
  mode: 'cc-switch',
  host: '127.0.0.1',
  port: 15721,
  basePath: '/v1',
};

// 中文注释：实例监听地址固定为回环地址
const LOCAL_HOST = '127.0.0.1';

// 中文注释：未指定模型时探测上游 /models 的超时时间
const MODEL_PROBE_TIMEOUT_MS = 8000;

// 中文注释：创建实例时做凭据预检的超时时间；短于模型探测，避免拖慢创建
const AUTH_PROBE_TIMEOUT_MS = 4000;

// 中文注释：上游明确拒绝密钥的 HTTP 状态码（预检据此给出告警）
const AUTH_REJECT_CODES = [401, 403];

// 中文注释：start 子命令等待健康检查的最长时间与轮询间隔
const START_WAIT_MS = 15000;
const START_POLL_MS = 500;

// 中文注释：受支持的子命令，用于从位置参数中识别动作（refresh 是 refresh-catalog 的菜单简写）
const SUBCOMMANDS = ['create', 'list', 'status', 'start', 'stop', 'env', 'run', 'refresh-catalog', 'refresh', 'update', 'remove'];

// 中文注释：实例根目录（目录扫描注册表的根）
function instancesRoot(home) {
  return path.join(home || config.compatHome(), 'instances');
}

// 中文注释：单个实例的目录
function instanceDir(name, home) {
  return path.join(instancesRoot(home), name);
}

// 中文注释：实例内全部关键路径，收口在一处避免调用方各自拼接
function instancePaths(name, home) {
  const dir = instanceDir(name, home);
  return {
    dir,
    metaFile: path.join(dir, META_FILE),
    secretsFile: path.join(dir, SECRETS_FILE),
    codexHome: path.join(dir, 'codex'),
    compatHome: path.join(dir, 'compat'),
    promptFile: path.join(dir, 'prompts', 'deepseek-codex.md'),
  };
}

// 中文注释：密钥掩码；长度不足 10 位时无法安全保留首尾，只显示 ****
function maskSecret(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (text.length < 10) {
    return '****';
  }
  return text.slice(0, 4) + '****' + text.slice(-4);
}

// 中文注释：解析 secrets.env（KEY=VALUE，每行一条），文件不存在返回空对象
function readSecrets(file) {
  const out = {};
  if (!fs.existsSync(file)) {
    return out;
  }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) {
      continue;
    }
    const eq = text.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    out[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
  }
  return out;
}

// 中文注释：写入 secrets.env；POSIX 下收紧为 0600，Windows 上 chmod 失败按预期忽略
function writeSecrets(file, keyEnv, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, keyEnv + '=' + value + '\n', { encoding: 'utf8' });
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    // 中文注释：Windows 文件系统不支持 POSIX 权限位，忽略即可
  }
  return file;
}

// 中文注释：取实例明文密钥；未落盘或文件缺失时返回 null
function resolveSecret(instance, home) {
  if (!instance || !instance.keyStored) {
    return null;
  }
  const value = readSecrets(instancePaths(instance.name, home).secretsFile)[instance.keyEnv];
  return value === undefined || value === '' ? null : value;
}

// 中文注释：密钥展示文案：永远只出现掩码，不出现明文
function keyLabel(instance, home) {
  if (!instance || !instance.keyStored) {
    return keyEnvOf(instance) + '（未落盘）';
  }
  const value = resolveSecret(instance, home);
  return value === null ? keyEnvOf(instance) + '（文件缺失）' : keyEnvOf(instance) + '=' + maskSecret(value);
}

// 中文注释：实例的密钥环境变量名；元数据被手工改坏时退回默认名，避免注入 undefined
function keyEnvOf(instance) {
  const name = instance && instance.keyEnv ? String(instance.keyEnv) : '';
  return name || DEFAULT_KEY_ENV;
}

// 中文注释：上游展示文案
function upstreamLabel(upstream) {
  if (!upstream) {
    return '-';
  }
  return upstreamBaseUrl(upstream) + '（' + upstream.mode + '）';
}

// 中文注释：上游基础地址，结尾不带斜杠
function upstreamBaseUrl(upstream) {
  if (upstream && upstream.baseUrl) {
    return String(upstream.baseUrl).replace(/\/+$/, '');
  }
  return 'http://' + upstream.host + ':' + upstream.port + (upstream.basePath || '/v1');
}

// 中文注释：读取单个实例元数据；文件损坏时明确报错，避免带病运行
function readInstanceAt(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error('实例元数据解析失败：' + file + '（' + err.message + '）');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('实例元数据必须是对象：' + file);
  }
  return parsed;
}

// 中文注释：扫描实例根目录得到全部实例（目录扫描即注册表），按名称排序
function listInstances(home) {
  const root = instancesRoot(home);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => instancePaths(item.name, home))
    .filter((paths) => fs.existsSync(paths.metaFile))
    .map((paths) => readInstanceAt(paths.metaFile))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// 中文注释：已被其他实例登记的端口集合，选端口时必须跳过
function usedPorts(home) {
  const set = new Set();
  for (const instance of listInstances(home)) {
    const port = Number(instance.listenPort);
    if (Number.isInteger(port)) {
      set.add(port);
    }
  }
  return set;
}

// 中文注释：在 15900-16000 区间内挑一个既空闲又未被其他实例登记的端口
async function pickInstancePort(home) {
  const used = usedPorts(home);
  for (let port = PORT_FROM; port <= PORT_TO; port++) {
    if (used.has(port)) {
      continue;
    }
    if (await ports.canBind(LOCAL_HOST, port)) {
      return { ok: true, port };
    }
  }
  return {
    ok: false,
    port: null,
    error: '在 ' + PORT_FROM + '–' + PORT_TO + ' 区间内没有可用端口（可能已被其他程序占用或已被其他实例登记）',
  };
}

// 中文注释：实例名称校验，顺带阻断路径穿越
function normalizeName(raw) {
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!text) {
    return { ok: false, error: '请提供实例名称，例如：codex-compat instance create lab1 --model deepseek-chat' };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text)) {
    return { ok: false, error: '实例名称非法（仅允许字母/数字/. _ -，且以字母或数字开头，最长 64 字符）：' + text };
  }
  return { ok: true, value: text };
}

// 中文注释：解析 --provider：cc-switch / http(s)://… / host:port
function parseProvider(value) {
  const text = value === undefined || value === null || value === true ? 'cc-switch' : String(value).trim();
  if (!text || text === 'cc-switch') {
    const upstream = Object.assign({}, CCSWITCH_UPSTREAM);
    upstream.baseUrl = upstreamBaseUrl(upstream);
    return { ok: true, upstream, warnings: [] };
  }
  if (/^https?:\/\//i.test(text)) {
    const parsed = codexconfig.parseUpstreamUrl(text);
    if (!parsed) {
      return { ok: false, error: '上游地址无法解析：' + text };
    }
    const upstream = { mode: 'url', host: parsed.host, port: parsed.port, basePath: parsed.basePath };
    upstream.baseUrl = text.replace(/\/+$/, '');
    const warnings = parsed.protocol === 'https:'
      // 中文注释：兼容层代理目前只按明文 http 转发，https 上游需要在运行前确认可行性
      ? ['上游协议是 https，但兼容层代理（src/compat-proxy.cjs）当前只按 http 转发，请确认该上游在本实例内可用']
      : [];
    return { ok: true, upstream, warnings };
  }
  const match = /^([^:\s/]+):(\d{1,5})$/.exec(text);
  if (match) {
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: '上游端口非法：' + match[2] };
    }
    const upstream = { mode: 'custom', host: match[1], port, basePath: '/v1' };
    upstream.baseUrl = upstreamBaseUrl(upstream);
    return { ok: true, upstream, warnings: [] };
  }
  return {
    ok: false,
    error: '无法识别的上游：' + text + '（支持 cc-switch / http(s)://… / host:port）',
  };
}

// 中文注释：把字符串安全地写成 TOML 基本字符串（JSON 转义规则与 TOML 基本字符串兼容）
function tomlString(text) {
  return JSON.stringify(String(text));
}

// 中文注释：生成实例专用 config.toml；显式逐行拼接，便于保留注释与顺序
function renderCodexConfig(instance, promptFile) {
  const listenBase = 'http://' + LOCAL_HOST + ':' + instance.listenPort + (instance.upstream.basePath || '/v1');
  const lines = [
    '# codex-compat 实例（lab）专用配置，由 codex-compat instance create 生成，请勿手工改动',
    '',
    'model = ' + tomlString(instance.model),
    'model_provider = "lab"',
  ];
  // 中文注释：instructions 模式的 model_instructions_file 必须是顶层键；
  // 写进 [model_providers.lab] 表内会被 Codex 判为无法识别的配置并直接忽略（0.160.1 实测）。
  if (instance.catalogMode === CATALOG_MODE_INSTRUCTIONS) {
    lines.push('model_instructions_file = ' + tomlString(promptFile));
  }
  lines.push(
    '',
    '[model_providers.lab]',
    'name = "codex-compat lab"',
    'base_url = ' + tomlString(listenBase),
    'env_key = ' + tomlString(instance.keyEnv),
    'wire_api = "responses"',
  );
  if (instance.catalogMode === CATALOG_MODE_CATALOG) {
    // 中文注释：catalog 模式：由兼容层托管 provider 级模型目录
    lines.push('model_catalog_url = ' + tomlString('http://' + LOCAL_HOST + ':' + instance.listenPort + '/__compat/catalog'));
  }
  lines.push(
    '',
    '[features.multi_agent_v2]',
    'enabled = true',
    'tool_namespace = "agents"',
  );
  // 中文注释：Windows 上 lab 实例必须显式声明原生沙箱模式，否则命令执行会被策略拦下
  if (platform.IS_WINDOWS) {
    lines.push('', '[windows]', 'sandbox = ' + tomlString(windowsSandboxMode()));
  }
  lines.push('');
  return lines.join('\n');
}

// 中文注释：把仓库内的 DeepSeek 提示词复制到实例目录，供 model_instructions_file 引用
function copyPrompt(targetFile) {
  const source = path.join(config.rootDir(), 'config', 'prompts', 'deepseek-codex.md');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.copyFileSync(source, targetFile);
  return targetFile;
}

// 中文注释：Windows 原生沙箱模式。lab 实例必须显式声明，否则 shell 命令会被策略拦下；
// 优先沿用宿主配置里的值（与用户当前能正常工作的设置保持一致），
// 宿主没写时按官方文档回退到不需要管理员权限的 unelevated。
function windowsSandboxMode() {
  try {
    const hostConfig = toml.parse(fs.readFileSync(path.join(platform.codexHome(), 'config.toml'), 'utf8'));
    const value = hostConfig && hostConfig.windows && hostConfig.windows.sandbox;
    if (value === 'elevated' || value === 'unelevated') {
      return value;
    }
  } catch (err) {
    // 中文注释：宿主配置不可读时走回退值
  }
  return 'unelevated';
}

// 中文注释：由兼容层运行目录反查实例自己的 CODEX_HOME；非实例目录返回 null。
// 用途：lab 的 watchdog 必须把映射同步写进实例自己的 codex/，绝不能落到宿主的 ~/.codex。
function instanceCodexHome(home) {
  const dir = String(home || '');
  if (path.basename(dir) !== 'compat') {
    return null;
  }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), META_FILE), 'utf8'));
    if (meta && typeof meta.codexHome === 'string' && meta.codexHome) {
      return meta.codexHome;
    }
  } catch (err) {
    return null;
  }
  return null;
}

// 中文注释：探测上游 /models 列表；网络异常一律降级为 ok:false + 错误说明
function fetchModelCandidates(upstream, apiKey, timeoutMs = MODEL_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(upstreamBaseUrl(upstream) + '/models');
    } catch (err) {
      resolve({ ok: false, ids: [], error: '上游地址非法：' + err.message });
      return;
    }
    const client = target.protocol === 'https:' ? https : http;
    const headers = { accept: 'application/json' };
    if (apiKey) {
      headers.authorization = 'Bearer ' + apiKey;
    }
    const req = client.get(target, { headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const list = Array.isArray(parsed && parsed.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
          const ids = list
            .map((item) => (item && (item.id || item.name) ? String(item.id || item.name) : null))
            .filter(Boolean);
          resolve({ ok: true, ids, status: res.statusCode });
        } catch (err) {
          resolve({ ok: false, ids: [], status: res.statusCode, error: '上游 /models 返回内容无法解析：' + err.message });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, ids: [], error: '上游 /models 请求超时（' + timeoutMs + 'ms）' });
    });
    req.on('error', (err) => {
      resolve({ ok: false, ids: [], error: '上游 /models 请求失败：' + err.message });
    });
  });
}

// 中文注释：按名称定位实例；找不到时返回可直接回传的结果
function findInstance(name, home) {
  const clean = normalizeName(name);
  if (!clean.ok) {
    return { ok: false, lines: [clean.error] };
  }
  const paths = instancePaths(clean.value, home);
  if (!fs.existsSync(paths.metaFile)) {
    return {
      ok: false,
      lines: [
        '未找到实例：' + clean.value,
        '  期望的元数据文件：' + paths.metaFile,
        '  可用 codex-compat instance list 查看全部实例。',
      ],
    };
  }
  return { ok: true, paths, instance: readInstanceAt(paths.metaFile) };
}

// 中文注释：解析位置参数，识别子命令与实例名称；兼容带或不带顶层 instance 关键字
function parseInvocation(opts = {}) {
  const words = Array.isArray(opts._) ? opts._.map((item) => String(item)) : [];
  let sub = null;
  if (words.length && SUBCOMMANDS.includes(words[0])) {
    sub = words.shift();
  } else if (words.length > 1 && SUBCOMMANDS.includes(words[1])) {
    sub = words[1];
    words.splice(0, 2);
  }
  const name = words.length ? words[0] : (opts.name ? String(opts.name) : null);
  return { sub: sub || 'list', name };
}

// 中文注释：切分 argv，取出 "--" 之后的原始参数（原样透传给 codex）
function splitPassthrough(argv) {
  const list = Array.isArray(argv) ? argv.map((item) => String(item)) : [];
  const index = list.indexOf('--');
  if (index < 0) {
    return { head: list, tail: [] };
  }
  return { head: list.slice(0, index), tail: list.slice(index + 1) };
}

// 中文注释：cmd.exe 命令行下的参数引用。
//   内部引号写成 ""（cmd 与 MSVCRT 都按「字面量引号」解析），尾随反斜杠成对化，
//   这样含空格 / 引号 / < > & | ^ 的参数才能原样透传，不会被 cmd 当成重定向或管道。
//   已知局限：参数里出现「反斜杠紧邻引号」时无法在两套解析规则下同时正确；cmd 会在引号内展开 %VAR%。
function quoteForCmd(arg) {
  const text = String(arg);
  if (!/[\s"^&|<>%()]/.test(text)) {
    return text;
  }
  return '"' + text.replace(/"/g, '""').replace(/(\\+)$/, '$1$1') + '"';
}

// 中文注释：创建实例：选端口、建目录、生成密钥/兼容层配置/Codex 配置与元数据
async function createInstance(opts = {}, home) {
  const runtime = home || config.compatHome();
  const invocation = parseInvocation(opts);
  const name = normalizeName(invocation.name);
  if (!name.ok) {
    return { ok: false, code: 'invalid-name', message: name.error, lines: [name.error] };
  }

  const provider = parseProvider(opts.provider);
  if (!provider.ok) {
    return { ok: false, code: 'invalid-provider', message: provider.error, lines: [provider.error] };
  }
  const upstream = provider.upstream;
  const warnings = Array.isArray(provider.warnings) ? provider.warnings.slice() : [];

  let catalogMode = opts.catalogMode && opts.catalogMode !== true ? String(opts.catalogMode) : DEFAULT_CATALOG_MODE;
  if (!CATALOG_MODES.includes(catalogMode)) {
    const message = '--catalog-mode 只能是 ' + CATALOG_MODES.join(' / ') + '，实际：' + catalogMode;
    return { ok: false, code: 'invalid-catalog-mode', message, lines: [message] };
  }
  // 中文注释：auto 表示「自动挑一个当前真正生效的方式」。实测 Codex 0.160.1 不会拉取 provider 级
  // 模型目录，因此 auto 目前等价于 instructions，并明确告知；否则会出现两条注入路径都不写、
  // 提示词静默失效的情况。
  if (catalogMode === CATALOG_MODE_AUTO) {
    catalogMode = CATALOG_MODE_INSTRUCTIONS;
    warnings.push('--catalog-mode auto 已按 instructions 处理：实测 Codex 不支持拉取 provider 级模型目录，'
      + '只有顶层 model_instructions_file 能真正送达提示词');
  }

  if (opts.key === true) {
    return { ok: false, code: 'invalid-key', message: '--key 需要一个值', lines: ['--key 需要一个值（--key-env 只需要环境变量名，不会落盘）'] };
  }
  if (opts.keyEnv === true) {
    return { ok: false, code: 'invalid-key-env', message: '--key-env 需要一个值', lines: ['--key-env 需要环境变量名，例如 --key-env CODEX_COMPAT_LAB_KEY'] };
  }
  const keyEnv = opts.keyEnv ? String(opts.keyEnv) : DEFAULT_KEY_ENV;
  const rawKey = opts.key === undefined || opts.key === null ? null : String(opts.key);
  const keyStored = rawKey !== null;

  let models = [];
  if (opts.models !== undefined && opts.models !== true) {
    models = String(opts.models).split(',').map((item) => item.trim()).filter(Boolean);
  } else if (opts.model !== undefined && opts.model !== true) {
    models = [String(opts.model).trim()].filter(Boolean);
  }

  if (!models.length) {
    // 中文注释：未指定模型时探测上游候选，只做提示，不落盘任何文件
    const probe = await fetchModelCandidates(upstream, rawKey);
    const lines = [
      '未指定模型：请用 --model <slug>（或 --models a,b）指定，第一个模型作为默认模型。',
      '  上游：' + upstreamBaseUrl(upstream),
    ];
    let candidates = [];
    if (probe.ok) {
      candidates = probe.ids.slice(0, 20);
      lines.push('  上游候选模型（展示前 ' + candidates.length + ' 个，共 ' + probe.ids.length + ' 个）：');
      if (!candidates.length) {
        lines.push('    （上游未返回任何模型 id）');
      }
      for (const id of candidates) {
        lines.push('    - ' + id);
      }
      warnings.push('未指定 --model；上游返回 ' + probe.ids.length + ' 个候选模型 id（已展示前 ' + candidates.length + ' 个）');
    } else {
      lines.push('  上游 /models 探测失败：' + probe.error);
      warnings.push('上游 /models 探测失败：' + probe.error);
    }
    lines.push('');
    lines.push('示例：codex-compat instance create ' + name.value + ' --provider ' + (opts.provider && opts.provider !== true ? String(opts.provider) : 'cc-switch') + ' --model <slug>');
    const message = '未指定模型：请用 --model <slug> 指定';
    return { ok: false, code: 'model-required', message, lines, warnings, candidates };
  }

  // 中文注释：凭据预检——密钥抄错/过期时上游会明确返回 401/403，这里提前告警；
  // 只提示不阻断：网关可能未实现 /models，或此刻临时不可用，实例仍按用户意图创建。
  const precheckKey = rawKey || (keyEnv && process.env[keyEnv]) || null;
  if (precheckKey) {
    const authProbe = await fetchModelCandidates(upstream, precheckKey, AUTH_PROBE_TIMEOUT_MS);
    if (AUTH_REJECT_CODES.includes(authProbe.status)) {
      // 中文注释：调用常量判定，避免把「上游拒绝」与「探测失败」混为一谈
      warnings.push('上游拒绝该密钥（HTTP ' + authProbe.status + '）：请检查密钥是否复制完整、是否已过期或轮换；'
        + '实例仍会创建，可用 instance run ' + name.value + ' 复测');
    }
  }

  const picked = await pickInstancePort(runtime);
  if (!picked.ok) {
    return { ok: false, code: 'no-free-port', message: picked.error, lines: [picked.error] };
  }
  const listenPort = picked.port;
  const paths = instancePaths(name.value, runtime);

  const instance = {
    name: name.value,
    createdAt: new Date().toISOString(),
    kind: INSTANCE_KIND,
    codexHome: paths.codexHome,
    compatHome: paths.compatHome,
    listenPort,
    upstream: {
      mode: upstream.mode,
      host: upstream.host,
      port: upstream.port,
      basePath: upstream.basePath,
      baseUrl: upstreamBaseUrl(upstream),
    },
    model: models[0],
    models,
    catalogMode,
    keyEnv,
    keyStored,
    autostart: opts.autostart === true || opts.autostart === 'true',
  };

  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(paths.codexHome, { recursive: true });

  // 中文注释：实例兼容层 home：沿用默认 features，只覆盖监听端口与上游
  const loaded = config.loadSafe({
    home: paths.compatHome,
    port: listenPort,
    upstreamHost: upstream.host,
    upstreamPort: upstream.port,
    upstreamBasePath: upstream.basePath,
  });
  if (loaded.error) {
    warnings.push('兼容层配置加载降级：' + loaded.error);
  }
  config.save(loaded.cfg, paths.compatHome);
  // 中文注释：一次性建好 logs/run/state，避免首次启动时目录缺失
  config.ensureDirs(paths.compatHome);

  if (keyStored) {
    writeSecrets(paths.secretsFile, keyEnv, rawKey);
  }

  let promptFile = null;
  if (catalogMode === CATALOG_MODE_INSTRUCTIONS) {
    promptFile = copyPrompt(paths.promptFile);
  }

  // 中文注释：auto/catalog 模式先探测上游：已是原生目录或没有模型列表时，尽量导入本地原生目录
  let catalogDecision = null;
  if (catalogMode === CATALOG_MODE_CATALOG) {
    // 中文注释：旧版 Codex 不支持 provider 级目录；显式要求 catalog 时降级为 none 并告警，
    // 让用户改用默认的 instructions（比静默写一个不生效的键更安全）
    const versionGate = require('./codex-version.cjs').supportsProviderCatalog();
    if (!versionGate.ok) {
      instance.catalogMode = CATALOG_MODE_NONE;
      warnings.push('Codex ' + versionGate.raw + ' 不支持 provider 级模型目录，已跳过'
        + '（如需送达提示词，请用默认的 --catalog-mode instructions）');
    } else {
      try {
        const catalogModule = require('./catalog.cjs');
        catalogDecision = await catalogModule.prepareForInstance({
          home: paths.compatHome,
          upstream,
          apiKey: rawKey || (keyEnv && process.env[keyEnv]) || null,
          mappingFile: path.join(config.rootDir(), 'config', 'mappings.toml'),
          nativeCatalogFile: path.join(platform.codexHome(), 'cc-switch-model-catalog.json'),
        });
      } catch (err) {
        catalogDecision = { ok: false, mode: 'error', message: String(err && err.message || err) };
      }
      if (catalogDecision && catalogDecision.ok) {
        instance.catalogMode = CATALOG_MODE_CATALOG;
      } else {
        instance.catalogMode = CATALOG_MODE_NONE;
        warnings.push('模型目录未托管（' + (catalogDecision && catalogDecision.message ? catalogDecision.message : '未知原因') + '）');
      }
    }
  }
  fs.writeFileSync(path.join(paths.codexHome, 'config.toml'), renderCodexConfig(instance, promptFile), { encoding: 'utf8' });

  // 中文注释：元数据最后写，避免半成品目录被当成已注册实例
  fs.writeFileSync(paths.metaFile, JSON.stringify(instance, null, 2) + '\n', { encoding: 'utf8' });

  // 中文注释：默认绝不注册自启；只有显式 --autostart 才调用平台注册
  let service = null;
  let guard = null;
  if (instance.autostart) {
    try {
      service = platform.installService({ cfg: loaded.cfg });
    } catch (err) {
      service = { ok: false, detail: String(err && err.message || err) };
      warnings.push('常驻服务注册失败：' + service.detail);
    }
    try {
      guard = platform.registerGuard({ cfg: loaded.cfg });
    } catch (err) {
      guard = { ok: false, detail: String(err && err.message || err) };
      warnings.push('守护任务注册失败：' + guard.detail);
    }
  }

  const lines = [
    '实例 ' + instance.name + ' 已创建',
    '  类型         : ' + instance.kind,
    '  实例目录     : ' + paths.dir,
    '  CODEX_HOME   : ' + paths.codexHome,
    '  兼容层目录   : ' + paths.compatHome,
    '  监听端口     : ' + listenPort,
    '  上游         : ' + upstreamLabel(instance.upstream),
    '  模型         : ' + instance.model + (models.length > 1 ? '（候选：' + models.join(', ') + '）' : ''),
    '  模型目录模式 : ' + catalogMode,
    '  密钥         : ' + keyLabel(instance, runtime) + (keyStored ? '（明文仅写入 secrets.env）' : ''),
    '  自启注册     : ' + (instance.autostart
      ? '已请求：服务=' + (service ? service.detail : '未执行') + '，守护=' + (guard ? guard.detail : '未执行')
      : '未注册（默认；如需自启请加 --autostart）'),
    '',
    '下一步：codex-compat instance env ' + instance.name + ' 查看环境变量与启动方式',
  ];
  if (warnings.length) {
    lines.push('');
    lines.push('提示：');
    for (const item of warnings) {
      lines.push('  - ' + item);
    }
  }
  return { ok: true, code: 'instance-created', instance, lines, warnings };
}

// 中文注释：终端显示宽度；CJK/全角字符按 2 列计算，保证表格对齐全角中英文混排
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    width += (code >= 0x1100 && (code <= 0x115f
      || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1f9ff))) ? 2 : 1;
  }
  return width;
}

// 中文注释：按显示宽度右侧补空格
function padToWidth(text, width) {
  return String(text) + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

// 中文注释：表格化输出，列宽按显示宽度自适应
function renderTable(headers, rows) {
  const table = [headers].concat(rows);
  const widths = headers.map((_, index) => Math.max(...table.map((row) => displayWidth(row[index] === undefined ? '' : row[index]))));
  return table.map((row) => '  ' + row.map((cell, index) => padToWidth(cell === undefined ? '' : cell, widths[index])).join('  ').trimEnd());
}

// 中文注释：列出全部实例
async function listCommand(opts = {}, home) {
  const runtime = home || config.compatHome();
  const items = listInstances(runtime);
  const root = instancesRoot(runtime);
  if (!items.length) {
    return {
      ok: true,
      code: 'instance-list-empty',
      instances: [],
      lines: [
        '当前没有任何实例。',
        '  实例根目录：' + root,
        '  创建实例  ：codex-compat instance create <名称> --model <模型>',
      ],
    };
  }
  const rows = [];
  for (const instance of items) {
    const probe = await ports.probeCompat(LOCAL_HOST, Number(instance.listenPort), 800);
    rows.push([
      instance.name,
      String(instance.listenPort),
      upstreamLabel(instance.upstream),
      String(instance.model || '-'),
      probe.ours ? '运行中' : '未运行',
      keyLabel(instance, runtime),
      instance.autostart ? '是' : '否',
    ]);
  }
  const lines = ['实例列表（' + root + '）', '']
    .concat(renderTable(['名称', '端口', '上游', '模型', '运行状态', '密钥', '自启'], rows));
  return { ok: true, code: 'instance-list', instances: items, lines };
}

// 中文注释：查看单个实例状态：元数据 + 健康检查 + 进程数
async function statusCommand(opts = {}, home) {
  const runtime = home || config.compatHome();
  const found = findInstance(parseInvocation(opts).name, runtime);
  if (!found.ok) {
    return { ok: false, code: 'instance-not-found', message: found.lines[0], lines: found.lines };
  }
  const instance = found.instance;
  const probe = await ports.probeCompat(LOCAL_HOST, Number(instance.listenPort));
  const running = processes.listProcesses(config.rootDir(), instance.compatHome);
  const lines = [
    '实例 ' + instance.name + ' 状态',
    '  类型         : ' + instance.kind,
    '  创建时间     : ' + instance.createdAt,
    '  监听地址     : http://' + LOCAL_HOST + ':' + instance.listenPort,
    '  健康检查     : ' + (probe.ours ? '正常（v' + ((probe.data && probe.data.version) || '?') + '）' : '未响应'),
    '  兼容层进程数 : ' + running.length,
    '  上游         : ' + upstreamLabel(instance.upstream),
    '  模型         : ' + instance.model + '（候选 ' + (instance.models || []).join(', ') + '）',
    '  模型目录模式 : ' + instance.catalogMode,
    '  密钥         : ' + keyLabel(instance, runtime),
    '  自启注册     : ' + (instance.autostart ? '是' : '否'),
    '  实例目录     : ' + found.paths.dir,
    '  CODEX_HOME   : ' + instance.codexHome,
    '  兼容层目录   : ' + instance.compatHome,
  ];
  return { ok: true, code: 'instance-status', instance, health: probe.data || null, processCount: running.length, lines };
}

// 中文注释：启动实例：清除有意停止标记 → 拉起看门狗 → 轮询健康检查
async function startCommand(opts = {}, home) {
  const runtime = home || config.compatHome();
  const found = findInstance(parseInvocation(opts).name, runtime);
  if (!found.ok) {
    return { ok: false, code: 'instance-not-found', message: found.lines[0], lines: found.lines };
  }
  const instance = found.instance;
  config.setIntentionalStop(instance.compatHome, false);
  const spawned = platform.startWatchdogDetached(instance.compatHome);
  const deadline = Date.now() + START_WAIT_MS;
  let health = null;
  while (Date.now() < deadline) {
    const probe = await ports.probeCompat(LOCAL_HOST, Number(instance.listenPort), 1000);
    if (probe.ours) {
      health = probe.data || {};
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
  const lines = [
    '实例 ' + instance.name + ' 启动' + (health ? '成功' : '失败'),
    '  监听地址   : http://' + LOCAL_HOST + ':' + instance.listenPort,
    '  守护进程   : ' + (spawned && spawned.detail ? spawned.detail : '未拉起'),
    '  健康检查   : ' + (health ? '正常（v' + (health.version || '?') + '）' : '在 ' + START_WAIT_MS + 'ms 内未通过，请查看实例目录下的 logs'),
  ];
  return {
    ok: !!health,
    code: health ? 'instance-started' : 'instance-start-failed',
    message: health ? '已启动' : '启动失败',
    instance,
    health,
    lines,
  };
}

// 中文注释：停止实例：写入有意停止标记并结束该实例目录下的兼容层进程，如实报告残留
async function stopCommand(opts = {}, home) {
  const runtime = home || config.compatHome();
  const found = findInstance(parseInvocation(opts).name, runtime);
  if (!found.ok) {
    return { ok: false, code: 'instance-not-found', message: found.lines[0], lines: found.lines };
  }
  const instance = found.instance;
  config.setIntentionalStop(instance.compatHome, true);
  // 中文注释：带自启的实例要同时注销它自己的任务，否则守护会在一分钟内重新拉起
  if (instance.autostart) {
    try {
      platform.unregisterGuard({ home: instance.compatHome });
      platform.uninstallService({ home: instance.compatHome });
    } catch (err) {
      // 中文注释：注销失败不阻断停止流程，下面会如实报告残留
    }
  }
  const result = await processes.killInstance(config.rootDir(), instance.compatHome);
  const probe = await ports.probeCompat(LOCAL_HOST, Number(instance.listenPort), 600);
  const leftover = Array.isArray(result.remaining) ? result.remaining : [];
  const lines = [
    '实例 ' + instance.name + ' 已停止' + (leftover.length ? '（有残留）' : ''),
    '  结束进程   : ' + (result.killed && result.killed.length ? result.killed.join(', ') : '无'),
    '  残留进程   : ' + (leftover.length ? leftover.join(', ') + '（未能结束，请检查权限）' : '无'),
    '  端口 ' + instance.listenPort + ' : ' + (probe.ours ? '仍在监听（可能有残留进程）' : '已释放'),
  ];
  return {
    ok: leftover.length === 0,
    code: leftover.length ? 'instance-stop-incomplete' : 'instance-stopped',
    instance,
    killed: result.killed || [],
    remaining: leftover,
    lines,
  };
}

// 中文注释：输出实例需要的环境变量与可复制的启动命令；密钥只出现掩码
async function envCommand(opts = {}, home) {
  const runtime = home || config.compatHome();
  const found = findInstance(parseInvocation(opts).name, runtime);
  if (!found.ok) {
    return { ok: false, code: 'instance-not-found', message: found.lines[0], lines: found.lines };
  }
  const instance = found.instance;
  const secret = resolveSecret(instance, runtime);
  const masked = instance.keyStored ? maskSecret(secret === null ? '' : secret) : '（未落盘，请在环境里自行提供）';
  const keyEnv = keyEnvOf(instance);
  // 中文注释：标注当前平台对应的复制方式，避免用户照抄错版本
  const cmdLabel = process.platform === 'win32' ? '（当前平台）' : '';
  const pwshLabel = process.platform === 'win32' ? '' : '（当前平台）';
  const lines = [
    '实例 ' + instance.name + ' 的环境变量与启动方式',
    '',
    '需要设置的环境变量（密钥已掩码，明文见实例目录下的 secrets.env）：',
    '  CODEX_HOME=' + instance.codexHome,
    '  ' + keyEnv + '=' + masked,
    '',
    '一次性设置（cmd）' + cmdLabel + '：',
    '  set "CODEX_HOME=' + instance.codexHome + '" && set "' + keyEnv + '=<密钥掩码 ' + masked + '，请从 secrets.env 取明文>" && codex',
    '',
    '一次性设置（pwsh / PowerShell）' + pwshLabel + '：',
    "  $env:CODEX_HOME='" + instance.codexHome + "'; $env:" + keyEnv + "='<密钥掩码 " + masked + "，请从 secrets.env 取明文>'; codex",
    '',
    'codex 启动命令：',
    '  codex',
    '',
    '推荐（自动注入 CODEX_HOME 与密钥，无需手动复制明文）：',
    '  codex-compat instance run ' + instance.name + ' -- <codex 参数>',
    '',
    '备注：密钥环境变量名 ' + keyEnv + '，密钥文件 ' + found.paths.secretsFile,
  ];
  return { ok: true, code: 'instance-env', instance, maskedKey: masked, lines };
}

// 中文注释：以实例环境启动 codex；"--" 之后的参数原样透传
async function runCommand(opts = {}, home, codexArgs = []) {
  const runtime = home || config.compatHome();
  const found = findInstance(parseInvocation(opts).name, runtime);
  if (!found.ok) {
    return { ok: false, code: 'instance-not-found', message: found.lines[0], lines: found.lines };
  }
  const instance = found.instance;
  const env = Object.assign({}, process.env, { CODEX_HOME: instance.codexHome });
  if (instance.keyStored) {
    const secret = resolveSecret(instance, runtime);
    if (secret !== null) {
      env[keyEnvOf(instance)] = secret;
    }
  }
  const bin = process.env.CODEX_BIN || 'codex';
  const useShell = process.platform === 'win32';
  const args = codexArgs.map((item) => String(item));
  // 中文注释：Windows 下经 cmd 传参会把多行参数截断（实测模型只收到第一行）；
  // 检测到换行时把该参数改为写入子进程 stdin —— codex exec 支持从 stdin 读取提示词。
  let stdinPayload = null;
  if (useShell) {
    const multiLineIndex = args.findIndex((item) => /[\r\n]/.test(item));
    if (multiLineIndex >= 0) {
      stdinPayload = args[multiLineIndex];
      args.splice(multiLineIndex, 1);
    }
  }
  const spawnArgs = useShell ? args.map(quoteForCmd) : args;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(bin, spawnArgs, {
      stdio: [stdinPayload === null ? 'inherit' : 'pipe', 'inherit', 'inherit'],
      shell: useShell,
      env,
    });
    if (stdinPayload !== null) {
      child.stdin.end(stdinPayload + '\n');
    }
    child.on('error', reject);
    child.on('close', (code) => resolve(code === null ? 0 : code));
  }).catch((err) => ({ error: err }));
  if (exitCode && exitCode.error) {
    const message = '启动 codex 失败：' + String(exitCode.error.message || exitCode.error);
    return { ok: false, code: 'instance-run-failed', message, lines: [message] };
  }
  const lines = ['实例 ' + instance.name + ' 的 codex 已退出（exit code ' + exitCode + '）'];
  if (stdinPayload !== null) {
    lines.unshift('提示：参数含换行，已改为经 stdin 传给 codex（Windows 下经 shell 传参会截断）。');
  }
  if (exitCode !== 0) {
    lines.push('  若非 codex 自身退出码：请确认 codex 已安装并在 PATH 中，或用 CODEX_BIN 指定可执行文件。');
  }
  return {
    ok: exitCode === 0,
    code: 'instance-run',
    exitCode,
    lines,
  };
}

// 中文注释：手动把包内提示词同步到实例目录（第一跳的实例版本，手动触发）。
// 实例的提示词由 codex/config.toml 里的 model_instructions_file 指向 <实例>/prompts/，
// 不经过模型目录，所以包内模板更新不会自动到达实例；这里按需刷新，覆盖前备份到实例自己的 backups/。
function updateCommand(opts = {}, home) {
  const runtime = home || config.compatHome();
  const { name } = parseInvocation(opts);
  const targets = [];
  if (name) {
    const found = findInstance(name, runtime);
    if (!found.ok) {
      return { ok: false, code: 'instance-not-found', message: found.lines[0], lines: found.lines };
    }
    targets.push(found.instance);
  } else {
    targets.push(...listInstances(runtime));
  }
  if (!targets.length) {
    const message = '没有已注册的实例；先用 codex-compat instance create <名称> 创建。';
    return { ok: false, code: 'no-instances', message, lines: [message] };
  }
  const content = fs.readFileSync(path.join(config.rootDir(), 'config', 'prompts', 'deepseek-codex.md'), 'utf8');
  const dryRun = !!opts.dryRun;
  const lines = [];
  const updated = [];
  const skipped = [];
  for (const instance of targets) {
    const paths = instancePaths(instance.name, runtime);
    if (instance.catalogMode && instance.catalogMode !== CATALOG_MODE_INSTRUCTIONS) {
      // 中文注释：非 instructions 模式的实例没有提示词文件，提示词随它自己的模型目录走
      lines.push(instance.name + '：catalogMode=' + instance.catalogMode + '，没有 model_instructions_file，未处理');
      skipped.push({ name: instance.name, reason: 'catalog-mode' });
      continue;
    }
    const current = fs.existsSync(paths.promptFile) ? fs.readFileSync(paths.promptFile, 'utf8') : null;
    if (current === content) {
      lines.push(instance.name + '：已是最新（' + content.length + ' 字符）');
      continue;
    }
    if (dryRun) {
      lines.push(instance.name + '：待更新（' + (current === null ? '缺失' : current.length + ' 字符') + ' → ' + content.length + ' 字符）');
      updated.push(instance.name);
      continue;
    }
    let backup = null;
    if (current !== null) {
      const backupDir = path.join(paths.compatHome, 'backups');
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      backup = path.join(backupDir, 'deepseek-codex.' + new Date().toISOString().replace(/[:.]/g, '-') + '.md');
      fs.writeFileSync(backup, current, { mode: 0o600 });
    }
    files.atomicWrite(paths.promptFile, content, current);
    updated.push(instance.name);
    lines.push(instance.name + '：' + (current === null ? '已写入' : '已更新')
      + '（' + (current === null ? 0 : current.length) + ' → ' + content.length + ' 字符'
      + (backup ? '，旧版备份 ' + backup : '') + '）');
  }
  lines.push('');
  lines.push('提示：实例里已经打开的 Codex 会话需要新起一轮才会读到新提示词。');
  return { ok: true, code: 'instance-updated', dryRun, changed: updated.length > 0, updated, skipped, lines };
}

// 中文注释：刷新实例的模型目录；catalog 模块不存在时给出明确说明
async function refreshCatalogCommand(opts = {}, home) {
  const runtime = home || config.compatHome();
  const found = findInstance(parseInvocation(opts).name, runtime);
  if (!found.ok) {
    return { ok: false, code: 'instance-not-found', message: found.lines[0], lines: found.lines };
  }
  const instance = found.instance;
  let catalog = null;
  try {
    catalog = require('./catalog.cjs');
  } catch (err) {
    catalog = null;
  }
  if (!catalog || typeof catalog.refresh !== 'function') {
    const message = 'catalog 模块不存在或不支持 refresh（src/catalog.cjs），已跳过刷新';
    return { ok: false, code: 'catalog-module-missing', message, lines: [message] };
  }
  const lines = [];
  try {
    const result = await catalog.refresh({
      home: instance.compatHome,
      upstream: instance.upstream,
      apiKey: resolveSecret(instance, runtime),
    });
    lines.push('已刷新实例 ' + instance.name + ' 的模型目录。');
    if (result && result.lines && result.lines.length) {
      lines.push(...result.lines);
    } else if (result && result.message) {
      lines.push(result.message);
    }
    return { ok: !(result && result.ok === false), code: 'instance-catalog-refreshed', result, lines };
  } catch (err) {
    const message = '刷新模型目录失败：' + String(err && err.message || err);
    return { ok: false, code: 'catalog-refresh-failed', message, lines: [message] };
  }
}

// 中文注释：删除实例：先停止，再删除整个实例目录
async function removeCommand(opts = {}, home) {
  const runtime = home || config.compatHome();
  const found = findInstance(parseInvocation(opts).name, runtime);
  if (!found.ok) {
    return { ok: false, code: 'instance-not-found', message: found.lines[0], lines: found.lines };
  }
  const instance = found.instance;
  const stopped = await stopCommand(opts, runtime);
  const dir = found.paths.dir;
  fs.rmSync(dir, { recursive: true, force: true });
  const lines = [
    '实例 ' + instance.name + ' 已删除',
    '  已删除目录 : ' + dir,
    '  结束进程   : ' + (stopped.killed && stopped.killed.length ? stopped.killed.join(', ') : '无'),
    '  残留进程   : ' + (stopped.remaining && stopped.remaining.length ? stopped.remaining.join(', ') + '（未能结束，请检查权限）' : '无'),
  ];
  return {
    ok: true,
    code: 'instance-removed',
    deleted: dir,
    killed: stopped.killed || [],
    remaining: stopped.remaining || [],
    lines,
  };
}

// 中文注释：子命令帮助
function helpCommand() {
  return {
    ok: true,
    code: 'instance-help',
    lines: [
      'codex-compat 实例（多开 / lab）',
      '',
      '  instance create <名称> --model <模型> [--provider cc-switch|http(s)://…|host:port] [--models a,b]',
      '                          [--key <明文> | --key-env <变量名>] [--catalog-mode catalog|instructions|none] [--autostart]',
      '  instance list',
      '  instance status <名称>',
      '  instance start <名称>',
      '  instance stop <名称>',
      '  instance env <名称>',
      '  instance run <名称> [-- <codex 参数>]',
      '  instance refresh-catalog <名称>（别名：instance refresh <名称>）',
      '  instance update [<名称>]（省略名称 = 全部实例；把包内提示词刷新到实例，覆盖前备份）',
      '  instance remove <名称>',
    ],
  };
}

module.exports = {
  PORT_FROM,
  PORT_TO,
  INSTANCE_KIND,
  DEFAULT_KEY_ENV,
  CATALOG_MODES,
  DEFAULT_CATALOG_MODE,
  SECRETS_FILE,
  META_FILE,
  SUBCOMMANDS,
  instancesRoot,
  instanceDir,
  instancePaths,
  maskSecret,
  readSecrets,
  writeSecrets,
  resolveSecret,
  keyLabel,
  keyEnvOf,
  upstreamLabel,
  upstreamBaseUrl,
  // 中文注释：供 watchdog 解析实例自己的 CODEX_HOME，避免映射同步落到宿主目录
  instanceCodexHome,
  readInstanceAt,
  listInstances,
  usedPorts,
  pickInstancePort,
  normalizeName,
  parseProvider,
  tomlString,
  renderCodexConfig,
  copyPrompt,
  fetchModelCandidates,
  findInstance,
  parseInvocation,
  splitPassthrough,
  quoteForCmd,
  createInstance,
  listCommand,
  statusCommand,
  startCommand,
  stopCommand,
  envCommand,
  runCommand,
  refreshCatalogCommand,
  updateCommand,
  removeCommand,
  helpCommand,
};
