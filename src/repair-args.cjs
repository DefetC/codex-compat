// 工具调用参数修复（纯函数）：把 JSON 文本里「值位置上的裸词」补成字符串。
//
// 背景：网关模型（如 DeepSeek）偶尔把枚举值写成裸词（`"fork_turns": none`），这是非法 JSON。
// Codex 本地解析会失败、但会把原始坏的 function_call 原样写进会话历史并每次重放，网关于是
// 对整个请求返回 HTTP 400 —— 该会话此后每一轮都失败（2026-10-14、2026-10-16 各一次实测）。
// 提示词加固只能降低概率，不能清零；这里在请求转发前做窄范围修复，让会话不再被一次手滑打死。
//
// 边界：只处理值位置上的裸词（`none` / `all` / `high` 这类标识符），逐字符扫描并跟踪字符串状态，
// 字符串内部（例如 message 正文里的 `: none,`）绝不改动；修完必须能通过 JSON.parse 才采用，
// 否则原样返回交给上层（保持既有行为，不做更激进的重写）。
const IDENT = /[A-Za-z_][A-Za-z0-9_.+-]*/;
// 中文注释：这些裸词本身就是合法 JSON，不需要也不应该加引号
const JSON_LITERALS = new Set(['true', 'false', 'null']);

// 中文注释：逐字符扫描，给值位置的裸词加引号；返回新文本与被改动的词
function quoteBarewordValues(text) {
  const tokens = [];
  let out = '';
  let index = 0;
  let inString = false;
  let escaped = false;
  // 中文注释：文档开头就是在期待一个值；':'、','、'[' 之后同样期待值
  let expectValue = true;
  while (index < text.length) {
    const ch = text[index];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      expectValue = false;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === ':' || ch === ',' || ch === '[') {
      expectValue = true;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === ']') {
      expectValue = false;
      out += ch;
      index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      out += ch;
      index += 1;
      continue;
    }
    if (expectValue && /[A-Za-z_]/.test(ch)) {
      const match = IDENT.exec(text.slice(index));
      const word = match ? match[0] : ch;
      if (JSON_LITERALS.has(word)) {
        out += word;
      } else {
        out += '"' + word + '"';
        tokens.push(word);
      }
      index += word.length;
      expectValue = false;
      continue;
    }
    expectValue = false;
    out += ch;
    index += 1;
  }
  return { text: out, tokens };
}

// 中文注释：修复一段 arguments 文本；解析得通就原样返回
function repairArguments(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, text, changed: false, tokens: [] };
  }
  try {
    JSON.parse(text);
    return { ok: true, text, changed: false, tokens: [] };
  } catch (err) {
    // 中文注释：继续尝试窄范围修复
  }
  const quoted = quoteBarewordValues(text);
  if (!quoted.tokens.length) {
    return { ok: false, text, changed: false, tokens: [] };
  }
  try {
    JSON.parse(quoted.text);
  } catch (err) {
    // 中文注释：修完仍非法（例如还夹了别的语法错误）→ 不采用，保持既有行为
    return { ok: false, text, changed: false, tokens: [] };
  }
  return { ok: true, text: quoted.text, changed: true, tokens: quoted.tokens };
}

// 中文注释：遍历请求体 input，修复所有非法 function_call 参数；返回修复明细
function repairInputArguments(parsed) {
  const repaired = [];
  if (!parsed || !Array.isArray(parsed.input)) {
    return repaired;
  }
  for (const item of parsed.input) {
    if (!item || item.type !== 'function_call' || typeof item.arguments !== 'string') {
      continue;
    }
    const result = repairArguments(item.arguments);
    if (result.changed) {
      item.arguments = result.text;
      repaired.push({ name: typeof item.name === 'string' ? item.name : null, call_id: item.call_id || null, tokens: result.tokens });
    }
  }
  return repaired;
}

module.exports = { repairArguments, repairInputArguments, quoteBarewordValues };
