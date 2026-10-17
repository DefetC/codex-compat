#!/usr/bin/env node
// codex-compat 命令行入口：无参数进入菜单，带参数走脚本化命令。
const commands = require('../src/commands/index.cjs');
const menu = require('../src/menu.cjs');

// 中文注释：把未捕获异常转为明确失败，避免静默卡死
process.on('uncaughtException', (err) => {
  process.stderr.write('[codex-compat] ' + (err && err.stack || err) + '\n');
  process.exit(1);
});

const argv = process.argv.slice(2);

(async () => {
  if (argv.length === 0) {
    await menu.main();
    return;
  }
  process.exitCode = await commands.run(argv);
})();
