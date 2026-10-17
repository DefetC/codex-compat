// 命令分发：菜单与 CLI 共用同一层实现，统一 JSON 输出与退出码。
const args = require('../args.cjs');

// 中文注释：命令实现表，按需加载避免无谓依赖
const COMMANDS = {
  install: () => require('./install.cjs').install,
  repair: () => require('./install.cjs').install,
  start: () => require('./service.cjs').start,
  pause: () => require('./service.cjs').pause,
  stop: () => require('./service.cjs').stop,
  restart: () => require('./service.cjs').restart,
  status: () => require('./service.cjs').status,
  doctor: () => require('./doctor.cjs').doctor,
  logs: () => require('./logs.cjs').logs,
  config: () => require('./settings.cjs').config,
  settings: () => require('./settings.cjs').config,
  templates: () => require('./templates.cjs').refresh,
  bypass: () => require('./restore.cjs').bypass,
  restore: () => require('./restore.cjs').restore,
  uninstall: () => require('./restore.cjs').uninstall,
  selftest: () => require('./selftest.cjs').selftest,
  bundle: () => require('./diagnostic.cjs').bundle,
  diagnose: () => require('./diagnostic.cjs').bundle,
  instance: () => require('./instance.cjs').instance,
  lab: () => require('./instance.cjs').instance,
  version: () => require('./version.cjs').version,
  help: () => require('./version.cjs').help,
};

// 中文注释：统一输出；--json 时只输出 JSON
function emit(result, opts) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (result && result.lines && result.lines.length) {
    process.stdout.write(result.lines.join('\n') + '\n');
  } else if (result && result.message) {
    process.stdout.write(result.message + '\n');
  }
}

// 中文注释：分发入口；返回进程退出码
async function run(argv) {
  const opts = args.parse(argv);
  // 中文注释：未显式传 --verbose 时，沿用配置里的持久默认值（--no-verbose 可显式关闭）
  if (opts.verbose === undefined) {
    try {
      opts.verbose = require('../config.cjs').loadSafe({ home: opts.home }).cfg.runtime.verbose === true;
    } catch (err) {
      opts.verbose = false;
    }
  }
  const name = opts._[0] || 'help';
  const factory = COMMANDS[name];
  if (!factory) {
    process.stderr.write('未知命令：' + name + '（可用：' + Object.keys(COMMANDS).join(' / ') + '）\n');
    return 1;
  }
  try {
    const result = await factory()(opts);
    emit(result, opts);
    return result && result.ok === false ? 1 : 0;
  } catch (err) {
    const message = String(err && err.message || err);
    const result = { ok: false, code: 'exception', message };
    // 中文注释：--verbose 时附带完整堆栈，便于排查与提 issue
    if (opts.verbose && err && err.stack) {
      result.stack = String(err.stack);
    }
    emit(result, opts);
    if (!opts.json) {
      process.stderr.write('[codex-compat] ' + message + '\n');
      if (opts.verbose && err && err.stack) {
        process.stderr.write(String(err.stack) + '\n');
      }
    }
    return 1;
  }
}

module.exports = { run, COMMANDS };
