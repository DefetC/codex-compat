// 请求改写核心（纯函数）：便于单测与离线黄金用例。
//
// 阶段 A：默认剥离所有父模型的协作工具 encrypted 标记，从源头生成明文参数。
// 阶段 B：把「明文装在 encrypted_content 容器里」的 agent_message 投影成标准 user 消息。
// 不透明任务按明确路由策略透传或拒绝，原生历史密文不猜测解密。

// 中文注释：只有这三个协作工具的 message 字段带 encrypted 标记
const COLLAB_TOOLS = ['spawn_agent', 'send_message', 'followup_task'];
// 中文注释：官方 Codex opaque 密文的特征前缀（Fernet 格式）
const OPAQUE_PREFIX = 'gAAAAAB';
// 中文注释：默认的第三方模型前缀
const DEFAULT_THIRD_PARTY_PREFIXES = ['ccs-', 'ccs/'];
// 中文注释：官方模型命名特征
const OFFICIAL_PATTERNS = [/^gpt-/, /^codex-/, /^o[0-9]/];
// 此选择器请求额外的输出 token 密文，不代表输入历史中的任何密文字段。
const OUTPUT_ENCRYPTED_INCLUDE = 'output.encrypted_content';
const { resolveCompatPolicy } = require('./compat-policy.cjs');
const { TextDecoder } = require('node:util');
// 只处理已确认是摘要封装的命名空间，不触碰服务原生压缩密文。
const COMPACTION_NAMESPACE = 'ccswitch-compaction-';
// 已验证版本的摘要使用 Base64 文本，而不是可跨后端解密的密文。
const COMPACTION_V1 = 'ccswitch-compaction-v1:';
// 拒绝非法 UTF-8，不能用替换字符悄悄丢弃摘要内容。
const SUMMARY_DECODER = new TextDecoder('utf-8', { fatal: true });

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

// 严格核对 Base64 的字母表、填充和未使用位，不能依赖 Buffer 的宽松解码。
function decodeCompactionSummary(value) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || (/[+/]/.test(value) && /[-_]/.test(value))) {
    throw new Error('摘要封装的 Base64 编码非法');
  }
  const standard = value.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Buffer.from(standard, 'base64');
  const canonical = bytes.toString('base64');
  if (canonical.replace(/=+$/, '') !== standard || (value.includes('=') && (value.length % 4 !== 0 || canonical.length !== value.length))) {
    throw new Error('摘要封装的 Base64 填充或内容非法');
  }
  // 严格 UTF-8 校验后仍保留原始空白，仅拒绝没有任何正文的摘要。
  const summary = SUMMARY_DECODER.decode(bytes);
  if (!summary.trim()) {
    throw new Error('摘要封装没有有效正文');
  }
  return summary;
}

// 摘要只降为普通 user 消息；整批校验成功后才替换，损坏时不产生部分上下文。
function normalizeCompactionSummaries(parsed, stat, onError) {
  if (!Array.isArray(parsed.input)) {
    return null;
  }
  const out = [];
  let projected = 0;
  try {
    for (const item of parsed.input) {
      const value = item && item.type === 'compaction' && item.encrypted_content;
      // 原生密文和普通消息不属于已验证的 CC Switch 摘要命名空间。
      if (typeof value !== 'string' || !value.startsWith(COMPACTION_NAMESPACE)) {
        out.push(item);
        continue;
      }
      // 只认已验证版本，未知版本不能被当成空摘要或原生密文放行。
      if (!value.startsWith(COMPACTION_V1)) {
        throw new Error('不支持的 CC Switch 摘要封装版本');
      }
      const summary = decodeCompactionSummary(value.slice(COMPACTION_V1.length));
      out.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: summary }] });
      projected++;
    }
  } catch (err) {
    if (typeof onError === 'function') {
      onError(err);
    } else {
      console.error('[codex-compat] 摘要封装校验失败', err);
    }
    return '兼容层：CC Switch 摘要封装损坏或版本不受支持，请恢复原路由或重新提供有效上下文。';
  }
  if (projected) {
    parsed.input = out;
    stat.compactionSummariesProjected += projected;
  }
  return null;
}

// 中文注释：对单个请求体执行完整改写，返回判定结果与统计
function rewriteRequest(parsed, options = {}) {
  const prefixes = options.thirdPartyPrefixes || DEFAULT_THIRD_PARTY_PREFIXES;
  const stripAlways = options.stripAlways !== false;
  const stat = { stripped: [], projected: 0, opaque: 0, orphanOutputs: 0, filteredIncludes: [], compactionSummariesProjected: 0 };
  const official = isOfficialModel(parsed.model);
  const third = isThirdPartyModel(parsed.model, prefixes);
  const policy = resolveCompatPolicy({ model: parsed.model, official, third }, options.upstream, options);
  // 默认所有父模型都生成明文委托；关闭 always 时保留历史的官方混用检测行为。
  const mixed = stripAlways || (official && hasThirdPartyReference(parsed, prefixes, 0));
  if (mixed) {
    stageA(parsed, stat, 0);
  }
  if (policy.stripOutputInclude && Array.isArray(parsed.include)) {
    // 只删除精确的输出选择器，不建立 allowlist，也不扫描历史密文或用户文本。
    stat.filteredIncludes = parsed.include.filter((value) => value === OUTPUT_ENCRYPTED_INCLUDE);
    if (stat.filteredIncludes.length) {
      parsed.include = parsed.include.filter((value) => value !== OUTPUT_ENCRYPTED_INCLUDE);
    }
  }
  // 经 CC Switch 时保留其摘要协议；绕过它时只还原已验证的文本封装。
  let reject = policy.unwrapCompactionSummary ? normalizeCompactionSummaries(parsed, stat, options.onNormalizationError) : null;
  const ok = reject ? true : stageB(parsed, stat, policy.allowOpaqueTask);
  if (!ok) {
    reject = '兼容层：当前路由策略未允许透传不透明子代理任务，兼容层无法还原其正文。'
      + '请重新派发明文任务，或仅在验证当前上游支持后将精确模型加入 compat.opaqueTaskModels。';
  }
  return { official, third, stat, reject, policy };
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
