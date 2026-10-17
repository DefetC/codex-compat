#!/usr/bin/env node
// 兼容旧入口：node scripts/uninstall.cjs 等价于 codex-compat uninstall。
const { run } = require('../src/commands/index.cjs');

run(['uninstall'].concat(process.argv.slice(2))).then((code) => {
  process.exitCode = code;
});
