// model_id_like 回归测试：末段精确匹配、exact 优先、歧义/缺失告警、官方保护。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('@iarna/toml');
const { apply } = require('../src/mappings.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-like-'));

// 中文注释：构造隔离环境；models 为 catalog 中的 slug 列表
function fixture(name, models, bindings) {
  const dir = path.join(root, name);
  const home = path.join(dir, 'home');
  const config = path.join(dir, 'config');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n');
  fs.writeFileSync(path.join(home, 'cc-switch-model-catalog.json'), JSON.stringify({ models: models.map((slug) => ({ slug })) }));
  fs.writeFileSync(path.join(config, 'model.toml'), '[text_files]\nbase_instructions = "prompt.md"\n');
  fs.writeFileSync(path.join(config, 'prompt.md'), 'managed-template\n');
  // 中文注释：每个 binding 都要有 [[bindings]] 头
  const mappingText = 'version = 1\n' + bindings.map((binding) => '[[bindings]]\n' + Object.entries(binding)
    .map(([key, value]) => key + ' = ' + JSON.stringify(value)).join('\n') + '\n').join('\n');
  fs.writeFileSync(path.join(config, 'mappings.toml'), mappingText);
  return { home, mappingFile: path.join(config, 'mappings.toml'), backupRoot: path.join(dir, 'backups'), logFile: path.join(dir, 'log.jsonl') };
}

// 中文注释：读取目录里某个 slug 的 base_instructions
function instructions(p, slug) {
  const catalog = JSON.parse(fs.readFileSync(path.join(p.home, 'cc-switch-model-catalog.json'), 'utf8'));
  const hit = catalog.models.find((model) => model.slug === slug);
  return hit ? hit.base_instructions : undefined;
}

try {
  // 1) exact 优先：全量与 like 同时配置时走全量
  const exactFirst = fixture('exact-first', ['ccs-deepseek/deepseek-v4.1-flash'], [{
    model_id: 'ccs-deepseek/deepseek-v4.1-flash', model_id_like: 'deepseek-v4.1-flash', model_template: 'model.toml',
  }]);
  assert.equal(apply(exactFirst).ok, true);
  assert.equal(instructions(exactFirst, 'ccs-deepseek/deepseek-v4.1-flash'), 'managed-template\n');

  // 2) like 唯一命中：换个供应商前缀也能命中
  const likeOnly = fixture('like-only', ['other-provider/deepseek-v4.1-flash'], [{
    model_id: 'ccs-deepseek/deepseek-v4.1-flash', model_id_like: 'deepseek-v4.1-flash', model_template: 'model.toml',
  }]);
  const likeResult = apply(likeOnly);
  assert.equal(likeResult.ok, true);
  assert.equal(instructions(likeOnly, 'other-provider/deepseek-v4.1-flash'), 'managed-template\n');

  // 3) like 命中多个 → ambiguous_model 并跳过
  const ambiguous = fixture('ambiguous', ['a/deepseek-v4.1-flash', 'b/deepseek-v4.1-flash'], [{
    model_id_like: 'deepseek-v4.1-flash', model_template: 'model.toml',
  }]);
  const ambiguousResult = apply(ambiguous);
  assert.ok(ambiguousResult.warnings.some((warning) => warning.code === 'ambiguous_model'), '多重命中必须告警');
  assert.equal(instructions(ambiguous, 'a/deepseek-v4.1-flash'), undefined, '歧义时不得写入');

  // 4) like 无命中 → missing_model
  const missing = fixture('missing', ['a/other-model'], [{ model_id_like: 'deepseek-v4.1-flash', model_template: 'model.toml' }]);
  assert.ok(apply(missing).warnings.some((warning) => warning.code === 'missing_model'));

  // 5) 官方保护：like 命中官方模型时必须拦截且 ok=false
  const official = fixture('official', ['gpt-6.1-sol'], [{ model_id_like: 'gpt-6.1-sol', model_template: 'model.toml' }]);
  const officialResult = apply(official);
  assert.equal(officialResult.ok, false, '命中官方模型必须判失败');
  assert.ok(officialResult.warnings.some((warning) => warning.code === 'official_model_blocked'));
  assert.equal(instructions(official, 'gpt-6.1-sol'), undefined, '官方模型不得被写入');

  // 6) 显式关闭官方保护时才允许（用于用户自担风险的场景）
  const officialAllowed = fixture('official-allowed', ['gpt-6.1-sol'], [{ model_id_like: 'gpt-6.1-sol', model_template: 'model.toml' }]);
  assert.equal(apply({ ...officialAllowed, officialGuard: false }).ok, true);
  assert.equal(instructions(officialAllowed, 'gpt-6.1-sol'), 'managed-template\n');

  // 7) 映射文件既没有 model_id 也没有 model_id_like → 必须报错
  const invalid = fixture('invalid', ['a/x'], [{ model_template: 'model.toml' }]);
  assert.throws(() => apply(invalid), /至少配置一个/);
  assert.equal(toml.parse(fs.readFileSync(path.join(invalid.home, 'config.toml'), 'utf8')).model, 'x');

  console.log('LIKE_MATCHING_TEST_PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
