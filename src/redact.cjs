// 诊断与默认事件日志共用脱敏规则，不把文本正则当作结构化凭据保护的替代品。

// 密钥、任务正文和密文按字段整体遮盖；opaqueTaskModels、tokenCount 等策略和计数保留。
const SENSITIVE_KEY = /^(?:authorization|proxyauthorization|token|tokens|accesstoken|refreshtoken|idtoken|secret|clientsecret|password|apikey|privatekey|signingkey|signature|attestation|encryptedcontent|task|taskbody|summary|message|instructions|baseinstructions|input|output|content|arguments|body|requestbody)$/;
// 文本中的具名凭据是历史日志和体检文字的二次兜底。
const TEXT_CREDENTIAL = /(["']?(?:authorization|proxy[-_]?authorization|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|password|token)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]]+)/gi;

// 错误日志 API 接收原始异常，但不打印可能包含 URL、正文或签发值的 message、stack。
function reportRedactionError(error) {
  console.error('[codex-compat] 脱敏解析异常', { name: error && error.name || 'Error', code: error && error.code === undefined ? null : error && error.code });
}

// 不区分 camelCase、snake_case 和连字符命名的敏感字段。
function sensitiveKey(key) {
  const normalized = String(key).replace(/[-_]/g, '').toLowerCase();
  return SENSITIVE_KEY.test(normalized) || /(?:password|secret|apikey|authtoken)$/.test(normalized);
}

// URL 凭据先按结构遮盖，普通 URL 的原始表示保持不变。
function sanitizeUrl(raw) {
  try {
    const url = new URL(raw);
    let changed = false;
    if (url.username || url.password) {
      url.username = '<redacted>';
      url.password = url.password ? '<redacted>' : '';
      changed = true;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveKey(key)) {
        url.searchParams.set(key, '<redacted>');
        changed = true;
      }
    }
    return changed ? url.toString() : raw;
  } catch (err) {
    reportRedactionError(err);
    // 无法解析的 URL 仍先遮住 userinfo；调用方继续应用文本凭据规则并提示人工检查。
    return raw.replace(/^(https?:\/\/)[^/@]+@/i, (match, scheme) => scheme + '<redacted>@');
  }
}

// 完整遮盖 Bearer、Fernet 和 CC Switch 摘要，不保留尾部填充或可还原片段。
function sanitizeText(text) {
  return String(text)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrl(url))
    .replace(/\bBearer[ \t]+[^\s"'<>;,)}\]]+/gi, 'Bearer <redacted>')
    .replace(TEXT_CREDENTIAL, (match, prefix, value) => prefix + (/^["']/.test(value) ? JSON.stringify('<redacted>') : '<redacted>'))
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '<redacted-key>')
    .replace(/gAAAAAB[A-Za-z0-9_-]+={0,2}/g, '<redacted-cipher>')
    .replace(/ccswitch-compaction-[^:\s"'<>]*:[^\s"'<>;,)}\]]*/g, '<redacted-summary>');
}

// 结构化脱敏后再序列化；不修改原对象，避免诊断顺手改写运行配置。
function redactValue(value) {
  if (typeof value === 'string') {
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sensitiveKey(key) ? '<redacted>' : redactValue(child)]));
  }
  return value;
}

module.exports = { sanitizeText, redactValue, reportRedactionError };
