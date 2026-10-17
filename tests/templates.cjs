// 第一跳自检：包内模板/提示词 → 运行目录的所有权记录、状态判定与按策略刷新。
// 用例覆盖：首次落位、包内更新、本地改过（不覆盖/--force 覆盖）、notify-only、off、
// 接管、与包内不一致无记录、绝不删除用户文件、mappings.toml 不受影响、状态文件损坏、链接目标。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sync, describe, drifted, readState, stateFile, targetRoot, STATUS } = require('../src/templates.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-templates-'));

// 中文注释：构造一个运行目录 + 一个假的包内 config 目录
function fixture(name) {
  const dir = path.join(root, name);
  const home = path.join(dir, 'home');
  const pkg = path.join(dir, 'pkg');
  for (const relative of ['prompts', 'templates/models', 'templates/agents']) {
    fs.mkdirSync(path.join(pkg, relative), { recursive: true });
  }
  fs.writeFileSync(path.join(pkg, 'prompts/deepseek-codex.md'), 'prompt-v1\n');
  fs.writeFileSync(path.join(pkg, 'templates/models/deepseek-flash.toml'), 'model-v1\n');
  fs.writeFileSync(path.join(pkg, 'templates/agents/deepseek-executor.toml'), 'agent-v1\n');
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  return { home, pkg };
}
const runtimeRead = (home, relative) => fs.readFileSync(path.join(targetRoot(home), relative), 'utf8');
const runtimeWrite = (home, relative, text) => {
  const file = path.join(targetRoot(home), relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const packageWrite = (pkg, relative, text) => fs.writeFileSync(path.join(pkg, relative), text);
const backupRead = (report, relative) => fs.readFileSync(path.join(report.backup, relative.replace(/[\\/]/g, '__')), 'utf8');

try {
  // 1. 首次落位：三份全部写入并记录所有权，第二次幂等
  const a = fixture('fresh');
  const first = sync({ home: a.home, packageRoot: a.pkg, pkgVersion: '9.9.9' });
  assert.equal(first.changed, true);
  assert.equal(first.written.length, 3);
  assert.equal(runtimeRead(a.home, 'prompts/deepseek-codex.md'), 'prompt-v1\n');
  assert.ok(fs.existsSync(path.join(first.backup, 'journal.json')), '事务日志缺失');
  const state = readState(a.home);
  assert.equal(Object.keys(state.files).length, 3);
  assert.equal(state.pkgVersion, '9.9.9');
  const again = sync({ home: a.home, packageRoot: a.pkg });
  assert.equal(again.changed, false);
  assert.equal(again.written.length, 0);
  assert.equal(again.unchanged.length, 3);
  assert.equal(drifted(again), false);

  // 2. 包内更新：dryRun 先报出，再刷新且备份里留着旧内容
  const b = fixture('package-update');
  sync({ home: b.home, packageRoot: b.pkg });
  const before = runtimeRead(b.home, 'prompts/deepseek-codex.md');
  packageWrite(b.pkg, 'prompts/deepseek-codex.md', 'prompt-v2\n');
  const probe = sync({ home: b.home, packageRoot: b.pkg, dryRun: true });
  assert.equal(drifted(probe), true);
  assert.deepEqual(probe.outdated, ['prompts/deepseek-codex.md']);
  assert.equal(runtimeRead(b.home, 'prompts/deepseek-codex.md'), before, 'dryRun 不得写入');
  const applied = sync({ home: b.home, packageRoot: b.pkg });
  assert.equal(runtimeRead(b.home, 'prompts/deepseek-codex.md'), 'prompt-v2\n');
  assert.equal(backupRead(applied, 'prompts/deepseek-codex.md'), before);

  // 3. 本地改过：默认不覆盖（即使包内已更新），--force 才覆盖并备份
  const c = fixture('edited');
  sync({ home: c.home, packageRoot: c.pkg });
  runtimeWrite(c.home, 'prompts/deepseek-codex.md', 'my own prompt\n');
  packageWrite(c.pkg, 'prompts/deepseek-codex.md', 'prompt-v2\n');
  const keep = sync({ home: c.home, packageRoot: c.pkg });
  assert.equal(runtimeRead(c.home, 'prompts/deepseek-codex.md'), 'my own prompt\n');
  assert.deepEqual(keep.edited, ['prompts/deepseek-codex.md']);
  assert.equal(keep.written.length, 0);
  assert.ok(describe(keep).indexOf('本地改过') >= 0);
  assert.equal(drifted(keep), true);
  const forced = sync({ home: c.home, packageRoot: c.pkg, force: true });
  assert.equal(runtimeRead(c.home, 'prompts/deepseek-codex.md'), 'prompt-v2\n');
  assert.equal(backupRead(forced, 'prompts/deepseek-codex.md'), 'my own prompt\n');

  // 4. notify-only 不写入；off 完全不动（连状态文件都不建）
  const d = fixture('notify-only');
  sync({ home: d.home, packageRoot: d.pkg });
  packageWrite(d.pkg, 'prompts/deepseek-codex.md', 'prompt-v2\n');
  const notified = sync({ home: d.home, packageRoot: d.pkg, policy: 'notify-only' });
  assert.equal(notified.written.length, 0);
  assert.equal(drifted(notified), true);
  assert.equal(runtimeRead(d.home, 'prompts/deepseek-codex.md'), 'prompt-v1\n');
  const e = fixture('off');
  const off = sync({ home: e.home, packageRoot: e.pkg, policy: 'off' });
  assert.equal(off.written.length, 0);
  assert.equal(fs.existsSync(stateFile(e.home)), false);

  // 5. 接管：运行目录内容与包内一致但没有记录 → 只补记账，不重写文件
  const f = fixture('adopt');
  runtimeWrite(f.home, 'prompts/deepseek-codex.md', 'prompt-v1\n');
  const adopted = sync({ home: f.home, packageRoot: f.pkg, pkgVersion: '1.0.0' });
  assert.deepEqual(adopted.adopted, ['prompts/deepseek-codex.md']);
  assert.equal(adopted.written.length, 2);
  assert.ok(readState(f.home).files['prompts/deepseek-codex.md']);
  // 中文注释：接管不算「值得通知的漂移」
  assert.equal(drifted({ entries: [{ status: STATUS.adoptable }, { status: STATUS.current }] }), false);
  assert.equal(drifted({ entries: [{ status: STATUS.outdated }] }), true);

  // 6. 与包内不一致且无所有权记录：不自动覆盖，只报告
  const g = fixture('divergent');
  runtimeWrite(g.home, 'prompts/deepseek-codex.md', 'legacy different\n');
  const divergent = sync({ home: g.home, packageRoot: g.pkg });
  assert.equal(runtimeRead(g.home, 'prompts/deepseek-codex.md'), 'legacy different\n');
  assert.ok(divergent.edited.indexOf('prompts/deepseek-codex.md') >= 0);

  // 7. 绝不删除用户文件；mappings.toml 不在受管集合内
  const h = fixture('keep-user-files');
  sync({ home: h.home, packageRoot: h.pkg });
  runtimeWrite(h.home, 'prompts/my-extra.md', 'mine\n');
  runtimeWrite(h.home, 'mappings.toml', 'version = 1\nbindings = []\n');
  packageWrite(h.pkg, 'prompts/deepseek-codex.md', 'prompt-v2\n');
  sync({ home: h.home, packageRoot: h.pkg });
  assert.equal(runtimeRead(h.home, 'prompts/my-extra.md'), 'mine\n');
  assert.equal(runtimeRead(h.home, 'mappings.toml'), 'version = 1\nbindings = []\n');

  // 8. 所有权记录损坏：按无记录处理，不崩溃
  const i = fixture('corrupt-state');
  fs.mkdirSync(path.join(i.home, 'state'), { recursive: true });
  fs.writeFileSync(stateFile(i.home), '{not json');
  const recovered = sync({ home: i.home, packageRoot: i.pkg });
  assert.equal(runtimeRead(i.home, 'prompts/deepseek-codex.md'), 'prompt-v1\n');
  assert.equal(recovered.written.length, 3);

  // 9. 目标是链接：拒绝写入，只报告
  const j = fixture('symlink');
  const outside = path.join(path.dirname(j.home), 'outside.md');
  fs.writeFileSync(outside, 'outside\n');
  const linkPath = path.join(targetRoot(j.home), 'prompts/deepseek-codex.md');
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let linked = true;
  try {
    fs.symlinkSync(outside, linkPath);
  } catch (err) {
    linked = false;
    console.log('  （跳过链接用例：' + err.message + '）');
  }
  if (linked) {
    const linkedReport = sync({ home: j.home, packageRoot: j.pkg });
    assert.ok(linkedReport.blocked.some((entry) => entry.relative === 'prompts/deepseek-codex.md'));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
  }

  console.log('TEMPLATES_TEST_PASS：状态判定、策略刷新、备份与安全边界。');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
