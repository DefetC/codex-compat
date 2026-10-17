// 交互式菜单 v2：分组结构 + 集中功能开关 + 实例（多开/实验）管理。
//
// 设计原则：菜单只是 CLI 命令层的外壳，不新增任何业务逻辑分支。
const readline = require('node:readline');
const config = require('./config.cjs');
const platform = require('./platform.cjs');
const mappings = require('./mappings.cjs');
const locale = require('./locale.cjs');
const commands = require('./commands/index.cjs');

// 中文注释：语言选择；优先环境变量，其次配置里的持久值
const LANG = locale.resolve(config.loadSafe().cfg.runtime.lang);

// 中文注释：菜单文案
const STRINGS = {
  zh: {
    title: 'codex-compat 菜单',
    status: '状态与体检', power: '启动 / 暂停 / 重启', install: '安装 / 修复主实例',
    instances: '实验实例（多开 / 临时 Codex）', switches: '功能开关',
    settings: '设置', tools: '工具', danger: '危险操作', exit: '退出',
    wizard: '① 先建实验实例试跑 → ② 验证 OK 再接入主配置',
    directInstall: '跳过试跑，直接安装主配置',
    back: '返回上一级', choose: '请选择', input: '请输入', bye: '已退出',
    pressEnter: '按回车返回', cancelled: '已取消', done: '完成',
    notInstalled: '主实例尚未安装',
    logs: '查看日志', doctor: '体检与修复', bundle: '生成诊断包', selftest: '离线自检',
    version: '版本', help: '帮助',
    bypass: '应急旁路（base_url 指回原上游）', restore: '按清单还原配置',
    uninstall: '卸载（可选删除运行目录）', cleanup: '清理旧命名计划任务',
    port: '监听端口', upstream: '上游地址', lang: '菜单语言', autostart: '自启与守护',
    verboseDefault: '诊断输出（verbose）默认值', trace: '诊断追踪 trace',
    promptSwitch: 'DeepSeek 提示词优化', rolesSwitch: 'DeepSeek 子代理角色',
    catalogSwitch: '无 catalog 时托管 provider 模型目录', guardSwitch: '纯官方保护',
    catalogOffUnsupported: '关（当前 Codex 不支持）', catalogOnNoEffect: '开（实测无效果）',
    catalogNotice: [
      'provider 级模型目录托管：当前 Codex 尚不支持，本项目只把它作为未来可能的技术路线保留。',
      '  · 它想解决的问题：既没有全局模型目录、上游又不返回原生目录时，由本工具现造一份目录交给 Codex。',
      '  · 实测（Codex 0.160.1）：CLI 不会拉取 provider 级 model_catalog_url——codex debug models 返回 {"models":[]}，',
      '    本工具 /__compat/catalog 的请求数为 0；codex features list 显示 api_key_model_discovery 仍是 under development、',
      '    remote_models 已 removed。',
      '  · 结论：打开它目前不会产生任何效果。提示词送达请用默认方式——lab 实例用顶层 model_instructions_file，',
      '    主实例走环境里已有的模型目录。',
    ].join('\n'),
    catalogConfirm: '仍要打开这个开关吗（仅供将来 Codex 支持后验证）？',
    catalogEnabledNoEffect: '已打开。请注意：当前 Codex 不会拉取该目录，此项暂时不会生效。',
    reclaimSwitch: '配置漂移自动抢回', bindings: '模型绑定与模糊匹配（查看）',
    templateRefreshSwitch: '模板自动刷新（第一跳）', refreshTemplates: '刷新模板与提示词（第一跳）',
    instCreate: '新建实例（向导）', instList: '实例列表', instStart: '启动实例',
    instStop: '停止实例', instEnv: '打印运行命令', instRun: '直接拉起临时 Codex CLI',
    instRefresh: '刷新实例模型目录', instUpdate: '把包内提示词刷新到实例', instRemove: '删除实例',
  },
  en: {
    title: 'codex-compat menu',
    status: 'Status & doctor', power: 'Start / pause / restart', install: 'Install / repair main instance',
    instances: 'Lab instances (multi-instance / temp Codex)', switches: 'Feature switches',
    settings: 'Settings', tools: 'Tools', danger: 'Danger zone', exit: 'Exit',
    wizard: '① Create a lab instance and try it → ② attach the main config',
    directInstall: 'Skip the trial and install the main config',
    back: 'Back', choose: 'Choose', input: 'Input', bye: 'bye',
    pressEnter: 'Press Enter to return', cancelled: 'Cancelled', done: 'Done',
    notInstalled: 'Main instance is not installed yet',
    logs: 'Logs', doctor: 'Doctor & repair', bundle: 'Diagnostic bundle', selftest: 'Offline selftest',
    version: 'Version', help: 'Help',
    bypass: 'Emergency bypass (base_url back to upstream)', restore: 'Restore from manifest',
    uninstall: 'Uninstall (optional purge)', cleanup: 'Remove legacy scheduled tasks',
    port: 'Listen port', upstream: 'Upstream', lang: 'Menu language', autostart: 'Autostart & guard',
    verboseDefault: 'Verbose diagnostics by default', trace: 'Diagnostic trace',
    promptSwitch: 'DeepSeek prompt optimization', rolesSwitch: 'DeepSeek subagent roles',
    catalogSwitch: 'Host provider model catalog when no global catalog', guardSwitch: 'Official-only protection',
    catalogOffUnsupported: 'off (unsupported by current Codex)', catalogOnNoEffect: 'on (no effect in practice)',
    catalogNotice: [
      'Provider model catalog hosting: not supported by Codex today; kept only as a possible future route.',
      '  · What it would solve: no global model catalog and a non-native upstream /models — the layer builds a catalog and hands it to Codex.',
      '  · Measured on Codex 0.160.1: the CLI never fetches a provider-level model_catalog_url — codex debug models returns {"models":[]},',
      '    the layer sees zero requests to /__compat/catalog, and codex features list shows api_key_model_discovery as under development',
      '    while remote_models is removed.',
      '  · Conclusion: enabling it changes nothing today. Prompt delivery uses the default paths — a lab instance via the top-level',
      '    model_instructions_file, the main instance via the model catalog already present in the environment.',
    ].join('\n'),
    catalogConfirm: 'Enable it anyway (only to re-test once Codex supports it)?',
    catalogEnabledNoEffect: 'Enabled. Note: Codex does not fetch that catalog today, so this switch has no effect yet.',
    reclaimSwitch: 'Reclaim drifted base_url', bindings: 'Model bindings & like matching (view)',
    templateRefreshSwitch: 'Auto-refresh templates (hop 1)', refreshTemplates: 'Refresh templates & prompts (hop 1)',
    instCreate: 'Create instance (wizard)', instList: 'List instances', instStart: 'Start instance',
    instStop: 'Stop instance', instEnv: 'Print run command', instRun: 'Launch temp Codex CLI',
    instRefresh: 'Refresh instance catalog', instUpdate: 'Refresh instance prompt from package', instRemove: 'Remove instance',
  },
};

// 中文注释：取文案并做占位替换
function t(key, ...args) {
  let text = (STRINGS[LANG] || STRINGS.en)[key] || key;
  args.forEach((value, index) => {
    text = text.replace('{' + (index + 1) + '}', String(value));
  });
  return text;
}

// 中文注释：整个菜单会话复用一个 readline 接口，并把行自己排队。
// readline 只在「有提问正在等待」时才投递行，管道/重定向输入会一次到达，
// 若不排队，第二个提问就会读到 EOF（表现为输到一半菜单直接退出）。
let sharedRl = null;
// 中文注释：已到达但还没被消费的输入行
const lineQueue = [];
// 中文注释：正在等待输入的回调队列
const lineWaiters = [];

// 中文注释：把排队的行交给等待者
function pumpLineQueue() {
  while (lineWaiters.length && lineQueue.length) {
    const resolve = lineWaiters.shift();
    resolve(lineQueue.shift());
  }
}

// 中文注释：获取（必要时创建）共享输入接口，并开始累积输入行
function inputInterface() {
  if (sharedRl) {
    return sharedRl;
  }
  sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  sharedRl.on('line', (line) => {
    lineQueue.push(String(line).trim());
    pumpLineQueue();
  });
  sharedRl.on('close', () => {
    sharedRl = null;
    // 中文注释：输入结束，用空串唤醒所有等待者，避免菜单卡死
    while (lineWaiters.length) {
      lineWaiters.shift()('');
    }
  });
  return sharedRl;
}

// 中文注释：读取一行（交互时等待输入，管道时按到达顺序消费）
function readLine(question) {
  inputInterface();
  process.stdout.write(question);
  if (lineQueue.length) {
    return Promise.resolve(lineQueue.shift());
  }
  return new Promise((resolve) => {
    lineWaiters.push(resolve);
  });
}

// 中文注释：单次提问（复用共享接口与行队列；输入结束返回空串）
function ask(question) {
  return readLine(question);
}

// 中文注释：输出命令结果
function print(result) {
  if (result && result.lines && result.lines.length) {
    process.stdout.write(result.lines.join('\n') + '\n');
  } else if (result && result.message) {
    process.stdout.write(result.message + '\n');
  }
}

// 中文注释：带编号的选择；0 表示返回
async function pick(title, items) {
  process.stdout.write('\n' + title + '\n');
  items.forEach((item, index) => {
    process.stdout.write('  ' + (index + 1) + ') ' + item.label + '\n');
  });
  process.stdout.write('  0) ' + t('back') + '\n');
  const answer = await ask(t('choose') + ': ');
  const index = Number(answer);
  if (!index || index < 1 || index > items.length) {
    return null;
  }
  return items[index - 1];
}

// 中文注释：等待回车
async function pauseForUser() {
  await ask('\n' + t('pressEnter') + ' ');
}

// 中文注释：执行命令并打印结果
async function runCommand(fn, options = {}) {
  print(await fn(options));
  await pauseForUser();
}

// 中文注释：执行 CLI 命令并打印结果（与菜单共用命令层）
async function runCli(args) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return true;
  };
  let code = 1;
  try {
    code = await commands.run(args);
  } finally {
    process.stdout.write = original;
  }
  const text = chunks.join('');
  if (text.trim()) {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  }
  return code;
}

// 中文注释：统计确实在运行的实验实例数；按健康签名判定，端口被别的程序占用不算
async function countRunningInstances(list) {
  const results = await Promise.all(list.map(async (item) => {
    try {
      const probe = await require('./ports.cjs').probeCompat('127.0.0.1', Number(item.listenPort), 600);
      return !!(probe && probe.ours && probe.data && probe.data.instance === item.name);
    } catch (err) {
      // 中文注释：探测异常一律按未运行处理，不能因为实例探测失败影响主菜单渲染
      return false;
    }
  }));
  return results.filter(Boolean).length;
}

// 中文注释：状态面板
async function header() {
  const result = await require('./commands/service.cjs').status({});
  process.stdout.write('\n' + result.lines.slice(0, 11).join('\n') + '\n');
  let count = 0;
  let running = 0;
  try {
    const list = require('./instances.cjs').listInstances();
    count = list.length;
    running = await countRunningInstances(list);
  } catch (err) {
    count = 0;
    running = 0;
  }
  process.stdout.write('  实验实例       : ' + count + ' 个（运行中 ' + running + '）\n');
  return result;
}

// 中文注释：安装/修复
async function runInstall() {
  print(await require('./commands/install.cjs').install({ interactive: true }));
  await pauseForUser();
}

// 中文注释：功能开关面板
async function switchesMenu() {
  for (;;) {
    const cfg = config.loadSafe().cfg;
    const choice = await pick('== ' + t('switches') + ' ==', [
      { key: 'prompt', label: t('promptSwitch') + '：' + (cfg.features.deepseekPrompt ? '开' : '关') },
      { key: 'roles', label: t('rolesSwitch') + '：' + (cfg.features.deepseekRoles ? '开' : '关') },
      {
        key: 'catalog',
        label: t('catalogSwitch') + '：'
          + (cfg.features.providerCatalog ? t('catalogOnNoEffect') : t('catalogOffUnsupported')),
      },
      { key: 'guard', label: t('guardSwitch') + '：' + (cfg.features.officialGuard ? '开' : '关') },
      { key: 'reclaim', label: t('reclaimSwitch') + '：' + cfg.service.reclaim },
      { key: 'templateRefresh', label: t('templateRefreshSwitch') + '：' + cfg.service.templateRefresh },
      { key: 'bindings', label: t('bindings') },
      { key: 'verbose', label: t('verboseDefault') + '：' + (cfg.runtime.verbose ? '开' : '关') },
    ]);
    if (!choice) {
      return;
    }
    const toggle = {
      prompt: 'features.deepseekPrompt',
      roles: 'features.deepseekRoles',
      guard: 'features.officialGuard',
      verbose: 'runtime.verbose',
    }[choice.key];
    // 中文注释：provider 级目录托管目前不被 Codex 支持，选择时必须讲清事实并二次确认
    if (choice.key === 'catalog') {
      process.stdout.write('\n' + t('catalogNotice') + '\n');
      const yes = await ask(t('catalogConfirm') + ' [y/N] ');
      if (/^y(es)?$/i.test(yes)) {
        await runCli(['config', 'set', 'features.providerCatalog', 'true']);
        process.stdout.write(t('catalogEnabledNoEffect') + '\n');
      } else {
        process.stdout.write(t('cancelled') + '\n');
      }
      continue;
    }
    if (toggle) {
      await runCli(['config', 'set', toggle, cfg.features[choice.key] !== undefined && cfg.features[choice.key] ? 'false' : (choice.key === 'verbose' ? (cfg.runtime.verbose ? 'false' : 'true') : 'true')]);
    } else if (choice.key === 'reclaim') {
      const value = await ask('auto / notify-only / off（当前 ' + cfg.service.reclaim + '）: ');
      if (config.DRIFT_POLICIES.includes(value)) {
        await runCli(['config', 'set', 'service.reclaim', value]);
      }
    } else if (choice.key === 'templateRefresh') {
      const value = await ask('auto / notify-only / off（当前 ' + cfg.service.templateRefresh + '）: ');
      if (config.DRIFT_POLICIES.includes(value)) {
        await runCli(['config', 'set', 'service.templateRefresh', value]);
      }
    } else if (choice.key === 'bindings') {
      try {
        const bindings = mappings.readBindings({ mappingFile: config.paths(cfg.home).mappingFile }).bindings;
        process.stdout.write('\n' + JSON.stringify(bindings, null, 2) + '\n');
      } catch (err) {
        process.stdout.write('读取映射失败：' + String(err && err.message || err) + '\n');
      }
      await pauseForUser();
    }
    process.stdout.write(t('done') + '\n');
  }
}

// 中文注释：设置面板
async function settingsMenu() {
  for (;;) {
    const cfg = config.loadSafe().cfg;
    const choice = await pick('== ' + t('settings') + ' ==', [
      { key: 'port', label: t('port') + '：' + cfg.listen.port },
      { key: 'upstream', label: t('upstream') + '：' + cfg.upstream.host + ':' + cfg.upstream.port + (cfg.upstream.basePath || '') },
      { key: 'autostart', label: t('autostart') + '：' + (cfg.service.autoStart ? '开' : '关') },
      { key: 'lang', label: t('lang') + '：' + cfg.runtime.lang },
      { key: 'trace', label: t('trace') + '：' + (cfg.runtime.trace ? '开' : '关') },
    ]);
    if (!choice) {
      return;
    }
    if (choice.key === 'port') {
      const value = await ask(t('input') + ' port [' + cfg.listen.port + ']: ');
      if (value) {
        await runCli(['config', 'set', 'listen.port', value]);
        const repair = await ask('立即执行 repair 以应用端口？[y/N] ');
        if (/^y(es)?$/i.test(repair)) {
          await runInstall();
        }
      }
    } else if (choice.key === 'upstream') {
      const value = await ask(t('input') + ' upstream [' + cfg.upstream.host + ':' + cfg.upstream.port + ']: ');
      const match = /^([^:]+):(\d+)$/.exec(value || '');
      if (match) {
        await runCli(['config', 'set', 'upstream.host', match[1]]);
        await runCli(['config', 'set', 'upstream.port', match[2]]);
        const repair = await ask('立即执行 repair 以应用上游？[y/N] ');
        if (/^y(es)?$/i.test(repair)) {
          await runInstall();
        }
      }
    } else if (choice.key === 'autostart') {
      await runCli(['config', 'set', 'service.autoStart', cfg.service.autoStart ? 'false' : 'true']);
    } else if (choice.key === 'lang') {
      const value = await ask('auto / zh / en（当前 ' + cfg.runtime.lang + '）: ');
      if (['auto', 'zh', 'en'].includes(value)) {
        await runCli(['config', 'set', 'runtime.lang', value]);
        process.stdout.write('语言将在下次进入菜单时生效\n');
      }
    } else if (choice.key === 'trace') {
      await runCli(['config', 'set', 'runtime.trace', cfg.runtime.trace ? 'false' : 'true']);
    }
  }
}

// 中文注释：工具面板
async function toolsMenu() {
  for (;;) {
    const choice = await pick('== ' + t('tools') + ' ==', [
      { key: 'logs', label: t('logs') },
      { key: 'doctor', label: t('doctor') },
      { key: 'templates', label: t('refreshTemplates') },
      { key: 'bundle', label: t('bundle') },
      { key: 'selftest', label: t('selftest') },
      { key: 'version', label: t('version') },
      { key: 'help', label: t('help') },
    ]);
    if (!choice) {
      return;
    }
    if (choice.key === 'logs') {
      await runCommand(require('./commands/logs.cjs').logs, { lines: 40 });
    } else if (choice.key === 'templates') {
      const force = await ask('是否用包内版本覆盖本地改过的模板？[y/N] ');
      await runCommand(require('./commands/templates.cjs').refresh, { force: /^y(es)?$/i.test(force) });
    } else if (choice.key === 'doctor') {
      const fix = await ask('自动修复配置类问题？[y/N] ');
      await runCommand(require('./commands/doctor.cjs').doctor, { fix: /^y(es)?$/i.test(fix) });
    } else if (choice.key === 'bundle') {
      await runCommand(require('./commands/diagnostic.cjs').bundle);
    } else if (choice.key === 'selftest') {
      await runCommand(require('./commands/selftest.cjs').selftest);
    } else if (choice.key === 'version') {
      await runCommand(require('./commands/version.cjs').version);
    } else {
      await runCommand(require('./commands/version.cjs').help);
    }
  }
}

// 中文注释：危险操作面板
async function dangerMenu() {
  for (;;) {
    const choice = await pick('== ' + t('danger') + ' ==', [
      { key: 'bypass', label: t('bypass') },
      { key: 'restore', label: t('restore') },
      { key: 'uninstall', label: t('uninstall') },
      { key: 'cleanup', label: t('cleanup') },
    ]);
    if (!choice) {
      return;
    }
    if (choice.key === 'bypass') {
      await runCommand(require('./commands/restore.cjs').bypass);
    } else if (choice.key === 'restore') {
      const yes = await ask('确认还原 Codex 配置？[y/N] ');
      if (/^y(es)?$/i.test(yes)) {
        await runCommand(require('./commands/restore.cjs').restore);
      }
    } else if (choice.key === 'uninstall') {
      const yes = await ask('确认卸载（含还原配置）？[y/N] ');
      if (/^y(es)?$/i.test(yes)) {
        const purge = await ask('同时删除运行目录？[y/N] ');
        await runCommand(require('./commands/restore.cjs').uninstall, { purge: /^y(es)?$/i.test(purge) });
      }
    } else {
      const yes = await ask('确认清理旧命名计划任务（CodexCompatLayer/Guard/Watch）？[y/N] ');
      if (/^y(es)?$/i.test(yes)) {
        await runCommand(require('./commands/install.cjs').install, { yes: true, interactive: false, cleanupLegacy: true });
      }
    }
  }
}

// 中文注释：实例创建向导
async function createInstanceWizard() {
  const name = await ask('实例名称（如 lab-cpa）: ');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) {
    process.stdout.write('名称不合法：只允许字母数字与 -_，且以字母数字开头\n');
    return;
  }
  const providerChoice = await pick('选择上游：', [
    { key: 'cc-switch', label: 'CC Switch 本地代理（127.0.0.1:15721）' },
    { key: 'cpa', label: 'CPA 网关（127.0.0.1:8317）' },
    { key: 'custom', label: '自定义 OpenAI 兼容地址' },
  ]);
  if (!providerChoice) {
    return;
  }
  let provider = 'cc-switch';
  if (providerChoice.key === 'cpa') {
    provider = 'http://127.0.0.1:8317/v1';
  } else if (providerChoice.key === 'custom') {
    provider = await ask('上游 URL（含 /v1 路径）: ');
    if (!provider) {
      return;
    }
  }
  const args = ['instance', 'create', name, '--provider', provider];
  if (providerChoice.key !== 'cc-switch') {
    const keyMode = await pick('密钥方式：', [
      { key: 'value', label: '现在输入 key（保存到实例目录，输出掩码）' },
      { key: 'env', label: '使用已有环境变量（不落盘）' },
    ]);
    if (!keyMode) {
      return;
    }
    if (keyMode.key === 'value') {
      const key = await ask('API Key: ');
      if (!key) {
        return;
      }
      args.push('--key', key);
    } else {
      const varName = await ask('环境变量名 [CODEX_COMPAT_LAB_KEY]: ');
      args.push('--key-env', varName || 'CODEX_COMPAT_LAB_KEY');
    }
  }
  const model = await ask('模型 id（留空则先列出上游候选）: ');
  if (model) {
    args.push('--model', model);
  }
  const autostart = await ask('是否登录自启该实例？[y/N] ');
  if (/^y(es)?$/i.test(autostart)) {
    args.push('--autostart');
  }
  process.stdout.write('\n将执行：codex-compat ' + args.join(' ') + '\n');
  const ok = await ask('确认创建？[y/N] ');
  if (!/^y(es)?$/i.test(ok)) {
    return;
  }
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    await commands.run(args);
  } finally {
    process.stdout.write = original;
  }
  process.stdout.write(chunks.join(''));
  await pauseForUser();
}

// 中文注释：实例面板
async function instancesMenu() {
  for (;;) {
    const choice = await pick('== ' + t('instances') + ' ==', [
      { key: 'create', label: t('instCreate') },
      { key: 'list', label: t('instList') },
      { key: 'start', label: t('instStart') },
      { key: 'stop', label: t('instStop') },
      { key: 'env', label: t('instEnv') },
      { key: 'run', label: t('instRun') },
      { key: 'refresh', label: t('instRefresh') },
      { key: 'update', label: t('instUpdate') },
      { key: 'remove', label: t('instRemove') },
    ]);
    if (!choice) {
      return;
    }
    if (choice.key === 'create') {
      await createInstanceWizard();
      continue;
    }
    if (choice.key === 'list') {
      await runCli(['instance', 'list']);
      await pauseForUser();
      continue;
    }
    const name = await ask(choice.key === 'update' ? '实例名称（留空 = 全部实例）: ' : '实例名称: ');
    if (!name && choice.key !== 'update') {
      continue;
    }
    if (choice.key === 'remove') {
      const yes = await ask('确认删除实例 ' + name + '（含其临时 Codex 配置）？[y/N] ');
      if (!/^y(es)?$/i.test(yes)) {
        continue;
      }
    }
    await runCli(choice.key === 'update' && !name ? ['instance', 'update'] : ['instance', choice.key, name]);
    await pauseForUser();
  }
}

// 中文注释：未安装时的向导
async function onboardingWizard() {
  const choice = await pick('== 首次接入 ==', [
    { key: 'lab', label: t('wizard') },
    { key: 'install', label: t('directInstall') },
  ]);
  if (!choice) {
    return;
  }
  if (choice.key === 'lab') {
    await createInstanceWizard();
    process.stdout.write('验证满意后，回到主菜单选择「安装 / 修复主实例」即可接入主配置。\n');
    await pauseForUser();
  } else {
    await runInstall();
  }
}

// 中文注释：主循环
async function main() {
  // 中文注释：先把输入接口建起来开始累积输入行。
  // 菜单渲染状态面板要花几秒，若等到第一次提问才建接口，
  // 管道/重定向输入会在这几秒内到达并被丢弃（表现为菜单刚显示就退出）。
  inputInterface();
  process.stdout.write(t('title') + ' v' + config.version() + '\n');
  for (;;) {
    let installed = false;
    try {
      const paths = config.paths(config.loadSafe().cfg.home);
      const manifest = require('./manifest.cjs').read(paths.manifestFile);
      installed = !!(manifest && manifest.installed);
    } catch (err) {
      installed = false;
    }
    await header();
    if (!installed) {
      process.stdout.write('  ' + t('notInstalled') + '\n');
    }
    const items = [];
    if (!installed) {
      items.push({ key: 'onboarding', label: t('wizard') });
    }
    items.push(
      { key: 'status', label: t('status') },
      { key: 'power', label: t('power') },
    );
    if (installed) {
      items.push({ key: 'install', label: t('install') });
    } else {
      items.push({ key: 'install', label: t('directInstall') });
    }
    items.push(
      { key: 'instances', label: t('instances') },
      { key: 'switches', label: t('switches') },
      { key: 'settings', label: t('settings') },
      { key: 'tools', label: t('tools') },
      { key: 'danger', label: t('danger') },
    );

    const choice = await pick('== ' + t('title') + ' ==', items);
    if (!choice) {
      process.stdout.write(t('bye') + '\n');
      return;
    }
    if (choice.key === 'onboarding') {
      await onboardingWizard();
    } else if (choice.key === 'status') {
      const fix = await ask('执行体检并自动修复配置类问题？[y/N] ');
      await runCommand(require('./commands/doctor.cjs').doctor, { fix: /^y(es)?$/i.test(fix) });
    } else if (choice.key === 'power') {
      const action = await pick('== ' + t('power') + ' ==', [
        { key: 'start', label: '启动 / 恢复' },
        { key: 'pause', label: '临时暂停（保留自启）' },
        { key: 'restart', label: '重启' },
        { key: 'stop', label: '完全停止（取消自启）' },
      ]);
      if (action) {
        await runCommand(require('./commands/service.cjs')[action.key]);
      }
    } else if (choice.key === 'install') {
      await runInstall();
    } else if (choice.key === 'instances') {
      await instancesMenu();
    } else if (choice.key === 'switches') {
      await switchesMenu();
    } else if (choice.key === 'settings') {
      await settingsMenu();
    } else if (choice.key === 'tools') {
      await toolsMenu();
    } else if (choice.key === 'danger') {
      await dangerMenu();
    }
  }
}

module.exports = { main, t, LANG };
