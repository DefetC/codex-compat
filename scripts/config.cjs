#!/usr/bin/env node
// 兼容旧入口：node scripts/config.cjs <list|get|set|apply|check|rollback>。
//
// apply/check/rollback 保留为映射引擎直连，其余转发到 config 命令。
const { run } = require('../src/commands/index.cjs');

const action = process.argv[2];
if (['apply', 'check', 'rollback'].includes(action)) {
  const mappings = require('../src/mappings.cjs');
  const opts = { dryRun: action === 'check' };
  const rest = process.argv.slice(3);
  if (action === 'rollback') {
    opts.changeId = rest[0];
  }
  try {
    const result = action === 'rollback' ? mappings.rollback(opts) : mappings.apply(opts);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = (result.ok && !(action === 'check' && result.changed)) ? 0 : 1;
  } catch (err) {
    process.stderr.write('[config] ' + String(err && err.message || err) + '\n');
    process.exitCode = 1;
  }
} else {
  run(['config'].concat(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
}
