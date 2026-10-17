// 输入归一化自检：委派块等孤立 function_call_output 必须改写为 user 消息，配对输出保持原样
const assert = require('node:assert/strict');
const { normalizeOrphanToolOutputs } = require('../src/compat-input.cjs');

// 中文注释：委派块场景（无 call_id、无对应 function_call），正文必须完整保留
const delegated = {
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '任务' }] },
    { type: 'function_call_output', id: 'fco_1', name: 'create_thread', output: '<codex_delegation>委派正文</codex_delegation>' },
  ],
};
assert.equal(normalizeOrphanToolOutputs(delegated), 1);
assert.deepEqual(delegated.input[1], {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '<codex_delegation>委派正文</codex_delegation>' }],
});

// 中文注释：call_id 配对成功的输出保持原样，不产生改写
const paired = {
  input: [
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: '{}' },
    { type: 'function_call_output', id: 'fco_2', call_id: 'call_1', output: 'ok' },
  ],
};
assert.equal(normalizeOrphanToolOutputs(paired), 0);
assert.equal(paired.input[1].type, 'function_call_output');
assert.equal(paired.input[1].output, 'ok');

// 中文注释：call_id 存在但请求内没有对应调用，同样按孤立输出处理
const dangling = {
  input: [{ type: 'function_call_output', id: 'fco_5', call_id: 'call_missing', output: 'dangling' }],
};
assert.equal(normalizeOrphanToolOutputs(dangling), 1);
assert.equal(dangling.input[0].type, 'message');

// 中文注释：内容分片形态拼接后保留
const parts = {
  input: [{
    type: 'function_call_output',
    id: 'fco_3',
    output: [{ type: 'output_text', text: 'A' }, { type: 'output_text', text: 'B' }],
  }],
};
assert.equal(normalizeOrphanToolOutputs(parts), 1);
assert.equal(parts.input[0].content[0].text, 'AB');

// 中文注释：空输出的孤立项直接移除，避免空消息与孤立 tool 消息
const empty = { input: [{ type: 'function_call_output', id: 'fco_4', output: '' }] };
assert.equal(normalizeOrphanToolOutputs(empty), 1);
assert.equal(empty.input.length, 0);

// 中文注释：非法输入边界不抛错、不改写
assert.equal(normalizeOrphanToolOutputs(null), 0);
assert.equal(normalizeOrphanToolOutputs({ input: 'not-array' }), 0);

console.log('COMPAT_INPUT_TEST_PASS');
