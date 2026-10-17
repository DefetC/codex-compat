#!/usr/bin/env node
// 兼容旧入口：等价于 codex-compat pause / start。
//
//   node scripts/stop-intentional.cjs            暂停（保留自启）
//   node scripts/stop-intentional.cjs --status   查看暂停状态
//   node scripts/stop-intentional.cjs --resume   恢复
const fs = require('node:fs');
const config = require('../src/config.cjs');
const { run } = require('../src/commands/index.cjs');

const argv = process.argv.slice(2);
const home = (() => {
  const index = argv.indexOf('--home');
  return index >= 0 ? argv[index + 1] : undefined;
})();
const cfg = config.loadSafe({ home }).cfg;
const flag = config.paths(cfg.home).intentionalStopFlag;

if (argv.includes('--status')) {
  process.stdout.write('有意停止标记：' + (fs.existsSync(flag) ? '存在' : '不存在') + '\n');
  process.stdout.write('标记文件：' + flag + '\n');
  process.exitCode = 0;
} else if (argv.includes('--resume')) {
  run(['start', '--home', cfg.home]).then((code) => {
    process.exitCode = code;
  });
} else {
  run(['pause', '--home', cfg.home]).then((code) => {
    process.exitCode = code;
  });
}
