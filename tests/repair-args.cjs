// 工具参数修复自检：值位置裸词加引号、字符串内部绝不误改、合法字面量不动、修不好就原样返回。
const assert = require('node:assert/strict');
const { repairArguments, repairInputArguments, quoteBarewordValues } = require('../src/repair-args.cjs');

// 中文注释：合法 JSON（含字符串里出现裸词样式）必须原样返回
const validCases = [
  '{"fork_turns": "none"}',
  '{"message": "say: none, ok", "fork_turns": "none"}',
  '{"a": true, "b": false, "c": null}',
  '[]',
];
for (const text of validCases) {
  const result = repairArguments(text);
  assert.equal(result.changed, false, '合法 JSON 不应被改动：' + text);
  assert.equal(result.text, text);
  assert.deepEqual(result.tokens, []);
}

// 中文注释：值位置的裸词被补成字符串
assert.deepEqual(repairArguments('{"fork_turns": none}'), { ok: true, text: '{"fork_turns": "none"}', changed: true, tokens: ['none'] });
assert.deepEqual(repairArguments('{"fork_turns": all}'), { ok: true, text: '{"fork_turns": "all"}', changed: true, tokens: ['all'] });
assert.deepEqual(
  repairArguments('{"reasoning_effort": high, "n": 1}'),
  { ok: true, text: '{"reasoning_effort": "high", "n": 1}', changed: true, tokens: ['high'] },
);

// 中文注释：嵌套对象与数组里的裸词同样处理，多值一次修完
const nested = repairArguments('[{"a": none}, {"b": {"c": off}}]');
assert.equal(nested.changed, true);
assert.equal(nested.text, '[{"a": "none"}, {"b": {"c": "off"}}]');
assert.deepEqual(nested.tokens, ['none', 'off']);

// 中文注释：混合文档 —— 合法字面量不动，只修真正的裸词
const mixed = repairArguments('{"a": true, "b": none, "c": null}');
assert.equal(mixed.text, '{"a": true, "b": "none", "c": null}', '合法字面量不得被加引号');
assert.deepEqual(mixed.tokens, ['none']);

// 中文注释：字符串内部的裸词样式绝不能被改写
const insideString = repairArguments('{"message": "x: none, y", "fork_turns": none}');
assert.equal(insideString.text, '{"message": "x: none, y", "fork_turns": "none"}');
assert.deepEqual(insideString.tokens, ['none']);

// 中文注释：转义引号之后的裸词也不受影响
const escaped = repairArguments('{"message": "quote \\" none", "fork_turns": none}');
assert.equal(escaped.text, '{"message": "quote \\" none", "fork_turns": "none"}');

// 中文注释：修不好就原样返回，绝不产生半成品
for (const text of ['{not json', '{"a": none', 'not json at all', '{"a": "unterminated}']) {
  const result = repairArguments(text);
  assert.equal(result.changed, false, '不可修复时不得改动：' + text);
  assert.equal(result.text, text);
}
assert.deepEqual(repairArguments(''), { ok: false, text: '', changed: false, tokens: [] });
assert.equal(repairArguments(null).changed, false);

// 中文注释：真实事故样本（2026-10-14 / 10-16 两次实测的形态）
const incident = '{"agent_type": "deepseek_auto", "fork_turns": none, "message": "你是执行代理，只读不改。\\n- 路径 D:\\\\Code\\\\Tools\\\\x"}';
const fixed = repairArguments(incident);
assert.equal(fixed.changed, true);
const parsed = JSON.parse(fixed.text);
assert.equal(parsed.fork_turns, 'none');
assert.equal(parsed.agent_type, 'deepseek_auto');
assert.ok(parsed.message.includes('D:\\Code\\Tools\\x'), '正文必须原样保留');

// 中文注释：遍历 input —— 只修 function_call，合法的与非 function_call 项保持逐字节不变
const request = {
  model: 'ccs-deepseek/auto(free)',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fork_turns: none' }] },
    { type: 'function_call', name: 'spawn_agent', call_id: 'c1', arguments: '{"fork_turns": "none"}' },
    { type: 'function_call', name: 'spawn_agent', call_id: 'c2', arguments: '{"agent_type": "deepseek_auto", "fork_turns": none}' },
    { type: 'function_call_output', call_id: 'c2', output: 'failed to parse' },
  ],
};
const repaired = repairInputArguments(request);
assert.equal(repaired.length, 1, '只应报告一条修复');
assert.equal(repaired[0].name, 'spawn_agent');
assert.equal(repaired[0].call_id, 'c2');
assert.deepEqual(repaired[0].tokens, ['none']);
assert.equal(request.input[1].arguments, '{"fork_turns": "none"}', '合法参数必须逐字节不变');
assert.equal(JSON.parse(request.input[2].arguments).fork_turns, 'none');
assert.equal(request.input[0].content[0].text, 'fork_turns: none', '普通消息不得被改动');
assert.equal(repairInputArguments({}).length, 0);
assert.equal(repairInputArguments(null).length, 0);

// 中文注释：扫描器本身只负责加引号，不做校验
const scanned = quoteBarewordValues('{"a": none}');
assert.equal(scanned.text, '{"a": "none"}');

console.log('REPAIR_ARGS_TEST_PASS：裸词加引号、字符串隔离、修不好即原样返回、input 遍历。');
