#!/usr/bin/env node
// 兼容旧入口：node scripts/install.cjs 等价于 codex-compat install。
const { run } = require('../src/commands/index.cjs');

run(['install'].concat(process.argv.slice(2))).then((code) => {
  process.exitCode = code;
});
