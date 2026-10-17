// install / repair：预检 → 落位配置 → 改写 Codex base_url → 同步映射角色 → 注册服务 → 健康检查。
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const toml = require('@iarna/toml');
const { isDeepStrictEqual } = require('node:util');
const config = require('../config.cjs');
const platform = require('../platform.cjs');
const preflight = require('../preflight.cjs');
const manifestLib = require('../manifest.cjs');
const codexconfig = require('../codexconfig.cjs');
const mappings = require('../mappings.cjs');
const seed = require('../seed.cjs');
const templatesLib = require('../templates.cjs');
const files = require('../config-files.cjs');
const ports = require('../ports.cjs');
const processes = require('../processes.cjs');

// 中文注释：解析 --upstream 参数，支持 host:port 与完整 URL
function parseUpstreamOption(value) {
  if (!value || value === true) {
    return null;
  }
  const text = String(value);
  if (/^https?:\/\//i.test(text)) {
    const parsed = codexconfig.parseUpstreamUrl(text);
    if (!parsed) {
      throw new Error('--upstream 无法解析：' + text);
    }
    return { host: parsed.host, port: parsed.port, basePath: parsed.basePath, mode: 'custom' };
  }
  const match = /^([^:]+):(\d+)$/.exec(text);
  if (!match) {
    throw new Error('--upstream 需要形如 127.0.0.1:15721 或完整 URL');
  }
  return { host: match[1], port: Number(match[2]), basePath: '/v1', mode: 'custom' };
}

// 中文注释：等待兼容层健康检查通过
// 中文注释：等待健康端点就绪；传入 expectedHome 时只接受「同一个运行目录」的实例，
// 避免把别的实例（例如主实例）的端口误判成自己启动成功
async function waitForHealth(host, port, timeoutMs, expectedHome) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await ports.probeCompat(host, port, 1200);
    const ownHome = !expectedHome
      || !probe.data
      || !probe.data.home
      || samePath(probe.data.home, expectedHome);
    if (probe.ours && ownHome) {
      return probe.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

// 中文注释：路径比较；Windows 不区分大小写，其余平台按原样
function samePath(left, right) {
  if (!left || !right) {
    return false;
  }
  const norm = (value) => {
    const resolved = path.resolve(String(value)).replace(/\\/g, '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(left) === norm(right);
}

// 中文注释：命令行交互确认；非交互环境必须显式 --yes
function confirm(question) {
  if (!process.stdin.isTTY) {
    return Promise.resolve(false);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + ' [y/N] ', (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

// 中文注释：把生效配置打印成可读计划
function planLines(pf, nextCfg, userMapping) {
  const lines = ['安装计划：'];
  lines.push('  Codex 配置     : ' + pf.configPath);
  lines.push('  provider       : ' + (pf.providerKey || '（未识别）'));
  lines.push('  上游地址       : ' + (pf.upstream ? pf.upstream.host + ':' + pf.upstream.port + (pf.upstream.basePath || '') : '（未识别）'));
  lines.push('  监听地址       : http://' + nextCfg.listen.host + ':' + nextCfg.listen.port);
  lines.push('  写入 base_url  : ' + codexconfig.listenUrl(nextCfg));
  if (pf.originalBaseUrl) {
    lines.push('  原始 base_url  : ' + pf.originalBaseUrl.value + '（将记录到安装清单）');
  }
  lines.push('  用户配置目录   : ' + config.paths(nextCfg.home).configDir);
  lines.push('  映射文件       : ' + userMapping);
  lines.push('  DeepSeek 优化  : 提示词=' + (nextCfg.features.deepseekPrompt ? '开' : '关')
    + '，子代理角色=' + (nextCfg.features.deepseekRoles ? '开' : '关'));
  // 中文注释：provider 级目录托管目前不被 Codex 拉取，开启时如实标注「实测无效果」，避免用户误以为是主通路
  lines.push('  模型目录托管   : ' + (nextCfg.features.providerCatalog
    ? '开（未来路线；实测 Codex 0.160.1 不拉取，暂时无效果）'
    : '关（默认；该路径当前 Codex 不支持）')
    + '，纯官方保护=' + (nextCfg.features.officialGuard ? '开' : '关'));
  lines.push('  自启与守护     : ' + (nextCfg.service.autoStart ? '开' : '关')
    + '，抢回策略=' + nextCfg.service.reclaim);
  lines.push('  CC Switch      : ' + require('../ccswitch.cjs').describe(pf.ccswitch));
  return lines;
}

// 中文注释：安装主流程
async function install(opts = {}) {
  const pf = await preflight.run({
    home: opts.home,
    port: opts.port !== undefined ? opts.port : undefined,
    allowRemoteUpstream: opts.allowRemoteUpstream === true,
  });

  const upstreamOverride = parseUpstreamOption(opts.upstream);
  if (upstreamOverride) {
    pf.upstream = Object.assign({}, pf.upstream, upstreamOverride);
    pf.checks.push({ id: 'upstream-override', level: 'info', ok: true, detail: '命令行指定上游 ' + pf.upstream.host + ':' + pf.upstream.port, hint: '' });
  }

  const home = pf.cfg.home;

  // 中文注释：--verbose 专用排查信息；不开启时完全不影响既有输出
  const verboseLines = () => {
    if (!opts.verbose) {
      return [];
    }
    const d = pf.diagnostics || {};
    const attempts = (d.portSelection && d.portSelection.attempts) || [];
    const out = [
      '',
      '详细信息（--verbose）：',
      '  Codex 配置         : ' + (d.configPath || ''),
      '  运行目录           : ' + (d.compatHome || home),
      '  安装清单           : ' + (d.manifestFile || ''),
      '  provider 识别      : ' + JSON.stringify(d.provider || null),
      '  端口选择           : 请求 ' + ((d.portSelection && d.portSelection.requested) || '') + ' → 选中 ' + ((d.portSelection && d.portSelection.port) || '')
        + (d.portSelection && d.portSelection.reused ? '（复用现有实例）' : ''),
      '  端口尝试明细       : ' + (attempts.length
        ? attempts.map((item) => item.port + (item.ours ? '(本工具实例)' : '(被外部占用)')).join(', ')
        : '首选端口可直接使用，无冲突'),
      '  CC Switch 原始探测 : ' + JSON.stringify(d.ccswitch || null),
      '  解析出的上游       : ' + JSON.stringify(d.upstream || pf.upstream || null),
    ];
    const commands = platform.recentCommandsSnapshot ? platform.recentCommandsSnapshot() : [];
    if (commands.length) {
      out.push('  最近系统命令：');
      commands.slice(-6).forEach((item) => out.push('    [' + item.label + '] ' + item.script));
    }
    return out;
  };

  if (!pf.ok) {
    // 中文注释：只有「用户当前就依赖兼容层」时才兜底保活；
    // 纯官方用户（没有第三方 provider）必须零写入、零进程、零计划任务。
    let rescue = null;
    const nodeCheck = pf.checks.find((item) => item.id === 'node');
    const nodeOk = !nodeCheck || nodeCheck.ok;
    const rescueCfg = config.loadSafe({ home }).cfg;
    const dependsOnUs = (() => {
      if (pf.alreadyInstalled) {
        return true;
      }
      if (!pf.configText) {
        return false;
      }
      try {
        return codexconfig.pointsAtCompat(pf.configText, rescueCfg);
      } catch (err) {
        // 中文注释：config.toml 不可解析时退化为字符串判断，避免给纯官方用户装服务
        return pf.configText.includes(codexconfig.listenUrl(rescueCfg));
      }
    })();
    if (nodeOk && dependsOnUs) {
      try {
        rescue = platform.installService({ cfg: rescueCfg });
        if (rescueCfg.service.guard) {
          platform.registerGuard({ cfg: rescueCfg });
        }
      } catch (err) {
        rescue = { ok: false, detail: String(err && err.message || err) };
      }
    }
    return {
      ok: false,
      code: 'preflight-failed',
      lines: ['预检未通过：']
        .concat(pf.errors.map((item) => '  [异常] ' + item.id + '：' + item.detail + (item.hint ? '（' + item.hint + '）' : '')))
        .concat(rescue ? ['', '已保持常驻服务运行：' + rescue.detail] : [])
        .concat(verboseLines()),
      message: '预检未通过，未做任何改动',
      checks: pf.checks,
      errors: pf.errors,
    };
  }

  const nextCfg = config.loadSafe({
    home,
    port: pf.listenPort,
    upstreamHost: pf.upstream ? pf.upstream.host : undefined,
    upstreamPort: pf.upstream ? pf.upstream.port : undefined,
    upstreamBasePath: pf.upstream ? pf.upstream.basePath : undefined,
    reclaim: opts.reclaim,
  }).cfg;
  if (opts.deepseekPrompt !== undefined) {
    nextCfg.features.deepseekPrompt = !!opts.deepseekPrompt;
  }
  if (opts.deepseekRoles !== undefined) {
    nextCfg.features.deepseekRoles = !!opts.deepseekRoles;
  }
  if (opts.service === false) {
    nextCfg.service.autoStart = false;
  }
  if (pf.upstream) {
    nextCfg.upstream.mode = pf.upstream.mode || nextCfg.upstream.mode;
    nextCfg.upstream.baseUrl = null;
  }
  // 中文注释：首次安装时把系统语言固化到配置，避免每次进菜单重新探测
  if (nextCfg.runtime.lang === 'auto') {
    nextCfg.runtime.lang = require('../locale.cjs').systemLocale();
  }

  const userMapping = config.paths(home).mappingFile;
  // 中文注释：CODEX_MAPPING_FILE 是显式覆盖，优先级高于用户级默认映射
  const effectiveMapping = process.env.CODEX_MAPPING_FILE || userMapping;
  const lines = planLines(pf, nextCfg, userMapping);

  if (opts.dryRun || opts.check) {
    return { ok: true, code: 'dry-run', lines: lines.concat(['', '（预演模式，未写入任何文件）'], verboseLines()), plan: { listenPort: nextCfg.listen.port, upstream: pf.upstream }, checks: pf.checks };
  }

  if (!opts.yes && opts.interactive !== false) {
    lines.forEach((line) => process.stdout.write(line + '\n'));
    const agreed = await confirm('确认执行以上变更？');
    if (!agreed) {
      return { ok: false, code: 'cancelled', message: '已取消，未做任何改动' };
    }
  }

  const actions = [];

  // 0. 清除「有意停止」标记：否则看门狗启动后会直接退出，健康检查必然失败
  const wasHeld = config.isIntentionalStopped(home);
  config.setIntentionalStop(home, false);
  if (wasHeld) {
    actions.push('已清除有意停止标记（否则看门狗会被跳过）');
  }

  // 1. 持久化配置
  config.save(nextCfg, home);
  actions.push('配置已写入 ' + config.paths(home).configFile);

  // 2. 落位用户配置目录（含 mappings.toml）；首次落位之后不再整目录覆盖
  const seeded = seed.seed(home, { force: !!opts.refreshConfig });
  actions.push(seeded.created
    ? '已落位用户配置目录 ' + seeded.target
    : (opts.refreshConfig ? '已按 --refresh-config 覆盖用户级模板与提示词' : '用户配置目录已存在，保持原样'));

  // 2.5 第一跳：把包内模板与提示词同步到运行目录。
  // 受管语义：没被本地改过的按策略自动刷新，被改过的只报告（--force 才覆盖）；
  // --refresh-templates 是显式刷新，等价于对受管文件用 auto 策略再跑一次。
  let templateResult = null;
  try {
    templateResult = templatesLib.sync({
      home,
      policy: opts.refreshTemplates ? 'auto' : nextCfg.service.templateRefresh,
      force: !!opts.force,
      pkgVersion: config.version(),
    });
    actions.push('模板与提示词：' + templatesLib.describe(templateResult));
  } catch (err) {
    actions.push('模板与提示词同步失败（不阻断兼容层）：' + String(err && err.message || err));
  }

  // 3. DeepSeek 开关
  mappings.setBindingFlags({ home: pf.codexHome, mappingFile: effectiveMapping, enabled: nextCfg.features.deepseekPrompt, roleEnabled: nextCfg.features.deepseekRoles });
  actions.push('DeepSeek 开关已同步（提示词=' + (nextCfg.features.deepseekPrompt ? '开' : '关') + '，角色=' + (nextCfg.features.deepseekRoles ? '开' : '关') + '）');

  // 4. 同步模型映射与角色
  let mappingResult;
  try {
    mappingResult = mappings.apply({
      home: pf.codexHome,
      mappingFile: effectiveMapping,
      forceRoles: !!opts.forceRoles,
      officialGuard: nextCfg.features.officialGuard,
    });
    actions.push('模型映射与角色：' + (mappingResult.changed ? '已更新' : '已是最新') + (mappingResult.changeId ? '（changeId=' + mappingResult.changeId + '）' : ''));
  } catch (err) {
    mappingResult = { ok: false, detail: String(err && err.message || err) };
    actions.push('模型映射同步失败（不阻断兼容层）：' + mappingResult.detail);
  }

  // 4.5 provider 级模型目录：仅在「缺少全局 catalog + 有第三方 provider + 开关打开」时托管
  let previousManifest = null;
  try {
    previousManifest = manifestLib.read(config.paths(home).manifestFile);
  } catch (err) {
    previousManifest = null;
  }
  const extraWrites = [];
  const catalogUrl = 'http://' + nextCfg.listen.host + ':' + nextCfg.listen.port + '/__compat/catalog';
  const catalogKeys = pf.providerKey ? ['model_providers', pf.providerKey, 'model_catalog_url'] : null;
  const previousExtras = (previousManifest && previousManifest.extraWrites) || [];
  // 中文注释：provider 级目录需要 Codex ≥ 0.156；低版本不写该键
  const catalogGate = require('../codex-version.cjs').supportsProviderCatalog();
  if (!catalogGate.ok) {
    actions.push('Codex 版本 ' + catalogGate.raw + ' 不支持 provider 级模型目录，已跳过托管（可继续使用本地模型目录文件）');
  }
  const wantsCatalog = nextCfg.features.providerCatalog === true && !!pf.providerKey && !pf.hasGlobalCatalog && catalogGate.ok;
  // 中文注释：回收此前由我们写入的 provider 扩展键（开关关闭、上游已原生、或刷新失败时）
  const revertExtras = () => {
    for (const extra of previousExtras.slice().reverse()) {
      try {
        const currentText = fs.readFileSync(pf.configPath, 'utf8');
        const parsed = toml.parse(currentText);
        if (!isDeepStrictEqual(files.snapshot(parsed, extra.keys), extra.after)) {
          actions.push('跳过回收（已被外部修改）：' + extra.keys.join('.'));
          continue;
        }
        const nextText = files.setSection(currentText, extra.keys, extra.before);
        files.atomicWrite(pf.configPath, nextText, currentText);
        actions.push('已回收 provider 扩展键：' + extra.keys.join('.'));
      } catch (err) {
        actions.push('回收失败：' + extra.keys.join('.') + '（' + String(err && err.message || err) + '）');
      }
    }
  };
  if (wantsCatalog) {
    let apiKey = opts.upstreamKey || null;
    if (!apiKey) {
      // 中文注释：沿用 provider 自己的 env_key 约定，避免把密钥写进任何文件
      try {
        const providerConfig = toml.parse(fs.readFileSync(pf.configPath, 'utf8')).model_providers[pf.providerKey];
        if (providerConfig && providerConfig.env_key && process.env[providerConfig.env_key]) {
          apiKey = process.env[providerConfig.env_key];
        }
      } catch (err) {
        apiKey = null;
      }
    }
    // 中文注释：先探测上游是否已自带 Codex 原生目录；是则保持现状，避免用中性字段覆盖更完整的元数据
    const catalogModule = require('../catalog.cjs');
    const probed = await catalogModule.probe(pf.upstream, apiKey);
    const catalogResult = (probed.ok && probed.native)
      ? { ok: false, code: 'native-catalog', message: '上游已返回 Codex 原生模型目录，无需托管（共 ' + probed.count + ' 个模型）' }
      : await (async () => {
        if (!probed.ok) {
          actions.push('无法探测上游模型端点：' + probed.error + '（尝试直接生成目录）');
        }
        return catalogModule.refresh({
          home,
          upstream: pf.upstream,
          mappingFile: effectiveMapping,
          officialGuard: nextCfg.features.officialGuard,
          apiKey,
        });
      })();
    if (catalogResult.ok) {
      const currentText = fs.readFileSync(pf.configPath, 'utf8');
      const before = files.snapshot(toml.parse(currentText), catalogKeys);
      const nextText = files.setSection(currentText, catalogKeys, { exists: true, value: catalogUrl });
      if (nextText !== currentText) {
        files.atomicWrite(pf.configPath, nextText, currentText);
        extraWrites.push({ keys: catalogKeys, before, after: { exists: true, value: catalogUrl } });
        actions.push('已托管 provider 模型目录：' + catalogUrl + '（模型 ' + catalogResult.total + ' 个，注入提示词 ' + catalogResult.injected.length + ' 个）');
      }
    } else {
      actions.push('模型目录未生成：' + catalogResult.message);
      if (previousExtras.length) {
        revertExtras();
      }
    }
  } else if (previousExtras.length) {
    revertExtras();
  }

  // 5. 记录安装清单（必须先于改写 config.toml，保证可还原）
  // 中文注释：已经安装过时，绝不用当前 base_url 覆盖清单里的原始上游，避免「自己指向自己」
  const original = (previousManifest && previousManifest.originalBaseUrl)
    || pf.originalBaseUrl
    || (pf.providerKey ? { value: codexconfig.readBaseUrl(pf.configText, pf.providerKey), hash: manifestLib.hash(codexconfig.readBaseUrl(pf.configText, pf.providerKey)) } : null);
  const createdRoles = Array.from(new Set(
    ((previousManifest && previousManifest.createdRoles) || [])
      .concat((mappingResult && mappingResult.files ? mappingResult.files : []).filter((file) => file.includes(path.sep + 'agents' + path.sep)))
  ));
  const manifest = manifestLib.write(config.paths(home).manifestFile, {
    installed: true,
    installedAt: new Date().toISOString(),
    toolVersion: config.version(),
    codexHome: pf.codexHome,
    configPath: pf.configPath,
    providerKey: pf.providerKey,
    originalBaseUrl: original,
    listenHost: nextCfg.listen.host,
    listenPort: nextCfg.listen.port,
    upstream: pf.upstream,
    appliedChangeId: (mappingResult && mappingResult.changeId)
      || (previousManifest && previousManifest.appliedChangeId)
      || null,
    createdRoles,
    // 中文注释：记录 provider 级扩展键（如 model_catalog_url）的改动，供 restore 精确回收
    extraWrites,
  });
  actions.push('安装清单已写入，原始 base_url 已记录，可随时 restore');

  // 6. 改写 Codex base_url
  const target = codexconfig.listenUrl(nextCfg);
  const currentText = fs.readFileSync(pf.configPath, 'utf8');
  const currentUrl = codexconfig.readBaseUrl(currentText, pf.providerKey);
  if (currentUrl !== target) {
    const nextText = codexconfig.writeBaseUrl(currentText, pf.providerKey, target);
    files.atomicWrite(pf.configPath, nextText, currentText);
    actions.push('base_url：' + currentUrl + ' → ' + target);
  } else {
    actions.push('base_url 已指向兼容层，无需改写');
  }

  // 7. 停止不在目标端口上的旧实例，再注册服务与守护
  if (nextCfg.service.autoStart && !pf.reusedInstance) {
    const stopped = await processes.killInstance(platform.paths(home).root, home);
    if (stopped.killed.length) {
      actions.push('已停止旧实例进程：' + stopped.killed.join(', '));
    }
    if (stopped.remaining.length) {
      actions.push('警告：仍有残留进程未能结束：' + stopped.remaining.join(', '));
    }
  }
  const ownLegacy = platform.cleanupOwnLegacyTasks(home);
  if (ownLegacy.removed.length) {
    actions.push(ownLegacy.detail);
  }
  if (opts.cleanupLegacy) {
    actions.push(platform.cleanupLegacyTasks().detail);
  }

  let serviceResult = { ok: true, detail: '未启用自启' };
  let guardResult = { ok: true, detail: '未启用守护' };
  if (nextCfg.service.autoStart) {
    serviceResult = platform.installService({ cfg: nextCfg });
    actions.push('常驻服务：' + serviceResult.detail);
    if (nextCfg.service.guard) {
      guardResult = platform.registerGuard({ cfg: nextCfg });
      actions.push('守护任务：' + guardResult.detail);
    }
  } else {
    actions.push('按配置跳过自启与守护（可用 codex-compat start 随时启动）');
  }

  // 8. 兜底拉起 + 健康检查
  let health = await waitForHealth(nextCfg.listen.host, nextCfg.listen.port, 12000, home);
  if (!health) {
    actions.push('服务方式未就绪，改用后台进程兜底拉起');
    platform.startWatchdogDetached(home);
    health = await waitForHealth(nextCfg.listen.host, nextCfg.listen.port, 8000, home);
  }
  if (health) {
    actions.push('健康检查通过：' + health.name + ' v' + health.version + ' 监听 ' + health.port + ' → 上游 ' + health.upstreamPort);
  } else {
    actions.push('健康检查未通过，请运行 codex-compat doctor 排查');
  }

  const ok = !!health && (!mappingResult || mappingResult.ok !== false);
  return {
    ok,
    code: ok ? 'installed' : 'installed-with-warnings',
    lines: lines.concat([''], actions, verboseLines(), ['', ok ? '安装完成，重启 Codex 后生效。' : '安装完成但存在告警，请运行 codex-compat doctor。']),
    message: ok ? '安装完成' : '安装完成但存在告警',
    manifest,
    health,
    mapping: mappingResult,
    service: serviceResult,
    guard: guardResult,
  };
}

module.exports = { install, waitForHealth, parseUpstreamOption };
