// --verbose 回归测试：默认输出不变；开启后附带异常堆栈与排查细节。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const bin = path.join(repo, 'bin', 'codex-compat.cjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-verbose-'));

// 中文注释：在隔离运行目录下执行命令
function run(args) {
  return spawnSync(process.execPath, [bin].concat(args), {
    cwd: repo,
    env: Object.assign({}, process.env, { CODEX_COMPAT_HOME: home }),
    encoding: 'utf8',
    windowsHide: true,
  });
}

try {
  // 1) 默认（未开启 verbose）出错时不得携带堆栈
  const plain = run(['config', 'set', 'listen.port', 'abc', '--json']);
  assert.equal(plain.status, 1, '非法端口必须失败');
  const plainJson = JSON.parse(plain.stdout);
  assert.equal(plainJson.code, 'exception');
  assert.equal(plainJson.stack, undefined, '默认输出不得包含堆栈');

  // 2) 开启 verbose 后 JSON 结果必须携带堆栈
  const verbose = run(['config', 'set', 'listen.port', 'abc', '--json', '--verbose']);
  assert.equal(verbose.status, 1);
  const verboseJson = JSON.parse(verbose.stdout);
  assert.equal(typeof verboseJson.stack, 'string', 'verbose 输出必须包含堆栈');
  assert.ok(verboseJson.stack.includes('parsePort'), '堆栈必须指向真实抛错位置，实际：' + verboseJson.stack.split('\n')[0]);

  // 3) 非 JSON 模式下，verbose 把堆栈写到 stderr
  const human = run(['config', 'set', 'listen.port', 'abc', '--verbose']);
  assert.equal(human.status, 1);
  assert.ok(human.stderr.includes('at '), 'verbose 时 stderr 必须包含堆栈行');
  const quiet = run(['config', 'set', 'listen.port', 'abc']);
  assert.ok(!quiet.stderr.includes('at '), '默认 stderr 不得包含堆栈行');

  // 4) 没有更多信息可打印的命令，开启 verbose 不改变输出
  const versionPlain = run(['version']);
  const versionVerbose = run(['version', '--verbose']);
  assert.equal(versionVerbose.stdout, versionPlain.stdout, 'version 输出不应被 verbose 改变');

  // 5) install 预演在 verbose 下必须附带诊断块
  const dry = run(['install', '--dry-run', '--verbose', '--yes']);
  assert.ok(dry.stdout.includes('详细信息（--verbose）'), 'install --dry-run --verbose 必须输出诊断块');
  assert.ok(dry.stdout.includes('端口尝试明细'), '诊断块必须包含端口尝试明细');

  console.log('VERBOSE_TEST_PASS');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
