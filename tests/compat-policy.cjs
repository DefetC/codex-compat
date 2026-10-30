// 捕获的破坏：错误过滤官方 include、漏过滤网关 include，或按模型名字错误放行不透明任务。
const assert = require('node:assert/strict');
const { rewriteRequest } = require('../src/rewrite.cjs');

// 官方与第三方共用的 CC Switch 入口，模型名称在这里仅按既有路由约定解释。
const CCS = { mode: 'cc-switch', host: '127.0.0.1', port: 15721, basePath: '/v1' };
// 普通外部 API，即使模型叫 gpt，也不是官方 Codex 接口。
const GATEWAY = { mode: 'url', host: 'gateway.example', port: 443, basePath: '/v1', baseUrl: 'https://gateway.example/v1' };
// 官方 Codex 接口的精确目标，用于核对原生扩展保留。
const NATIVE = { mode: 'url', host: 'chatgpt.com', port: 443, basePath: '/backend-api/codex', baseUrl: 'https://chatgpt.com/backend-api/codex' };
// 合成的形态样本只测试原样透传和拒绝，不声称能被真实服务解密。
const OPAQUE = 'gAAAAAB_SYNTHETIC_TASK_NOT_SERVICE_ISSUED';

// 手工列出的期望值，不用被测策略计算断言。
const CASES = [
  { model: 'gpt-6.1-sol', upstream: CCS, want: ['reasoning.encrypted_content', 'output.encrypted_content', 'future.extension'] },
  { model: 'ccs-deepseek/gpt-6.1-sol', upstream: CCS, want: ['reasoning.encrypted_content', 'future.extension'] },
  { model: 'ccs-deepseek/deepseek-v4.1-flash', upstream: CCS, want: ['reasoning.encrypted_content', 'future.extension'] },
  { model: 'gpt-6.1-sol', upstream: GATEWAY, want: ['reasoning.encrypted_content', 'future.extension'] },
  { model: 'gpt-6.1-sol', upstream: NATIVE, want: ['reasoning.encrypted_content', 'output.encrypted_content', 'future.extension'] },
  { model: 'gpt-6.1-sol', upstream: { ...NATIVE, port: 8443 }, want: ['reasoning.encrypted_content', 'future.extension'] },
  { model: 'vendor/unknown', upstream: GATEWAY, want: ['reasoning.encrypted_content', 'future.extension'] },
  { model: 'gpt-6.1-sol', upstream: GATEWAY, mode: 'preserve', want: ['reasoning.encrypted_content', 'output.encrypted_content', 'future.extension'] },
  { model: 'gpt-6.1-sol', upstream: NATIVE, mode: 'strip', want: ['reasoning.encrypted_content', 'future.extension'] },
];
for (const row of CASES) {
  const body = { model: row.model, include: ['reasoning.encrypted_content', 'output.encrypted_content', 'future.extension'], input: [{ role: 'user', content: [{ type: 'input_text', text: 'output.encrypted_content 是正文，不得删除' }] }] };
  rewriteRequest(body, { upstream: row.upstream, outputTokenReplay: row.mode || 'auto' });
  assert.deepEqual(body.include, row.want, row.model + ' 必须按实际路由处理 include');
  assert.equal(body.input[0].content[0].text, 'output.encrypted_content 是正文，不得删除');
}

// 删除精确选择器的所有重复项，但不得更改历史输出、推理或原生压缩密文。
const history = [
  { type: 'message', role: 'assistant', encrypted_content: 'SYNTHETIC_OUTPUT_HISTORY', content: [{ type: 'output_text', text: '正常回答' }] },
  { type: 'reasoning', encrypted_content: 'SYNTHETIC_REASONING_HISTORY', summary: [] },
  { type: 'compaction', encrypted_content: 'gAAAAAB_SYNTHETIC_COMPACTION' },
];
const body = { model: 'ccs-deepseek/gpt-6.1-sol', include: ['output.encrypted_content', 'reasoning.encrypted_content', 'output.encrypted_content'], input: structuredClone(history) };
const filtered = rewriteRequest(body, { upstream: CCS });
assert.deepEqual(body.include, ['reasoning.encrypted_content']);
assert.deepEqual(filtered.stat.filteredIncludes, ['output.encrypted_content', 'output.encrypted_content']);
assert.deepEqual(body.input, history, 'include 过滤绝不能清理历史密文');

// 不透明委托的放行是明确配置，不能把 gpt 名称等同于当前后端支持。
for (const row of [
  { model: 'gpt-6.1-sol', upstream: CCS, allowed: [], reject: false },
  { model: 'gpt-6.1-sol', upstream: NATIVE, allowed: [], reject: false },
  { model: 'gpt-6.1-sol', upstream: GATEWAY, allowed: [], reject: true },
  { model: 'ccs-deepseek/gpt-6.1-sol', upstream: CCS, allowed: [], reject: true },
  { model: 'ccs-deepseek/gpt-6.1-sol', upstream: CCS, allowed: ['ccs-deepseek/gpt-6.1-sol'], reject: false },
  { model: 'ccs-deepseek/deepseek-v4.1-flash', upstream: CCS, allowed: ['ccs-deepseek/gpt-6.1-sol'], reject: true },
]) {
  const item = { type: 'agent_message', content: [{ type: 'encrypted_content', encrypted_content: OPAQUE }] };
  const request = { model: row.model, input: [structuredClone(item)] };
  const result = rewriteRequest(request, { upstream: row.upstream, opaqueTaskModels: row.allowed });
  assert.equal(result.reject !== null, row.reject, row.model + ' 不透明任务策略');
  assert.deepEqual(request.input, [item], '拒绝或透传均不能破坏原载荷');
}

// 默认明文化覆盖各类父请求，三种工具和嵌套 additional_tools 均需处理。
for (const model of ['gpt-6.1-sol', 'ccs-deepseek/gpt-6.1-sol', 'ccs-deepseek/deepseek-v4.1-flash', 'vendor/other']) {
  const tools = ['spawn_agent', 'send_message', 'followup_task'].map((name) => ({ name, parameters: { properties: { message: { type: 'string', encrypted: true } } } }));
  const request = { model, input: [{ type: 'additional_tools', tools }], tools: [{ type: 'function', name: 'unrelated', parameters: { properties: { message: { encrypted: true } } } }] };
  const result = rewriteRequest(request, { upstream: CCS, stripAlways: true });
  assert.deepEqual(result.stat.stripped, ['spawn_agent', 'send_message', 'followup_task']);
  assert.ok(tools.every((tool) => !Object.prototype.hasOwnProperty.call(tool.parameters.properties.message, 'encrypted')));
  assert.equal(request.tools[0].parameters.properties.message.encrypted, true);
}
// 自检必须真正覆盖新兼容边界，不能在旧五条规则上报告“全通过”。
const checks = require('../src/commands/selftest.cjs').rewriteChecks();
assert.ok(checks.every((row) => row.ok));
assert.ok(checks.some((row) => row.name === 'filter-output-replay' && row.ok));
assert.ok(checks.some((row) => row.name === 'allow-configured-opaque' && row.ok));
console.log('COMPAT_POLICY_TEST_PASS');
