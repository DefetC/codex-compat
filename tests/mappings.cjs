// 中文注释：所有用例运行真实解析、文件同步和回退，不接触本机配置。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const toml = require('@iarna/toml');
assert.ok(fs.existsSync(path.join(__dirname, '../src/mappings.cjs')), '通用映射同步尚未实现');
const { apply, rollback } = require('../src/mappings.cjs');
// 中文注释：临时实验范围，由本测试独占。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mappings-'));
// 中文注释：生成两个共享模板的模型及一个不受管理的模型。
function fixture(name) {
  const dir = path.join(root, name); const home = path.join(dir, 'home'); const config = path.join(dir, 'config');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(config);
  fs.writeFileSync(path.join(home, 'config.toml'), '# 用户注释\nmodel = "official"\n[agents.reader]\nconfig_file = "mine.toml"\ndescription = "用户角色"\n');
  fs.writeFileSync(path.join(home, 'cc-switch-model-catalog.json'), JSON.stringify({ other: 'keep', models: [
    { slug: 'vendor/auto', default_reasoning_level: 'low', nested: { keep: 9, list: [1, 2] }, untouched: true },
    { slug: 'vendor/flash', default_reasoning_level: 'low' }, { slug: 'official', unknown: { value: 42 } },
  ] }));
  fs.writeFileSync(path.join(config, 'model.toml'), '[settings]\ndefault_reasoning_level = "high"\n[settings.nested]\nlist = [3]\n[text_files]\nbase_instructions = "prompt.md"\n"model_messages.instructions_template" = "prompt.md"\n');
  fs.writeFileSync(path.join(config, 'role.toml'), '[text_files]\ndeveloper_instructions = "developer.md"\n');
  fs.writeFileSync(path.join(config, 'prompt.md'), '可信模型模板\n'); fs.writeFileSync(path.join(config, 'developer.md'), '可信角色指导\n');
  const bindings = ['auto', 'flash'].map(id => `[[bindings]]\nmodel_id = "vendor/${id}"\nmodel_template = "model.toml"\nrole_template = "role.toml"\nrole_name = "ds_${id}"\nrole_description = "执行角色"\n`).join('\n');
  fs.writeFileSync(path.join(config, 'mappings.toml'), 'version = 1\n' + bindings);
  return { home, mappingFile: path.join(config, 'mappings.toml'), backupRoot: path.join(dir, 'backups'), logFile: path.join(dir, 'log.jsonl') };
}
// 中文注释：读取模型目录，仅服务于测试断言。
function catalog(p) { return JSON.parse(fs.readFileSync(path.join(p.home, 'cc-switch-model-catalog.json'), 'utf8')); }
try {
  const p = fixture('basic'); const initial = catalog(p);
  assert.equal(apply({ ...p, dryRun: true }).changed, true);
  assert.equal(fs.existsSync(p.backupRoot), false); assert.equal(fs.existsSync(p.logFile), false);
  assert.equal(fs.existsSync(path.join(p.home, 'agents')), false);
  const r = apply(p); assert.equal(r.ok, true); assert.ok(r.changeId);
  const c = catalog(p);
  assert.equal(c.models[0].default_reasoning_level, 'high'); assert.equal(c.models[0].nested.keep, 9);
  assert.deepEqual(c.models[0].nested.list, [3]); assert.equal(c.models[0].base_instructions, '可信模型模板\n');
  assert.equal(c.models[0].model_messages.instructions_template, '可信模型模板\n');
  assert.deepEqual(c.models[2], initial.models[2]); assert.equal(c.other, 'keep');
  const cfg = toml.parse(fs.readFileSync(path.join(p.home, 'config.toml'), 'utf8'));
  assert.equal(cfg.features.multi_agent_v2.enabled, true); assert.equal(cfg.agents.reader.config_file, 'mine.toml');
  const role = toml.parse(fs.readFileSync(path.join(p.home, 'agents/ds-auto.toml'), 'utf8'));
  assert.equal(role.model, 'vendor/auto'); assert.equal(role.model_reasoning_effort, undefined);
  assert.equal(role.developer_instructions, '可信角色指导\n');
  assert.equal(apply(p).changed, false); assert.equal(fs.readdirSync(p.backupRoot).length, 1);
  assert.ok(!fs.readFileSync(p.logFile, 'utf8').includes('可信角色指导'));
  // 中文注释：回退必须保留同步之后的无关配置改动。
  const newer = catalog(p); newer.models[2].unknown.value = 43; newer.models[0].untouched = 'new';
  fs.writeFileSync(path.join(p.home, 'cc-switch-model-catalog.json'), JSON.stringify(newer));
  fs.appendFileSync(path.join(p.home, 'config.toml'), '\n[user_added]\nvalue = 10\n');
  rollback({ ...p, changeId: r.changeId });
  assert.equal(catalog(p).models[0].default_reasoning_level, 'low'); assert.deepEqual(catalog(p).models[0].nested.list, [1, 2]);
  assert.equal(catalog(p).models[0].untouched, 'new'); assert.equal(catalog(p).models[2].unknown.value, 43);
  assert.equal(toml.parse(fs.readFileSync(path.join(p.home, 'config.toml'), 'utf8')).user_added.value, 10);
  assert.equal(fs.existsSync(path.join(p.home, 'agents/ds-auto.toml')), false);
  const q = fixture('conflict'); fs.mkdirSync(path.join(q.home, 'agents'));
  fs.writeFileSync(path.join(q.home, 'agents/ds-auto.toml'), 'model = "user"\n');
  const qr = apply(q); assert.equal(qr.ok, false); assert.ok(qr.warnings.some(w => w.code === 'role_conflict'));
  assert.equal(catalog(q).models[0].default_reasoning_level, 'low'); assert.equal(catalog(q).models[1].default_reasoning_level, 'high');
  const s = fixture('missing'); const sc = catalog(s); sc.models.splice(0, 1);
  fs.writeFileSync(path.join(s.home, 'cc-switch-model-catalog.json'), JSON.stringify(sc));
  const sr = apply(s); assert.ok(sr.warnings.some(w => w.code === 'missing_model'));
  assert.equal(fs.existsSync(path.join(s.home, 'agents/ds-auto.toml')), false);
  const t = fixture('duplicates'); fs.appendFileSync(t.mappingFile, '\n[[bindings]]\nmodel_id = "vendor/auto"\nmodel_template = "model.toml"\n');
  assert.throws(() => apply(t), /重复/); assert.equal(fs.existsSync(t.backupRoot), false);
  // 中文注释：守护进程漂移检测的依据 —— 外部重生成目录（抹掉注入）后 dryRun 必须重新报「待同步」，
  // 预演不落盘，恢复动作重新写入模板并留下独立备份，恢复后再预演回到「无待同步」。
  const g = fixture('regenerated'); assert.equal(apply(g).changed, true);
  const stripped = catalog(g); delete stripped.models[0].base_instructions; delete stripped.models[0].model_messages;
  fs.writeFileSync(path.join(g.home, 'cc-switch-model-catalog.json'), JSON.stringify(stripped));
  assert.equal(apply({ ...g, dryRun: true }).changed, true);
  assert.equal(fs.readdirSync(g.backupRoot).length, 1);
  assert.equal(apply(g).changed, true);
  assert.equal(catalog(g).models[0].base_instructions, '可信模型模板\n');
  assert.equal(catalog(g).models[0].model_messages.instructions_template, '可信模型模板\n');
  assert.equal(fs.readdirSync(g.backupRoot).length, 2);
  assert.equal(apply({ ...g, dryRun: true }).changed, false);
  const u = fixture('escape'); fs.writeFileSync(path.join(path.dirname(u.mappingFile), 'model.toml'), '[text_files]\nbase_instructions = "../secret.md"\n');
  assert.throws(() => apply(u), /越界/); assert.equal(fs.existsSync(u.backupRoot), false);
  const v = fixture('rollback-conflict'); const vr = apply(v); const vc = catalog(v); vc.models[0].default_reasoning_level = 'max';
  fs.writeFileSync(path.join(v.home, 'cc-switch-model-catalog.json'), JSON.stringify(vc));
  assert.throws(() => rollback({ ...v, changeId: vr.changeId }), /冲突/);
  assert.ok(fs.existsSync(path.join(v.home, 'agents/ds-auto.toml')));
  const w = fixture('disabled'); apply(w); fs.writeFileSync(w.mappingFile, 'version = 1\nbindings = []\n');
  assert.equal(apply(w).changed, false); assert.ok(fs.existsSync(path.join(w.home, 'agents/ds-auto.toml')));
  // 中文注释：假值注册也是用户配置，不能当成缺失后覆盖。
  const falseRole = fixture('false-role'); fs.appendFileSync(path.join(falseRole.home, 'config.toml'), '\n[agents]\nds_auto = false\n');
  const falseResult = apply(falseRole); assert.equal(falseResult.ok, false);
  assert.equal(toml.parse(fs.readFileSync(path.join(falseRole.home, 'config.toml'), 'utf8')).agents.ds_auto, false);
  assert.equal(catalog(falseRole).models[0].default_reasoning_level, 'low');
  // 中文注释：生成文件名碰撞和身份字段越权必须在写入前拒绝。
  const collision = fixture('filename-collision'); fs.writeFileSync(collision.mappingFile, fs.readFileSync(collision.mappingFile, 'utf8').replace('ds_flash', 'ds-auto'));
  assert.throws(() => apply(collision), /目标文件重复/); assert.equal(fs.existsSync(collision.backupRoot), false);
  const identity = fixture('identity'); fs.appendFileSync(path.join(path.dirname(identity.mappingFile), 'role.toml'), '\n[settings]\nmodel = "other"\n');
  assert.throws(() => apply(identity), /身份字段/); assert.equal(fs.existsSync(identity.backupRoot), false);
  // 中文注释：只配置模型不生成角色，目录路径可由 Codex 配置指定。
  const modelOnly = fixture('model-only'); fs.writeFileSync(modelOnly.mappingFile, 'version = 1\n[[bindings]]\nmodel_id = "vendor/auto"\nmodel_template = "model.toml"\n');
  fs.renameSync(path.join(modelOnly.home, 'cc-switch-model-catalog.json'), path.join(modelOnly.home, 'custom.json'));
  fs.writeFileSync(path.join(modelOnly.home, 'config.toml'), 'model_catalog_json = "custom.json"\n');
  assert.equal(apply(modelOnly).ok, true); assert.equal(fs.existsSync(path.join(modelOnly.home, 'agents')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(modelOnly.home, 'custom.json'), 'utf8')).models[0].default_reasoning_level, 'high');
  // 中文注释：禁用的映射不要求源模板继续存在，不自动清理已生成内容。
  const disabled = fixture('disabled-source'); fs.writeFileSync(disabled.mappingFile, 'version = 1\n[[bindings]]\nmodel_id = "vendor/auto"\nmodel_template = "missing.toml"\nenabled = false\n');
  assert.equal(apply(disabled).ok, true);
  // 中文注释：旧角色所有权仅在路径、指纹和注册一致时迁移。
  const legacy = fixture('legacy'); apply(legacy);
  // 中文注释：把新状态文件改名成「上一代命名规律」的文件名，模拟从旧安装升级
  fs.renameSync(path.join(legacy.home, '.codex-compat-mappings.json'), path.join(legacy.home, '.codex-legacy-mappings.json'));
  assert.equal(apply(legacy).ok, true); assert.ok(fs.existsSync(path.join(legacy.home, '.codex-compat-mappings.json')));
  fs.appendFileSync(path.join(legacy.home, 'agents/ds-auto.toml'), '# 用户修改\n');
  assert.ok(apply(legacy).warnings.some(warning => warning.code === 'role_conflict'));
  // 中文注释：角色模板可以不携带 developer_instructions，此时角色只承载模型信息
  const noDev = fixture('no-developer');
  fs.writeFileSync(path.join(path.dirname(noDev.mappingFile), 'role.toml'), '[settings]\n');
  assert.equal(apply(noDev).ok, true);
  const roleNoDev = toml.parse(fs.readFileSync(path.join(noDev.home, 'agents/ds-auto.toml'), 'utf8'));
  assert.equal(roleNoDev.model, 'vendor/auto');
  assert.equal(roleNoDev.developer_instructions, undefined);
  // 中文注释：role_enabled=false 时不生成角色，但模型模板仍然生效
  const noRole = fixture('role-disabled');
  fs.writeFileSync(noRole.mappingFile, 'version = 1\n[[bindings]]\nmodel_id = "vendor/auto"\nmodel_template = "model.toml"\nrole_template = "role.toml"\nrole_name = "ds_auto"\nrole_description = "执行角色"\nrole_enabled = false\n');
  assert.equal(apply(noRole).ok, true);
  assert.equal(fs.existsSync(path.join(noRole.home, 'agents/ds-auto.toml')), false);
  assert.equal(catalog(noRole).models[0].default_reasoning_level, 'high');
  assert.equal(toml.parse(fs.readFileSync(path.join(noRole.home, 'config.toml'), 'utf8')).agents.ds_auto, undefined);
  // 中文注释：工具升级导致角色内容变化时，默认拒绝覆盖，显式 forceRoles 才允许接管自己的角色
  const force = fixture('force-roles');
  assert.equal(apply(force).ok, true);
  fs.writeFileSync(path.join(force.home, 'agents/ds-auto.toml'), 'name = "ds_auto"\ndescription = "旧版本内容"\nmodel = "vendor/auto"\n');
  assert.ok(apply(force).warnings.some((warning) => warning.code === 'role_conflict'));
  const forced = apply({ ...force, forceRoles: true });
  assert.equal(forced.ok, true);
  assert.equal(toml.parse(fs.readFileSync(path.join(force.home, 'agents/ds-auto.toml'), 'utf8')).description, '执行角色');
  // 中文注释：陈旧事务允许回退默认目录，但不能借此切换目标目录。
  const oldJournal = fixture('old-journal'); const oldResult = apply(oldJournal);
  const oldFile = path.join(oldJournal.backupRoot, oldResult.changeId, 'transaction.json');
  const oldRecord = JSON.parse(fs.readFileSync(oldFile, 'utf8')); delete oldRecord.catalogFile;
  fs.writeFileSync(oldFile, JSON.stringify(oldRecord));
  assert.equal(rollback({ ...oldJournal, changeId: oldResult.changeId }).ok, true);
  console.log('MAPPINGS_TEST_PASS：局部覆盖、数组替换、共享文本、角色强度留空、幂等、预演、冲突、缺失、校验、回退与停止管理。');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
