#!/usr/bin/env node
// 巡检：体检结果为异常时写日志并按需弹系统通知。
//
//   node scripts/watch.cjs            # 巡检并弹窗
//   node scripts/watch.cjs --quiet    # 只写日志
//   node scripts/watch.cjs --no-popup # 不弹窗
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config.cjs');
const platform = require('../src/platform.cjs');

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const NO_POPUP = argv.includes('--no-popup');
const homeIndex = argv.indexOf('--home');
const HOME = homeIndex >= 0 ? argv[homeIndex + 1] : config.compatHome();

// 中文注释：巡检主流程
async function main() {
  const doctor = await require('../src/commands/doctor.cjs').doctor({ home: HOME });
  const failed = doctor.checks.filter((item) => !item.ok);
  const P = config.paths(HOME);
  try {
    fs.mkdirSync(P.logs, { recursive: true });
    fs.appendFileSync(path.join(P.logs, 'watch.jsonl'), JSON.stringify({
      ts: new Date().toISOString(),
      platform: process.platform,
      ok: doctor.ok,
      problems: failed.map((item) => item.name + '：' + item.detail),
    }) + '\n');
  } catch (err) {
    // 中文注释：日志失败忽略
  }
  if (!QUIET) {
    process.stdout.write(doctor.lines.join('\n') + '\n');
  }
  if (!doctor.ok && !NO_POPUP) {
    platform.notify('codex-compat 异常', failed.map((item) => item.name).join('；') + '。运行 codex-compat doctor --fix 修复。');
  }
  process.exit(doctor.ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write('[watch] ' + String(err && err.message || err) + '\n');
  process.exit(1);
});
