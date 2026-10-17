// 安装后冒烟测试：验证 config.toml 里的配置（不传 -c 参数）是否生效
// 路径约定：本文件位于 tests/，仓库根是上一级
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'regression');
const CODEX = process.env.CODEX_BIN
  || path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin', '9691020b546a15b2', 'codex.exe');
const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex');

// 中文注释：只跑最关键的两种跨 provider 组合，用于快速验证
const cases = [
  { id: 'OFF-GW', parent: 'gpt-6-luna', child: 'ccs-deepseek/glm-5.3-flash', token: 'I-OFFGW-5101' },
  { id: 'GW-OFF', parent: 'ccs-deepseek/auto(free)', child: 'gpt-6-luna', token: 'I-GWOFF-5202' },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, 'smoke.jsonl');
// 中文注释：只要任一冒烟用例未交付、报错或子进程异常退出，整体测试必须失败
let failed = false;

for (const c of cases) {
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
console.log('SMOKE_DONE');
if (failed) {
  process.exitCode = 1;
}
