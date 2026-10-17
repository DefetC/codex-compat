// 兼容层回归测试驱动：依次跑五种 主控×子代理 组合，记录结果
//
// 路径约定：本文件位于 tests/，仓库根是上一级；产物写入 artifacts/regression/
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 中文注释：仓库根与产物目录
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'regression');

// 中文注释：Codex CLI 位置，可用环境变量覆盖以适配其它安装
const CODEX = process.env.CODEX_BIN
  || path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin', '9691020b546a15b2', 'codex.exe');

// 中文注释：子进程的 CODEX_HOME
const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex');

const cases = [
  { id: 'OFF-OFF', parent: 'gpt-6-luna', child: 'gpt-6-luna', token: 'R-OFFOFF-1101' },
  { id: 'OFF-GW', parent: 'gpt-6-luna', child: 'ccs-deepseek/glm-5.3-flash', token: 'R-OFFGW-2202' },
  { id: 'GW-OFF', parent: 'ccs-deepseek/auto(free)', child: 'gpt-6-luna', token: 'R-GWOFF-3303' },
  { id: 'GW-GW', parent: 'ccs-deepseek/auto(free)', child: 'ccs-deepseek/deepseek-v4.1-flash', token: 'R-GWGW-4404' },
  { id: 'GW-AUTO', parent: 'ccs-deepseek/auto(free)', child: 'ccs-deepseek/auto(free)', token: 'R-GWAUTO-5505' },
];

// 中文注释：可选通过命令行只跑部分用例，例如 node regression.cjs OFF-GW GW-GW
const filters = process.argv.slice(2);
const selected = filters.length > 0 ? cases.filter((c) => filters.indexOf(c.id) >= 0) : cases;

if (selected.length === 0) {
  console.error('no matching case; available: ' + cases.map((c) => c.id).join(', '));
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, 'regression.jsonl');
// 中文注释：只要任一回归用例未交付、报错或子进程异常退出，整体测试必须失败
let failed = false;

for (const c of selected) {
  const prompt = [
    '请用 spawn_agent 派一个子代理：model 用 ' + c.child + '，reasoning_effort 用 low，fork_turns 用 none。',
    '子代理任务正文只写这一行：只回答一行：' + c.token,
    '把子代理的返回原文一字不改贴给我。如果报错或它说没收到任务，把原话贴出来。',
  ].join('\n');

  const args = ['exec', '--model', c.parent, '--skip-git-repo-check', '--json', '-'];
  const started = Date.now();
  const r = spawnSync(CODEX, args, {
    input: prompt,
    encoding: 'utf8',
    timeout: 420000,
    env: Object.assign({}, process.env, { CODEX_HOME }),
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const record = {
    ts: new Date().toISOString(),
    id: c.id,
    parent: c.parent,
    child: c.child,
    delivered: out.indexOf(c.token) >= 0,
    errorSeen: /reserved|could not be decrypted/.test(out),
    exit: r.status,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  if (!record.delivered || record.errorSeen || record.exit !== 0) {
    failed = true;
  }
  fs.appendFileSync(OUT, JSON.stringify(record) + '\n');
  console.log(JSON.stringify(record));
}
console.log('REGRESSION_DONE');
if (failed) {
  process.exitCode = 1;
}
