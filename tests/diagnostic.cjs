// 诊断包隐私回归：文本兜底与真实文件快照都不能残留合成秘密。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config.cjs');
const diagnostic = require('../src/commands/diagnostic.cjs');

// 全部为合成字符串，不是任何真实凭据、任务或会话。
const SECRETS = ['DIAG_BEARER_VALUE', 'DIAG_JSON_API_KEY', 'DIAG_CLIENT_SECRET', 'DIAG_URI_USER', 'DIAG_URI_PASS', 'DIAG_QUERY_SECRET', 'DIAG_TASK_BODY', 'DIAG_SUMMARY_BODY'];
// 合成的 Fernet 形态，仅用于确认尾部填充也被完整遮盖。
const CIPHER = 'gAAAAAB_DIAG_SYNTHETIC_CIPHER==';
// 可还原摘要同样属于敏感正文。
const WRAPPER = 'ccswitch-compaction-v1:' + Buffer.from('DIAG_SUMMARY_BODY').toString('base64');

// 实际生成诊断包，只使用自己的兼容目录和 Codex 目录。
async function main() {
  const text = 'Authorization: Bearer DIAG_BEARER_VALUE\n{"apiKey":"DIAG_JSON_API_KEY"}\n' + CIPHER + '\n' + WRAPPER;
  const sanitized = diagnostic.sanitize(text);
  for (const secret of [SECRETS[0], SECRETS[1], CIPHER, WRAPPER]) {
    assert.equal(sanitized.includes(secret), false, '文本脱敏遗漏：' + secret);
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-diagnostic-'));
  const codexHome = path.join(home, 'codex');
  const originalCodexHome = process.env.CODEX_HOME;
  const originalCompatHome = process.env.CODEX_COMPAT_HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_COMPAT_HOME = home;
  try {
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "fixture-model"\nmodel_provider = "fixture"\nmodel_catalog_json = "models.json"\n[model_providers.fixture]\nbase_url = "http://127.0.0.1:65534/v1"\n', 'utf8');
    fs.writeFileSync(path.join(codexHome, 'models.json'), '{"models":[]}', 'utf8');
    const cfg = structuredClone(config.DEFAULTS);
    cfg.home = home;
    cfg.listen.port = 65533;
    cfg.upstream.mode = 'custom';
    cfg.upstream.port = 65534;
    cfg.upstream.baseUrl = 'https://DIAG_URI_USER:DIAG_URI_PASS@gateway.example/v1?api_key=DIAG_QUERY_SECRET&safe=keep';
    cfg.apiKey = 'DIAG_JSON_API_KEY';
    cfg.nested = { clientSecret: 'DIAG_CLIENT_SECRET', headers: { authorization: 'Bearer DIAG_BEARER_VALUE' }, task: 'DIAG_TASK_BODY', summary: 'DIAG_SUMMARY_BODY', encrypted_content: CIPHER, tokenCount: 7 };
    cfg.compat.opaqueTaskModels = ['vendor/test-model'];
    config.save(cfg, home);
    fs.mkdirSync(config.paths(home).logs);
    fs.writeFileSync(path.join(config.paths(home).logs, 'compat-fixture.jsonl'), JSON.stringify({ event: 'rewrite', model: 'vendor/test-model', tokenCount: 7, headers: { authorization: 'Bearer DIAG_BEARER_VALUE' }, task: 'DIAG_TASK_BODY', encrypted_content: WRAPPER }) + '\n', 'utf8');
    fs.appendFileSync(path.join(config.paths(home).logs, 'compat-fixture.jsonl'), JSON.stringify({ event: 'compaction_error', level: 'error', error: { name: 'TypeError', code: null } }) + '\n', 'utf8');
    assert.equal(require('../src/commands/doctor.cjs').scanLogs(config.paths(home).logs).bad, 1, '新增错误事件不能被体检忽略');
    const sourceBefore = fs.readFileSync(config.paths(home).configFile);
    // 未闭合记录可能包含完整任务片段，诊断包必须明确省略，不能继续公开该片段。
    fs.appendFileSync(path.join(config.paths(home).logs, 'compat-fixture.jsonl'), '{"task":"DIAG_TASK_BODY', 'utf8');
    const result = await diagnostic.bundle({ home });
    assert.equal(result.omittedLogLines, 1);
    assert.equal(result.ok, true);
    assert.ok(result.lines.some((line) => /人工|检查/.test(line)), '诊断包必须提示分享前人工检查');
    const files = fs.readdirSync(result.dir);
    assert.ok(files.includes('config.json') && files.includes('status.json') && files.includes('compat-fixture.jsonl'));
    const all = files.map((name) => fs.readFileSync(path.join(result.dir, name), 'utf8')).join('\n');
    for (const secret of [...SECRETS, CIPHER, WRAPPER]) {
      assert.equal(all.includes(secret), false, '诊断包遗漏脱敏：' + secret);
    }
    const safeConfig = JSON.parse(fs.readFileSync(path.join(result.dir, 'config.json'), 'utf8'));
    assert.equal(safeConfig.nested.tokenCount, 7);
    assert.deepEqual(safeConfig.compat.opaqueTaskModels, ['vendor/test-model']);
    assert.ok(safeConfig.upstream.baseUrl.includes('safe=keep'));
    assert.deepEqual(fs.readFileSync(config.paths(home).configFile), sourceBefore, '生成诊断包不能改写原始配置');
    for (const line of fs.readFileSync(path.join(result.dir, 'compat-fixture.jsonl'), 'utf8').trim().split('\n')) {
      assert.doesNotThrow(() => JSON.parse(line), '脱敏后的 JSONL 仍须符合结构');
    }
  } finally {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    if (originalCompatHome === undefined) {
      delete process.env.CODEX_COMPAT_HOME;
    } else {
      process.env.CODEX_COMPAT_HOME = originalCompatHome;
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  console.log('DIAGNOSTIC_TEST_PASS');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
