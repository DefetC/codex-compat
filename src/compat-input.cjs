// 网关请求输入归一化
//
// 背景：第三方（网关）上游按 Chat 协议校验，role=tool 的消息必须紧跟带 tool_calls 的助手消息。
// Codex 的「从其他任务发送」委派块（如 create_thread 的输出）在新建会话的历史里既没有
// 对应的 function_call，也没有 call_id，直接转发会被上游以 HTTP 400
// “Messages with role 'tool' must be a response to a preceding message with 'tool_calls'” 拒绝。
// 这里把这类孤立 function_call_output 改写成普通 user 消息，保留正文、避免任务丢失。

// 中文注释：兼容字符串与内容分片两种输出形态；空值返回空串
function outputText(output) {
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    return output.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  if (output === null || output === undefined) {
    return '';
  }
  try {
    return JSON.stringify(output);
  } catch (err) {
    return '';
  }
}

// 中文注释：把没有配对 function_call 的输出归一化，返回被改写的条数
function normalizeOrphanToolOutputs(parsed) {
  if (!parsed || !Array.isArray(parsed.input)) {
    return 0;
  }
  // 中文注释：收集本次请求内真实存在的调用 ID
  const callIds = new Set();
  for (const item of parsed.input) {
    if (item && item.type === 'function_call' && typeof item.call_id === 'string' && item.call_id) {
      callIds.add(item.call_id);
    }
  }
  let changed = 0;
  const out = [];
  for (const item of parsed.input) {
    if (item && item.type === 'function_call_output' && !(typeof item.call_id === 'string' && callIds.has(item.call_id))) {
      const text = outputText(item.output);
      if (text) {
        // 中文注释：有正文时转成 user 消息，内容原样保留
        out.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
      }
      // 中文注释：空输出直接移除，既不留孤立 tool 消息也不产生空消息
      changed++;
      continue;
    }
    out.push(item);
  }
  if (changed > 0) {
    parsed.input = out;
  }
  return changed;
}

module.exports = { normalizeOrphanToolOutputs, outputText };
