// 请求改写核心（纯函数）：便于单测与离线黄金用例。
//
// 阶段 A：剥离协作工具 message 字段的 encrypted 标记，让官方后端返回明文参数。
// 阶段 B：把「明文装在 encrypted_content 容器里」的 agent_message 投影成标准 user 消息。
// 阶段 C：真密文（Fernet 前缀）发往第三方下游时显式拒绝，绝不静默投递空任务。

// 中文注释：只有这三个协作工具的 message 字段带 encrypted 标记
const COLLAB_TOOLS = ['spawn_agent', 'send_message', 'followup_task'];
// 中文注释：官方 Codex opaque 密文的特征前缀（Fernet 格式）
const OPAQUE_PREFIX = 'gAAAAAB';
// 中文注释：默认的第三方模型前缀
const DEFAULT_THIRD_PARTY_PREFIXES = ['ccs-', 'ccs/'];
// 中文注释：官方模型命名特征
const OFFICIAL_PATTERNS = [/^gpt-/, /^codex-/, /^o[0-9]/];

// 中文注释：判断是否官方 ChatGPT 模型
function isOfficialModel(model) {
  const value = String(model || '');
  return OFFICIAL_PATTERNS.some((pattern) => pattern.test(value));
}

// 中文注释：判断是否第三方/网关模型，前缀可配置
function isThirdPartyModel(model, prefixes) {
  const value = String(model || '');
  const list = Array.isArray(prefixes) && prefixes.length ? prefixes : DEFAULT_THIRD_PARTY_PREFIXES;
  return list.some((prefix) => value.startsWith(prefix));
}

// 中文注释：检测请求体里是否存在第三方模型引用，用于收窄阶段 A 的作用范围
function hasThirdPartyReference(node, prefixes, depth) {
  if (!node || typeof node !== 'object' || depth > 12) {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((item) => hasThirdPartyReference(item, prefixes, depth + 1));
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (typeof value === 'string' && isThirdPartyModel(value, prefixes)) {
      return true;
    }
    if (value && typeof value === 'object' && hasThirdPartyReference(value, prefixes, depth + 1)) {
      return true;
    }
  }
  return false;
}

// 中文注释：阶段 A 实现
function stageA(node, stat, depth) {
  if (!node || typeof node !== 'object' || depth > 14) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      stageA(item, stat, depth + 1);
    }
    return;
  }
  const name = typeof node.name === 'string' ? node.name : null;
  if (name && COLLAB_TOOLS.includes(name)) {
    const message = node.parameters && node.parameters.properties && node.parameters.properties.message;
    if (message && Object.prototype.hasOwnProperty.call(message, 'encrypted')) {
      delete message.encrypted;
      stat.stripped.push(name);
    }
  }
  for (const key of Object.keys(node)) {
    stageA(node[key], stat, depth + 1);
  }
}

// 中文注释：阶段 B 实现；allowOpaque 为 true 表示下游可解真密文（官方子代理）
function stageB(parsed, stat, allowOpaque) {
  if (!Array.isArray(parsed.input)) {
    return true;
  }
  const out = [];
  let ok = true;
  for (const item of parsed.input) {
    if (item && item.type === 'agent_message' && Array.isArray(item.content)) {
      const texts = [];
      let opaque = false;
      for (const content of item.content) {
        if (content && typeof content.text === 'string') {
          texts.push(content.text);
        } else if (content && content.encrypted_content) {
          const value = String(content.encrypted_content);
          if (value.startsWith(OPAQUE_PREFIX)) {
            opaque = true;
          } else {
            texts.push(value);
          }
        }
      }
      if (opaque) {
        stat.opaque++;
        if (!allowOpaque) {
          ok = false;
        }
        out.push(item);
        continue;
      }
      if (texts.length > 0) {
        out.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: texts.join('\n') }],
        });
        stat.projected++;
        continue;
      }
    }
    out.push(item);
  }
  if (stat.projected > 0) {
    parsed.input = out;
  }
  return ok;
}

// 中文注释：对单个请求体执行完整改写，返回判定结果与统计
function rewriteRequest(parsed, options = {}) {
  const prefixes = options.thirdPartyPrefixes || DEFAULT_THIRD_PARTY_PREFIXES;
  const stripAlways = options.stripAlways !== false;
  const stat = { stripped: [], projected: 0, opaque: 0, orphanOutputs: 0 };
  const official = isOfficialModel(parsed.model);
  const third = isThirdPartyModel(parsed.model, prefixes);
  const mixed = stripAlways || hasThirdPartyReference(parsed, prefixes, 0);
  if (official && mixed) {
    stageA(parsed, stat, 0);
  }
  const ok = stageB(parsed, stat, official);
  let reject = null;
  if (!ok) {
    reject = '兼容层：真密文任务正文无法投递给第三方子代理。'
      + '请确认父请求已启用 encrypted 标记剥离（COMPAT_STRIP_ALWAYS=1），否则子代理会收到空任务。';
  }
  return { official, third, stat, reject };
}

module.exports = {
  COLLAB_TOOLS,
  OPAQUE_PREFIX,
  DEFAULT_THIRD_PARTY_PREFIXES,
  isOfficialModel,
  isThirdPartyModel,
  hasThirdPartyReference,
  stageA,
  stageB,
  rewriteRequest,
};
