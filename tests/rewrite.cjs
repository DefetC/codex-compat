// 请求改写自检：阶段 A 剥离 encrypted 标记、阶段 B 投影明文任务、阶段 C 拒绝真密文投递第三方
// 路径约定：本文件位于 tests/，仓库根是上一级
const assert = require('node:assert/strict');
const {
  COLLAB_TOOLS,
  OPAQUE_PREFIX,
  isOfficialModel,
  isThirdPartyModel,
  hasThirdPartyReference,
  rewriteRequest,
} = require('../src/rewrite.cjs');

// 中文注释：官方 opaque 密文样例（Fernet 前缀）
const OPAQUE_SECRET = OPAQUE_PREFIX + 'AAAABBBBCCCCDDDD';

// 中文注释：构造带 encrypted 标记的协作工具定义
function spawnAgentTool() {
  return {
    type: 'function',
    name: 'spawn_agent',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', encrypted: true, description: '任务正文' },
      },
    },
  };
}

// 中文注释：基础契约
assert.deepEqual(COLLAB_TOOLS, ['spawn_agent', 'send_message', 'followup_task']);
assert.equal(OPAQUE_PREFIX, 'gAAAAAB');

// 中文注释：断言 1 —— 官方父请求剥离 spawn_agent 的 encrypted 标记
const officialParent = {
  model: 'gpt-6-luna',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '派发子代理' }] },
  ],
  tools: [spawnAgentTool(), { type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
};
const officialResult = rewriteRequest(officialParent, { stripAlways: true, thirdPartyPrefixes: ['ccs-', 'ccs/'] });
assert.equal(officialResult.official, true);
assert.equal(officialResult.third, false);
assert.deepEqual(officialResult.stat.stripped, ['spawn_agent']);
assert.equal(officialResult.reject, null);
assert.equal(
  Object.prototype.hasOwnProperty.call(officialParent.tools[0].parameters.properties.message, 'encrypted'),
  false,
  'encrypted 标记必须被剥离',
);
// 中文注释：非协作工具的 schema 不受影响
assert.deepEqual(officialParent.tools[1].parameters, { type: 'object' });

// 中文注释：断言 2 —— encrypted_content 里装的是明文时，投影成标准 user 消息
const projectedBody = {
  model: 'gpt-6-luna',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '前缀' }] },
    { type: 'agent_message', id: 'am_1', content: [{ type: 'encrypted_content', encrypted_content: '任务正文A' }] },
  ],
};
const projectedResult = rewriteRequest(projectedBody, {});
assert.equal(projectedResult.stat.projected, 1);
assert.equal(projectedResult.stat.opaque, 0);
assert.equal(projectedResult.reject, null);
assert.deepEqual(projectedBody.input[1], {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '任务正文A' }],
});

// 中文注释：断言 3 —— 第三方子代理 + 真密文必须显式 reject，绝不静默投递空任务
const thirdPartyOpaque = {
  model: 'ccs-deepseek/auto(free)',
  input: [
    { type: 'agent_message', id: 'am_2', content: [{ type: 'encrypted_content', encrypted_content: OPAQUE_SECRET }] },
  ],
};
const thirdPartyResult = rewriteRequest(thirdPartyOpaque, {});
assert.equal(thirdPartyResult.official, false);
assert.equal(thirdPartyResult.third, true);
assert.equal(thirdPartyResult.stat.opaque, 1);
assert.equal(typeof thirdPartyResult.reject, 'string');
assert.ok(thirdPartyResult.reject.length > 0, 'reject 必须给出可读原因');

// 中文注释：断言 4 —— 官方父子代理链路允许透传真密文，且不 reject
const officialOpaque = {
  model: 'gpt-6-luna',
  input: [
    { type: 'agent_message', id: 'am_3', content: [{ type: 'encrypted_content', encrypted_content: OPAQUE_SECRET }] },
  ],
};
const officialOpaqueResult = rewriteRequest(officialOpaque, {});
assert.equal(officialOpaqueResult.official, true);
assert.equal(officialOpaqueResult.stat.opaque, 1);
assert.equal(officialOpaqueResult.reject, null);
// 中文注释：真密文条目保持原样，不做投影
assert.equal(officialOpaque.input[0].type, 'agent_message');

// 中文注释：断言 5 —— 模型识别：ccs-deepseek/xxx 属于第三方，gpt-/codex-/o 开头属于官方
assert.equal(isThirdPartyModel('ccs-deepseek/xxx', undefined), true);
assert.equal(isThirdPartyModel('ccs-deepseek/xxx', ['ccs-', 'ccs/']), true);
assert.equal(isThirdPartyModel('gpt-6-luna', undefined), false);
assert.equal(isOfficialModel('gpt-6-luna'), true);
assert.equal(isOfficialModel('codex-mini-latest'), true);
assert.equal(isOfficialModel('o3'), true);
assert.equal(isOfficialModel('ccs-deepseek/xxx'), false);

// 中文注释：断言 6 —— 自定义 thirdPartyPrefixes 生效，并覆盖默认前缀
const customThird = { model: 'vendor/model-x', input: [] };
const customThirdResult = rewriteRequest(customThird, { thirdPartyPrefixes: ['vendor/'] });
assert.equal(customThirdResult.third, true);
assert.equal(customThirdResult.official, false);
assert.equal(
  isThirdPartyModel('ccs-deepseek/xxx', ['vendor/']),
  false,
  '自定义前缀必须覆盖默认前缀',
);
const customOpaque = {
  model: 'vendor/model-x',
  input: [
    { type: 'agent_message', content: [{ type: 'encrypted_content', encrypted_content: OPAQUE_SECRET }] },
  ],
};
assert.equal(rewriteRequest(customOpaque, { thirdPartyPrefixes: ['vendor/'] }).reject !== null, true);

// 中文注释：断言 7 —— stripAlways=false 时，只有请求体出现第三方引用才剥离
const bodyRefsThirdParty = {
  model: 'gpt-6-luna',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '调度' }] }],
  tools: [spawnAgentTool()],
  agent_config: { model: 'ccs-deepseek/auto(free)' },
};
assert.equal(hasThirdPartyReference(bodyRefsThirdParty, ['ccs-', 'ccs/'], 0), true);
const strippedByReference = rewriteRequest(bodyRefsThirdParty, { stripAlways: false });
assert.deepEqual(strippedByReference.stat.stripped, ['spawn_agent']);

// 中文注释：官方请求且请求体无第三方引用时，放开 stripAlways 也不做剥离
const plainOfficial = {
  model: 'gpt-6-luna',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '普通对话' }] }],
  tools: [spawnAgentTool()],
};
assert.equal(hasThirdPartyReference(plainOfficial, ['ccs-', 'ccs/'], 0), false);
const untouched = rewriteRequest(plainOfficial, { stripAlways: false });
assert.deepEqual(untouched.stat.stripped, []);
assert.equal(plainOfficial.tools[0].parameters.properties.message.encrypted, true);

// 默认明文化必须覆盖第三方父请求，否则它仍会生成跨路由无法交付的委托。
const thirdPartyParent = {
  model: 'ccs-deepseek/auto(free)',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '执行' }] }],
  tools: [spawnAgentTool()],
};
const thirdPartyParentResult = rewriteRequest(thirdPartyParent, { stripAlways: true });
assert.deepEqual(thirdPartyParentResult.stat.stripped, ['spawn_agent']);
assert.equal(Object.prototype.hasOwnProperty.call(thirdPartyParent.tools[0].parameters.properties.message, 'encrypted'), false);
assert.equal(thirdPartyParentResult.reject, null);

console.log('REWRITE_TEST_PASS');
