// 子代理证据负向回归：父代理复述口令、错误模型或未完成的等待均不得算成功。
const assert = require('node:assert/strict');
const { proveChild } = require('./helpers/child-proof.cjs');

// 完全合成的父子记录，不含真实会话、网关或身份。
const EXPECTED = 'SYNTHETIC_CHILD:83';
// 夹具明确列出独立的孩子来源、真实回答、完成记录和派发/等待工具回参。
function fixture() {
  return {
    parentId: 'synthetic-parent', parentModel: 'gpt-test', childModel: 'vendor/test', expected: EXPECTED,
    sessions: [
      [
        { type: 'session_meta', payload: { id: 'synthetic-parent', source: 'exec' } },
        { type: 'turn_context', payload: { model: 'gpt-test' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-1', arguments: '{}' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'spawn-1', output: '{"task_name":"/root/synthetic-child"}' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', call_id: 'wait-1', arguments: '{}' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'wait-1', output: '{"timed_out":false}' } },
        { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: EXPECTED } },
      ],
      [
        { type: 'session_meta', payload: { id: 'synthetic-child', source: { subagent: { thread_spawn: { parent_thread_id: 'synthetic-parent', agent_path: '/root/synthetic-child' } } } } },
        { type: 'turn_context', payload: { model: 'vendor/test' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: EXPECTED }] } },
        { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: EXPECTED } },
      ],
    ],
  };
}

assert.equal(proveChild(fixture()).ok, true);
// 每个负向夹具只破坏一个必要条件，不能借父代理的口令掩盖孩子失败。
for (const [name, change] of [
  ['只有父代理复述，没有孩子', (data) => data.sessions.pop()],
  ['孩子来源属于别的父代理', (data) => { data.sessions[1][0].payload.source.subagent.thread_spawn.parent_thread_id = 'someone-else'; }],
  ['孩子实际模型错误', (data) => { data.sessions[1][1].payload.model = 'wrong-model'; }],
  ['父代理实际模型错误', (data) => { data.sessions[0][1].payload.model = 'wrong-model'; }],
  ['孩子没有真实回答', (data) => { data.sessions[1].splice(2, 1); }],
  ['孩子回答错误', (data) => { data.sessions[1][2].payload.content[0].text = 'SYNTHETIC_CHILD:37'; }],
  ['孩子没有完成记录', (data) => data.sessions[1].pop()],
  ['父代理没有完成记录', (data) => data.sessions[0].pop()],
  ['父代理没有等待', (data) => { data.sessions[0].splice(4, 2); }],
  ['等待超时', (data) => { data.sessions[0][5].payload.output = '{"timed_out":true}'; }],
  ['派发回参不属于这个孩子', (data) => { data.sessions[0][3].payload.output = '{"task_name":"/root/another-child"}'; }],
  ['孩子仅有完成事件，没有匹配的完成回答', (data) => { data.sessions[1][3].payload.last_agent_message = '错误回答'; }],
]) {
  const data = fixture();
  change(data);
  const result = proveChild(data);
  assert.equal(result.ok, false, name);
  assert.ok(result.reasons.length > 0, name + ' 必须给出失败原因');
}
// 在线驱动不得默默使用旧 CLI 或把既有身份发送到远程地址。
const { options } = require('./regression.cjs');
assert.throws(() => options({}), /CODEX_BIN/);
assert.throws(() => options({ CODEX_BIN: 'synthetic-cli', CODEX_TEST_BASE_URL: 'https://gateway.example/v1' }), /本机代理/);
const isolated = options({ CODEX_BIN: 'synthetic-cli', CODEX_TEST_AUTH_FILE: __filename, CODEX_HOME: 'synthetic-user-main-home' });
assert.equal(isolated.home, undefined, '驱动必须自行创建临时 home，不能使用用户主 home');
// 派发诊断只保留口令命中和正文指纹，失败时不能依赖父代理复述来定位问题。
const diagnostic = fixture();
diagnostic.sessions[0][2].payload.arguments = JSON.stringify({ message: '只回复 ' + EXPECTED });
// 正确任务的安全派发诊断。
const diagnosticProof = proveChild(diagnostic);
assert.equal(diagnosticProof.dispatchedTask.containsExpected, true);
assert.match(diagnosticProof.dispatchedTask.messageHash, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(diagnosticProof.dispatchedTask).includes('只回复'), false, '诊断不能记录任务正文');
diagnostic.sessions[0][2].payload.arguments = JSON.stringify({ message: 'SYNTHETIC_WRONG_TASK' });
assert.equal(proveChild(diagnostic).dispatchedTask.containsExpected, false, '必须保留父代理派错任务的证据');
diagnostic.sessions[0][2].payload.arguments = '{}';
assert.equal(proveChild(diagnostic).dispatchedTask.containsExpected, null, '缺少明文不能被当作已确认丢失');
console.log('CHILD_PROOF_TEST_PASS');
