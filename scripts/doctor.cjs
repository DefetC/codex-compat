#!/usr/bin/env node
// 兼容旧入口：node scripts/doctor.cjs 等价于 codex-compat doctor。
const { run } = require('../src/commands/index.cjs');

run(['doctor'].concat(process.argv.slice(2))).then((code) => {
  process.exitCode = code;
});
