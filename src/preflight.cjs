// 安装前置检查：把「能不能安全安装」的所有判断收口在一处，供 CLI 与菜单复用。
const fs = require('node:fs');
const path = require('node:path');
const toml = require('@iarna/toml');
const config = require('./config.cjs');
const platform = require('./platform.cjs');
const ccswitch = require('./ccswitch.cjs');
const codexconfig = require('./codexconfig.cjs');
const ports = require('./ports.cjs');
const manifest = require('./manifest.cjs');
const { hash } = require('./manifest.cjs');

// 中文注释：读取 Codex 版本记录（仅用于展示与排查）
function codexVersion(codexHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(codexHome, 'version.json'), 'utf8'));
    return parsed.version || parsed.latest_version || null;
  } catch (err) {
    return null;
  }
}

// 中文注释：执行完整预检
async function run(input = {}) {
  const { cfg, error: configError } = config.loadSafe(input);
  const checks = [];
  const add = (id, level, ok, detail, hint) => checks.push({ id, level, ok, detail: detail || '', hint: hint || '' });

  // 1. Node 运行时
  const major = Number(String(process.versions.node).split('.')[0]);
  add('node', 'error', major >= 18, 'Node ' + process.version, '需要 Node.js 18 或更高版本');

  // 2. Codex 配置
  const codexHome = platform.codexHome();
  const configPath = path.join(codexHome, 'config.toml');
  let configText = null;
  let configParsed = false;
  if (!fs.existsSync(configPath)) {
    add('codex-config', 'error', false, '未找到 ' + configPath, '确认 CODEX_HOME 正确，并至少启动过一次 Codex');
  } else {
    try {
      configText = fs.readFileSync(configPath, 'utf8');
      toml.parse(configText);
      configParsed = true;
      add('codex-config', 'error', true, configPath);
    } catch (err) {
      add('codex-config', 'error', false, 'config.toml 解析失败：' + err.message, '修复语法后重试');
    }
  }
  if (configError) {
    add('compat-config', 'warn', false, '兼容层配置读取失败：' + configError, '将使用默认配置继续');
  }

  // 3. Codex 版本
  const version = codexVersion(codexHome);
  add('codex-version', 'info', true, version ? 'Codex ' + version : '未记录版本（不影响安装）');

  // 4. 现有安装清单
  let existingManifest = null;
  try {
    existingManifest = manifest.read(config.paths(cfg.home).manifestFile);
  } catch (err) {
    add('manifest', 'warn', false, '安装清单损坏：' + err.message, '可执行 restore --force 或删除清单后重新安装');
  }

  // 5. 定位 provider 与真实上游
  const compatUrl = codexconfig.listenUrl(cfg);
  const provider = configParsed
    ? codexconfig.detectProvider(configText, {
      providerKey: existingManifest && existingManifest.providerKey,
      expectedUrl: compatUrl,
      originalUrl: existingManifest && existingManifest.originalBaseUrl ? existingManifest.originalBaseUrl.value : null,
    })
    : { key: null, baseUrl: null };
  // 中文注释：是否已有可用的本地模型目录来源（显式配置或默认文件名）；
  // 已有时沿用「文件补丁」方式，绝不改写成 provider 级目录，避免覆盖更完整的元数据。
  const hasGlobalCatalog = (() => {
    if (!configParsed) {
      return false;
    }
    try {
      const configured = toml.parse(configText).model_catalog_json;
      if (typeof configured === 'string' && configured.trim().length > 0) {
        return true;
      }
      return fs.existsSync(path.join(codexHome, 'cc-switch-model-catalog.json'));
    } catch (err) {
      return false;
    }
  })();
  const cc = ccswitch.detect();

  // 中文注释：判断 base_url 是否指向本工具的实例；只看端口区间不够，还要看健康签名
  const parsedBase = provider.baseUrl && codexconfig.isLocalUrl(provider.baseUrl)
    ? codexconfig.parseUpstreamUrl(provider.baseUrl)
    : null;
  const baseProbe = parsedBase ? await ports.probeCompat(parsedBase.host, parsedBase.port) : null;
  const managedRange = !!parsedBase && parsedBase.port >= ports.DEFAULT_PORT && parsedBase.port <= ports.SCAN_TO;
  const oursByProbe = !!(baseProbe && baseProbe.ours);
  // 中文注释：已安装但改了端口时，旧地址仍应被识别为兼容层
  const manifestUrl = existingManifest && existingManifest.listenPort
    ? 'http://' + cfg.listen.host + ':' + existingManifest.listenPort + ((existingManifest.upstream && existingManifest.upstream.basePath) || cfg.upstream.basePath)
    : null;
  let alreadyInstalled = provider.baseUrl === compatUrl || (!!manifestUrl && provider.baseUrl === manifestUrl) || oursByProbe;
  let legacyGeneration = false;
  let providerBlocked = false;
  if (!alreadyInstalled && managedRange) {
    if (cc.takingOver) {
      // 中文注释：端口落在本工具区间、不是本代实例，但 CC Switch 在接管：按上一代兼容层处理
      alreadyInstalled = true;
      legacyGeneration = true;
    } else {
      providerBlocked = true;
      add('provider', 'error', false,
        'base_url 指向本工具的端口区间（' + parsedBase.port + '），但该端口不是 codex-compat 实例',
        '请确认它是你的真实上游，或用 --upstream <host:port> 显式指定上游后重试');
    }
  }

  let upstream = null;
  let originalBaseUrl = null;
  if (alreadyInstalled) {
    originalBaseUrl = existingManifest && existingManifest.originalBaseUrl ? existingManifest.originalBaseUrl : null;
    upstream = (existingManifest && existingManifest.upstream) || {
      host: cc.takingOver ? cc.listenHost : cfg.upstream.host,
      port: cc.takingOver ? cc.listenPort : cfg.upstream.port,
      basePath: cfg.upstream.basePath,
      mode: cc.takingOver ? 'cc-switch' : 'custom',
    };
    // 中文注释：已有安装但清单丢失时，用 CC Switch 探测结果重建原上游，保证仍可还原
    if (!originalBaseUrl && cc.takingOver) {
      const rebuilt = 'http://' + cc.listenHost + ':' + cc.listenPort + cfg.upstream.basePath;
      originalBaseUrl = { value: rebuilt, hash: hash(rebuilt), rebuilt: true };
    }
    add('provider', 'info', true, 'config.toml 已指向兼容层，本次按「修复/重装」处理');
    if (legacyGeneration) {
      add('provider', 'info', true, '检测到上一代兼容层端口 ' + parsedBase.port + '，已按已安装处理并用 CC Switch 重建还原点');
    }
    if (!originalBaseUrl) {
      add('original-url', 'warn', false, '无法确定原始上游地址（未找到安装清单且未检测到 CC Switch）',
        '还原时将跳过 base_url 回退，请记录原上游或先安装一次完整流程');
    }
  } else if (provider.baseUrl && !providerBlocked) {
    const parsed = codexconfig.parseUpstreamUrl(provider.baseUrl);
    if (!parsed) {
      add('provider', 'error', false, '无法解析上游地址：' + provider.baseUrl, '检查 model_providers.' + provider.key + '.base_url');
    } else {
      upstream = {
        host: parsed.host,
        port: parsed.port,
        basePath: parsed.basePath,
        mode: parsed.port === cc.listenPort && codexconfig.isLocalUrl(provider.baseUrl) ? 'cc-switch' : 'custom',
      };
      originalBaseUrl = { value: provider.baseUrl, hash: hash(provider.baseUrl) };
      add('provider', 'error', true, '检测到 provider ' + provider.key + ' → ' + provider.baseUrl);
    }
  } else {
    add('provider', 'error', false, '未找到可接入的 model_providers 条目', '请先配置一个第三方 provider（例如 CC Switch 或自定义端点）');
  }

  // 6. CC Switch 状态（可选依赖，仅提示）
  add('ccswitch', cc.installed ? (cc.takingOver ? 'info' : 'warn') : 'info', true, ccswitch.describe(cc),
    cc.takingOver ? '' : '如果上游不是 CC Switch，可忽略此提示');

  // 7. 监听端口
  const selection = await ports.selectListenPort({
    host: cfg.listen.host,
    preferred: input.port !== undefined ? input.port : cfg.listen.port,
    ownedPort: existingManifest && existingManifest.listenPort ? existingManifest.listenPort : null,
    home: cfg.home,
  });
  add('listen-port', 'error', selection.ok,
    selection.ok
      ? ('端口 ' + selection.port + (selection.reused ? '（复用现有实例）' : '（可用）'))
      : selection.reason,
    '可用 --port 指定其他端口，或释放被占用端口');

  // 8. 上游可达性
  if (upstream) {
    const reachable = await ports.isReachable(upstream.host, upstream.port, 2000);
    const local = upstream.host === '127.0.0.1' || upstream.host === 'localhost' || upstream.host === '::1';
    if (local) {
      add('upstream', 'error', reachable, upstream.host + ':' + upstream.port, '确认 CC Switch 或本地上游已启动');
    } else {
      add('upstream', 'warn', reachable, upstream.host + ':' + upstream.port,
        reachable ? '' : '远程上游不可达或需要代理，请确认网络与地址');
    }
  }

  // 9. 远程上游风险提示
  if (upstream && !codexconfig.isLocalUrl('http://' + upstream.host + ':' + upstream.port)) {
    // 中文注释：本工具处于凭据链路上，远程上游必须显式确认，否则预检直接失败
    const allowed = input.allowRemoteUpstream === true;
    add('remote-upstream', allowed ? 'warn' : 'error', allowed,
      '上游不是本机地址（' + upstream.host + ':' + upstream.port + '），认证头会经本机代理转发到远端',
      allowed ? '已通过 --allow-remote-upstream 显式确认' : '如确需远程上游，请显式加 --allow-remote-upstream');
  }

  const errors = checks.filter((item) => item.level === 'error' && !item.ok);
  return {
    ok: errors.length === 0,
    errors,
    checks,
    cfg,
    configError,
    codexHome,
    configPath,
    configText,
    providerKey: provider.key,
    hasGlobalCatalog,
    alreadyInstalled,
    originalBaseUrl,
    listenPort: selection.port || cfg.listen.port,
    reusedInstance: !!selection.reused,
    upstream,
    ccswitch: cc,
    // 中文注释：完整排查信息；只由 --verbose 打印，默认输出不受影响
    diagnostics: {
      codexHome,
      compatHome: cfg.home,
      configPath,
      manifestFile: config.paths(cfg.home).manifestFile,
      provider: { key: provider.key, baseUrl: provider.baseUrl },
      portSelection: {
        requested: selection.requested,
        port: selection.port,
        reused: selection.reused,
        attempts: selection.attempts,
      },
      ccswitch: cc,
      upstream,
    },
  };
}

module.exports = { run, codexVersion };
