// 体检与修复：复用预检，并补充运行态、日志与残留检查。
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config.cjs');

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
const platform = require('../platform.cjs');
const preflight = require('../preflight.cjs');
const ports = require('../ports.cjs');
const manifestLib = require('../manifest.cjs');
const codexconfig = require('../codexconfig.cjs');
const mappings = require('../mappings.cjs');

// 中文注释：统计最近事件日志中的异常条数
function scanLogs(logDir) {
  if (!fs.existsSync(logDir)) {
    return { files: 0, bad: 0, latest: null };
  }
  const files = fs.readdirSync(logDir).filter((name) => name.startsWith('compat-') && name.endsWith('.jsonl')).sort();
  if (!files.length) {
    return { files: 0, bad: 0, latest: null };
  }
  const latest = path.join(logDir, files[files.length - 1]);
  const badEvents = ['reject', 'upstream_error', 'parse_error', 'decode_error', 'uncaught', 'listen_error'];
  let bad = 0;
  // 中文注释：只看尾部窗口，避免历史噪声（例如客户端中断）长期误报
  const lines = fs.readFileSync(latest, 'utf8').split('\n').filter(Boolean).slice(-500);
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      // 新兼容错误按级别识别，旧事件名仍保持兼容，避免新增错误被误报为日志正常。
      if (event.level === 'error' || badEvents.includes(event.event) || (event.event === 'rewrite' && event.rejected === true)) {
        bad++;
      }
    } catch (err) {
      // 中文注释：忽略无法解析的行
    }
  }
  return { files: files.length, bad, latest };
}

// 中文注释：执行体检；--fix 时自动修复配置类问题
async function doctor(opts = {}) {
  const checks = [];
  // 中文注释：soft=true 表示「提示项」：不影响总体结论，避免把无害的历史残留当成故障
  const add = (name, ok, detail, hint, soft = false) => checks.push({ name, ok, detail: detail || '', hint: hint || '', soft });
  const pf = await preflight.run({ home: opts.home });
  for (const item of pf.checks) {
    if (item.id === 'codex-version') {
      // 中文注释：版本项只作展示，不判失败；与实测基线不一致时提示可回退的具体版本
      const codexVersionModule = require('../codex-version.cjs');
      const detected = codexVersionModule.detect();
      const baseline = codexVersionModule.VERIFIED_BASELINE;
      let detail;
      if (!detected.ok) {
        detail = (item.detail || '未能探测 Codex 版本') + '（本工具实测基线 ' + baseline + '）';
      } else if (detected.raw === baseline) {
        detail = 'Codex ' + detected.raw + '（本工具实测基线）';
      } else {
        detail = 'Codex ' + detected.raw + '（本工具实测基线 ' + baseline + '；如遇异常可回退该版本）';
      }
      add(item.id, true, detail, '');
      continue;
    }
    add(item.id, item.ok, item.detail, item.hint);
  }

  const cfg = pf.cfg;
  const paths = config.paths(cfg.home);
  const probe = await ports.probeCompat(cfg.listen.host, cfg.listen.port);
  // 中文注释：端口上确实是 codex-compat，还要确认它属于同一个运行目录；
  // 否则「健康」是别人的实例，会掩盖当前运行目录其实没起来的事实
  const healthHome = (probe.data && probe.data.home) || null;
  const sameHome = !!(probe.ours && healthHome && samePath(healthHome, cfg.home));
  if (sameHome) {
    add('health', true, '健康检查通过（v' + (probe.data.version || '?') + '，运行目录 ' + healthHome + '）', '');
  } else if (probe.ours && !healthHome) {
    add('health', true, '健康检查通过（v' + (probe.data.version || '?') + '，对端未上报运行目录）',
      '对端可能是更早的版本；如需严格核对，请重启那个实例', true);
  } else if (probe.ours) {
    add('health', false,
      '端口 ' + cfg.listen.port + ' 上是另一个 codex-compat 实例（运行目录 ' + healthHome + '）',
      '换一个监听端口（--port），或先停止那个实例');
  } else {
    add('health', false, '端口 ' + cfg.listen.port + ' 无兼容层响应',
      '运行 codex-compat start 或 codex-compat install');
  }

  const service = platform.serviceStatus();
  // 中文注释：计划任务启动的 wscript 会立刻退出，任务状态通常停在 Ready；
  // 因此这里只校验「已注册」，实际存活由 health 检查负责。
  add('service', service.installed, service.detail, service.installed ? '' : '运行 codex-compat start');
  const guard = platform.guardStatus();
  add('guard', guard.installed, guard.detail, guard.installed ? '' : '运行 codex-compat start');

  const logs = scanLogs(paths.logs);
  add('logs', logs.bad === 0, logs.latest ? (path.basename(logs.latest) + '，异常事件 ' + logs.bad + ' 条') : '暂无事件日志',
    logs.bad > 0 ? '查看 codex-compat logs 或开启 trace 排查' : '');

  let mappingOk = true;
  let mappingDetail = '未配置映射';
  try {
    const userMapping = fs.existsSync(paths.mappingFile) ? paths.mappingFile : null;
    const result = mappings.apply({ home: platform.codexHome(), mappingFile: userMapping || undefined, dryRun: true });
    mappingOk = result.ok;
    mappingDetail = '待同步项 ' + (result.changed ? '有' : '无') + '；告警 ' + (result.warnings ? result.warnings.length : 0) + ' 条';
  } catch (err) {
    mappingOk = false;
    mappingDetail = String(err && err.message || err);
  }
  add('mappings', mappingOk, mappingDetail, mappingOk ? '' : '运行 codex-compat repair');

  // 中文注释：第一跳自检：运行目录里的模板/提示词与包内是否一致（seed 只在首次安装落位，之后不会自动跟上）
  let templateOk = true;
  let templateDetail = '未检查';
  try {
    const templatesLib = require('../templates.cjs');
    const probe = templatesLib.sync({ home: paths.home, dryRun: true, pkgVersion: config.version() });
    templateOk = !templatesLib.drifted(probe);
    templateDetail = templatesLib.describe(probe);
  } catch (err) {
    templateOk = false;
    templateDetail = String(err && err.message || err);
  }
  add('templates', templateOk, templateDetail, templateOk ? '' : '运行 codex-compat templates 查看并刷新');

  // 中文注释：官方保护自检：列出本工具实际管理的模型，出现官方命名即判失败
  let managed = [];
  let managedDetail = '当前没有需要管理的模型';
  try {
    const mappingFile = fs.existsSync(paths.mappingFile) ? paths.mappingFile : undefined;
    const bindings = mappings.readBindings({ mappingFile }).bindings;
    const catalogFile = mappings.options({ home: platform.codexHome() }).catalogFile;
    if (fs.existsSync(catalogFile)) {
      const catalogModels = JSON.parse(fs.readFileSync(catalogFile, 'utf8')).models || [];
      const claimed = new Set();
      for (const binding of bindings) {
        if (binding.enabled === false) {
          continue;
        }
        const target = mappings.resolveTarget(binding, catalogModels, claimed);
        if (target.model) {
          claimed.add(target.model.slug);
          managed.push(target.model.slug);
        }
      }
      managedDetail = managed.length ? ('本工具管理的模型：' + managed.join(', ')) : '当前没有需要管理的模型';
    } else {
      managedDetail = '未找到模型目录，无法确认受管模型';
    }
  } catch (err) {
    managedDetail = '解析受管模型失败：' + String(err && err.message || err);
  }
  const officialOffenders = managed.filter((slug) => mappings.isOfficialSlug(slug));
  add('official-untouched', officialOffenders.length === 0,
    officialOffenders.length ? ('受管模型里出现官方命名：' + officialOffenders.join(', ')) : managedDetail,
    officialOffenders.length ? '检查 mappings.toml 的 model_id_like，官方模型不允许被管理' : '');

  // 中文注释：无全局目录时，提示词优化依赖 provider 目录托管
  if (pf.hasGlobalCatalog) {
    add('provider-catalog', true, '本地已有模型目录来源，按文件补丁方式管理，无需 provider 级托管');
  } else {
    let native = false;
    let probeError = null;
    try {
      const probed = await require('../catalog.cjs').probe(pf.upstream, null, 4000);
      native = !!(probed.ok && probed.native);
      probeError = probed.ok ? null : probed.error;
    } catch (err) {
      probeError = String(err && err.message || err);
    }
    if (native) {
      add('provider-catalog', true, '上游已提供 Codex 原生模型目录（含提示词字段），无需托管');
    } else {
      const on = cfg.features.providerCatalog === true;
      add('provider-catalog', on,
        on ? ('无全局模型目录：已启用 provider 目录托管' + (probeError ? '（上游探测失败：' + probeError + '）' : '')) : '无全局模型目录且 provider 目录托管已关闭，提示词优化不会生效',
        on ? '' : '在「功能开关」里打开“无 catalog 时托管 provider 目录”', !on);
    }
  }

  // 中文注释：检查旧版本遗留文件
  // 中文注释：按命名规律识别上一代状态文件，不写死任何具体旧名
  const legacy = require('../mappings.cjs').legacyStateFiles(platform.codexHome());
  add('legacy', legacy.length === 0, legacy.length ? '发现旧版状态文件：' + legacy.join(', ') : '无旧版残留',
    legacy.length ? '确认不再使用旧版后，可在 ~/.codex 下删除这些文件（不影响当前运行）' : '', true);

  // 中文注释：旧命名计划任务可能与上一代工具冲突，单独提示
  const legacyTaskList = platform.legacyTasks ? platform.legacyTasks() : [];
  add('legacy-tasks', legacyTaskList.length === 0,
    legacyTaskList.length ? '发现旧命名任务：' + legacyTaskList.map((item) => item.name).join(', ') : '无旧命名任务',
    legacyTaskList.length ? '确认不再需要上一代工具后，运行 codex-compat uninstall --cleanup-legacy 清理' : '');

  let fixed = null;
  if (!pf.ok && opts.fix) {
    fixed = await require('./install.cjs').install(Object.assign({}, opts, { yes: true, interactive: false }));
    add('auto-fix', fixed.ok, fixed.ok ? '已重新安装并修复' : '自动修复未完成', fixed.ok ? '' : '查看上面的异常项');
  }

  const failed = checks.filter((item) => !item.ok && !item.soft);
  const notices = checks.filter((item) => !item.ok && item.soft);
  const lines = ['codex-compat 体检报告', ''];
  for (const item of checks) {
    lines.push((item.ok ? '[通过] ' : (item.soft ? '[提示] ' : '[异常] ')) + item.name + '：' + item.detail);
    if (!item.ok && item.hint) {
      lines.push('       建议：' + item.hint);
    }
  }
  lines.push('');
  lines.push(failed.length === 0
    ? ('结论：全部检查通过。' + (notices.length ? '（另有 ' + notices.length + ' 条提示）' : ''))
    : '结论：' + failed.length + ' 项异常' + (opts.fix ? '（已尝试自动修复）' : '，可加 --fix 自动修复配置类问题'));

  // 中文注释：--verbose 追加原始探测信息，便于把问题贴给别人排查
  if (opts.verbose) {
    const d = pf.diagnostics || {};
    const attempts = (d.portSelection && d.portSelection.attempts) || [];
    lines.push('', '详细信息（--verbose）：');
    lines.push('  Codex 配置         : ' + (d.configPath || ''));
    lines.push('  运行目录           : ' + (d.compatHome || cfg.home));
    lines.push('  安装清单           : ' + (d.manifestFile || ''));
    lines.push('  映射文件           : ' + paths.mappingFile);
    lines.push('  日志目录           : ' + paths.logs);
    lines.push('  provider 识别      : ' + JSON.stringify(d.provider || null));
    lines.push('  端口选择           : 请求 ' + ((d.portSelection && d.portSelection.requested) || '') + ' → 选中 ' + ((d.portSelection && d.portSelection.port) || ''));
    lines.push('  端口尝试明细       : ' + (attempts.length
      ? attempts.map((item) => item.port + (item.ours ? '(本工具实例)' : '(被外部占用)')).join(', ')
      : '首选端口可直接使用，无冲突'));
    lines.push('  CC Switch 原始探测 : ' + JSON.stringify(d.ccswitch || null));
    lines.push('  解析出的上游       : ' + JSON.stringify(d.upstream || null));
    const commands = platform.recentCommandsSnapshot ? platform.recentCommandsSnapshot() : [];
    if (commands.length) {
      lines.push('  最近系统命令：');
      commands.slice(-6).forEach((item) => lines.push('    [' + item.label + '] ' + item.script));
    }
  }

  return { ok: failed.length === 0, code: failed.length ? 'doctor-failed' : 'doctor-passed', lines, checks, fixed, diagnostics: pf.diagnostics };
}

module.exports = { doctor, scanLogs };
