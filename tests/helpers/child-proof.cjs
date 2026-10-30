// 严格子代理证据检查：只信独立 rollout 和实际工具回参，不检查父 stdout 的口令。
const fs = require('node:fs');
const path = require('node:path');
// 正文只用于生成诊断指纹，不进入回归记录。
const crypto = require('node:crypto');

// 当前 V2 和传统协作面的真实等待工具名，不用子串猜测普通工具。
const WAIT_TOOLS = [
  // Multi-Agent V2 等待工具。
  'wait_agent',
  // 传统协作面等待工具。
  'wait',
];

// 解析失败保留异常类型，不把可能包含任务正文的 JSON 错误消息打印出来。
function reportProofError(error) {
  console.error('子代理证据解析失败', { name: error.name, code: error.code || null });
}

// 只遍历显式传入的隔离会话目录，不回退到用户主 CODEX_HOME。
function sessionFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sessionFiles(file) : (entry.isFile() && entry.name.endsWith('.jsonl') ? [file] : []);
  });
}

// CLI 退出后读取完整记录；损坏记录必须导致验证失败，不能返回空样本伪装成功。
function readSessions(home) {
  if (!home) {
    throw new Error('子代理证据必须提供隔离 CODEX_HOME');
  }
  return ['sessions', 'archived_sessions'].flatMap((dir) => sessionFiles(path.join(home, dir))).map((file) => {
    try {
      return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    } catch (err) {
      reportProofError(err);
      throw new Error('子代理证据文件损坏：' + file);
    }
  });
}

// 读取某次真正工具调用对应的回参；无法解析时明确判为不可信证据。
function receipt(rows, call, after) {
  const index = rows.findIndex((row, position) => position > after && row.type === 'response_item' && row.payload && row.payload.type === 'function_call_output' && row.payload.call_id === call.call_id);
  if (index < 0) {
    return null;
  }
  try {
    return { index, value: JSON.parse(rows[index].payload.output) };
  } catch (err) {
    reportProofError(err);
    return null;
  }
}

// 只从孩子自己的模型回答读取文本，完成事件或父代理口述不能替代它。
function assistantReplies(rows) {
  return rows.filter((row) => row.type === 'response_item' && row.payload && row.payload.type === 'message' && row.payload.role === 'assistant').map((row) => {
    return (row.payload.content || []).filter((part) => part && part.type === 'output_text' && typeof part.text === 'string').map((part) => part.text).join('\n').trim();
  });
}

// 派发诊断只输出字段形态、正文指纹和口令命中，不记录任务正文，也不改变成功条件。
function dispatchEvidence(call, expected) {
  try {
    const args = JSON.parse(call.arguments);
    const message = args && typeof args.message === 'string' ? args.message : null;
    return { parsed: true, containsExpected: message === null ? null : message.includes(expected), messageHash: message === null ? null : crypto.createHash('sha256').update(message).digest('hex') };
  } catch (err) {
    reportProofError(err);
    return { parsed: false, containsExpected: null, messageHash: null };
  }
}

// 同时核对父子来源、实际模型、派发回参、成功等待、孩子回答和双方完成状态。
function proveChild({ parentId, parentModel, childModel, expected, sessions }) {
  const reasons = [];
  const parent = sessions.find((rows) => rows.some((row) => row.type === 'session_meta' && row.payload && row.payload.id === parentId));
  if (!parent) {
    return { ok: false, reasons: ['missing-parent'] };
  }
  const children = sessions.filter((rows) => rows.some((row) => row.type === 'session_meta' && row.payload && row.payload.source && row.payload.source.subagent && row.payload.source.subagent.thread_spawn && row.payload.source.subagent.thread_spawn.parent_thread_id === parentId));
  if (children.length !== 1) {
    return { ok: false, reasons: ['expected-exactly-one-child'], parentId, children: children.length };
  }
  const child = children[0];
  const meta = child.find((row) => row.type === 'session_meta').payload;
  const agentPath = meta.source.subagent.thread_spawn.agent_path;
  const models = (rows) => rows.filter((row) => row.type === 'turn_context' && row.payload).map((row) => row.payload.model);
  const parentModels = models(parent);
  const childModels = models(child);
  if (!parentModels.length || parentModels.some((model) => model !== parentModel)) {
    reasons.push('wrong-parent-model');
  }
  if (!childModels.length || childModels.some((model) => model !== childModel)) {
    reasons.push('wrong-child-model');
  }
  const expectedText = String(expected).trim();
  const answers = assistantReplies(child);
  if (!answers.includes(expectedText)) {
    reasons.push('missing-child-answer');
  }
  if (!child.some((row) => row.type === 'event_msg' && row.payload && row.payload.type === 'task_complete' && String(row.payload.last_agent_message || '').trim() === expectedText)) {
    reasons.push('child-not-completed');
  }
  if (!parent.some((row) => row.type === 'event_msg' && row.payload && row.payload.type === 'task_complete')) {
    reasons.push('parent-not-completed');
  }
  let dispatchedAt = -1;
  // 原始会话清理后仍可区分父代理派错任务和后续转发问题。
  let dispatchedTask = null;
  for (let index = 0; index < parent.length; index++) {
    const row = parent[index];
    if (row.type !== 'response_item' || !row.payload || row.payload.type !== 'function_call' || row.payload.name !== 'spawn_agent') {
      continue;
    }
    const result = receipt(parent, row.payload, index);
    if (result && result.value && ((agentPath && result.value.task_name === agentPath) || result.value.agent_id === meta.id)) {
      dispatchedAt = result.index;
      dispatchedTask = dispatchEvidence(row.payload, expectedText);
      break;
    }
  }
  if (dispatchedAt < 0) {
    reasons.push('missing-matching-dispatch');
  }
  // 保留安全的等待元数据，失败时能区分没有调用、超时和协议形态变化。
  const waitAttempts = [];
  const waited = dispatchedAt >= 0 && parent.some((row, index) => {
    // 只有派发完成后的真实等待回参才有效。
    if (index <= dispatchedAt || row.type !== 'response_item' || !row.payload || row.payload.type !== 'function_call' || !WAIT_TOOLS.includes(row.payload.name)) {
      return false;
    }
    const result = receipt(parent, row.payload, index);
    waitAttempts.push({ tool: row.payload.name, callId: row.payload.call_id, hasReceipt: !!result, timedOut: result && result.value && typeof result.value.timed_out === 'boolean' ? result.value.timed_out : null, receiptKeys: result && result.value && typeof result.value === 'object' ? Object.keys(result.value) : [] });
    return !!(result && result.value && result.value.timed_out === false);
  });
  if (!waited) {
    reasons.push('missing-completed-wait');
  }
  return { ok: reasons.length === 0, reasons, parentId, childId: meta.id, agentPath, parentModels, childModels, answer: answers.find((answer) => answer === expectedText) || null, childAnswers: answers, childCompletedAnswers: child.filter((row) => row.type === 'event_msg' && row.payload && row.payload.type === 'task_complete').map((row) => row.payload.last_agent_message), dispatched: dispatchedAt >= 0, dispatchedTask, waited, waitAttempts };
}

module.exports = { proveChild, readSessions };
