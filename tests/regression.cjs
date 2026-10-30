// 在线兼容回归：每个父子组合使用新临时 home，成功必须由孩子自己的 rollout 证明。
// 运行前显式提供 CODEX_BIN；只连接本机代理，不修改用户主配置或主会话。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const toml = require('@iarna/toml');
const { readSessions, proveChild } = require('./helpers/child-proof.cjs');

// 仓库根只用于写入无凭据的测试摘要。
const ROOT = path.resolve(__dirname, '..');
// 默认覆盖用户要求的三种父模型和子模型，组成九种组合。
const MODEL_ROWS = [
  // CC Switch 的官方模型路由。
  { id: 'OFF', model: 'gpt-6.1-sol' },
  // CC Switch 的第三方 GPT 路由。
  { id: 'GW', model: 'ccs-deepseek/gpt-6.1-sol' },
  // CC Switch 的 DeepSeek Flash 路由。
  { id: 'FLASH', model: 'ccs-deepseek/deepseek-v4.1-flash' },
];

// 明确校验输入，不能回退到旧桌面哈希路径或用户主 CODEX_HOME。
function options(env = process.env) {
  if (!env.CODEX_BIN) {
    throw new Error('在线回归必须显式设置 CODEX_BIN，指向要验证的原生 Codex CLI');
  }
  const base = new URL(env.CODEX_TEST_BASE_URL || 'http://127.0.0.1:15731/v1');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('在线回归只连接本机代理，避免把既有身份发送到未确认的远程地址');
  }
  const authFile = env.CODEX_TEST_AUTH_FILE || path.join(os.homedir(), '.codex', 'auth.json');
  if (!fs.existsSync(authFile)) {
    throw new Error('未找到既有授权身份；请设置 CODEX_TEST_AUTH_FILE，不自动发起登录');
  }
  const models = env.CODEX_TEST_MODELS ? JSON.parse(env.CODEX_TEST_MODELS) : MODEL_ROWS.map((row) => row.model);
  if (!Array.isArray(models) || models.length !== 3 || models.some((model) => typeof model !== 'string' || !model.trim())) {
    throw new Error('CODEX_TEST_MODELS 必须是三个精确模型名称的 JSON 数组');
  }
  return { cli: env.CODEX_BIN, baseUrl: base.toString().replace(/\/+$/, ''), authFile, catalogFile: env.CODEX_TEST_CATALOG || null, models };
}

// 生成只读、禁止自动批准且强制开启 output replay 的隔离配置。
function prepare(home, workspace, parent, child, opts) {
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(opts.authFile, path.join(home, 'auth.json'));
  const cfg = {
    model: parent, model_provider: 'custom', model_reasoning_effort: 'low', approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled',
    features: { hooks: false, plugins: false, apps: false, skip_host_skill_discovery: true, output_token_replay: true, enable_request_compression: true, multi_agent_v2: { enabled: true, tool_namespace: 'agents' } },
    model_providers: { custom: { name: 'OpenAI', base_url: opts.baseUrl, requires_openai_auth: true, wire_api: 'responses', supports_websockets: false, request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 120000 } },
    agents: { max_threads: 2, max_depth: 1, compat_test_child: { description: '隔离兼容性计算实验；不读外部文件，不修改文件，不访问凭据。', config_file: path.join(home, 'child.toml') } },
    windows: { sandbox: 'unelevated' },
  };
  if (opts.catalogFile) {
    const catalogFile = path.join(home, 'catalog.json');
    fs.copyFileSync(opts.catalogFile, catalogFile);
    cfg.model_catalog_json = catalogFile;
  }
  fs.writeFileSync(path.join(home, 'config.toml'), toml.stringify(cfg), 'utf8');
  fs.writeFileSync(path.join(home, 'child.toml'), toml.stringify({ model: child, model_provider: 'custom', model_reasoning_effort: 'low' }), 'utf8');
  fs.mkdirSync(workspace, { recursive: true });
}

// 只留下模型、独立回答和必要工具链证据；临时身份及原始会话最终全部清理。
function runCase(test, opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-live-'));
  const home = path.join(root, 'codex');
  const workspace = path.join(root, 'workspace');
  const expected = 'COMPAT-CHILD-' + test.id + ':83';
  const started = Date.now();
  try {
    prepare(home, workspace, test.parent, test.child, opts);
    const prompt = '这是只读兼容性实验，不是编码任务。不要读取或修改任何文件，不访问凭据。必须真实调用 spawn_agent 创建恰好一个 agent_type="compat_test_child" 的子代理，其配置指定模型 ' + test.child + '。子代理任务：不调用工具，只计算 13+29+41，严格回复 ' + expected + '。父代理禁止自己代算或复述口令伪装成功，必须调用 wait_agent 或 wait 等待真实完成，并报告实际代理 ID 和回复。';
    const result = spawnSync(opts.cli, ['exec', '-C', workspace, '-s', 'read-only', '--skip-git-repo-check', '--json', '-'], { input: prompt, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: Object.assign({}, process.env, { CODEX_HOME: home }) });
    const events = (result.stdout || '').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    const startedEvent = events.find((event) => event.type === 'thread.started');
    const completed = events.some((event) => event.type === 'turn.completed');
    const failed = events.some((event) => event.type === 'error' || event.type === 'turn.failed');
    const proof = proveChild({ parentId: startedEvent && startedEvent.thread_id, parentModel: test.parent, childModel: test.child, expected, sessions: readSessions(home) });
    return { id: test.id, parent: test.parent, child: test.child, exit: result.status, errorCode: result.error && result.error.code || null, completed, failed, proof, ok: result.status === 0 && !result.error && completed && !failed && proof.ok, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// 串行运行选定组合，任意缺少孩子证据的用例都使整体退出失败。
function main() {
  const opts = options();
  const cases = MODEL_ROWS.flatMap((parent, parentIndex) => MODEL_ROWS.map((child, childIndex) => ({ id: parent.id + '-' + child.id, parent: opts.models[parentIndex], child: opts.models[childIndex] })));
  const filters = process.argv.slice(2);
  const selected = filters.length ? cases.filter((test) => filters.includes(test.id)) : cases;
  if (!selected.length) {
    throw new Error('没有匹配组合，可选：' + cases.map((test) => test.id).join(', '));
  }
  const dir = path.join(ROOT, 'artifacts', 'regression');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'regression-' + Date.now() + '-' + process.pid + '.jsonl');
  let failed = false;
  for (const test of selected) {
    const record = runCase(test, opts);
    fs.appendFileSync(out, JSON.stringify(record) + '\n', 'utf8');
    console.log(JSON.stringify(record));
    failed = failed || !record.ok;
  }
  console.log('REGRESSION_DONE ' + out);
  if (failed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // 错误可能来自含任务的 JSONL，默认输出仅保留安全异常类型，不回显原始 stdout。
    console.error('在线兼容回归失败', { name: err.name, code: err.code || null });
    process.exitCode = 1;
  }
}

module.exports = { options, runCase };
