#!/usr/bin/env node
// 兼容旧入口：node scripts/service.cjs <status|start|stop|restart|logs>。
const { run } = require('../src/commands/index.cjs');

const arg = process.argv[2] || 'status';
const map = { status: 'status', start: 'start', stop: 'stop', restart: 'restart', logs: 'logs', pause: 'pause' };
const command = map[arg];
if (!command) {
  process.stderr.write('用法：node scripts/service.cjs [status|start|pause|stop|restart|logs]\n');
  process.exit(1);
}
run([command].concat(process.argv.slice(3))).then((code) => {
  process.exitCode = code;
});
