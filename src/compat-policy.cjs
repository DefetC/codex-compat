// 兼容决策只表达已知路由约定，不把模型名称当成历史密文来源证明。

// 输出回放选择器的处理方式；历史中的密文字段不受这个选项影响。
const OUTPUT_REPLAY_POLICIES = Object.freeze({
  // 根据当前转发通道采取保守策略。
  AUTO: 'auto',
  // 仅移除请求额外输出密文的 include 项。
  STRIP: 'strip',
  // 交给用户明确确认支持此扩展的上游。
  PRESERVE: 'preserve',
});
// 压缩处理只改变 HTTP 表示，不改变解压后的 JSON 语义。
const REQUEST_COMPRESSION_POLICIES = Object.freeze({
  // 外部兼容路由使用无压缩正文。
  AUTO: 'auto',
  // 成功解压的正文以 UTF-8 转发。
  DECODE: 'decode',
  // 未发生语义改写时保留原始压缩字节。
  PRESERVE: 'preserve',
});
// 路由类别用于安全决策与元数据日志，不包含地址凭证或请求正文。
const ROUTE_KINDS = Object.freeze({
  // 官方 Codex 原生接口。
  NATIVE: 'native-codex',
  // CC Switch 已有官方模型路由约定。
  CCS_OFFICIAL: 'cc-switch-official',
  // CC Switch 的外部模型路由。
  CCS_EXTERNAL: 'cc-switch-external',
  // 自定义上游，默认不假设支持 Codex 私有扩展。
  EXTERNAL: 'external',
});

// 校验枚举值，避免拼写错误被静默解释成允许或禁用。
function policyValue(value, choices, fallback, key) {
  const selected = value === undefined ? fallback : value;
  if (!Object.values(choices).includes(selected)) {
    throw new Error('compat.' + key + ' 只能是 ' + Object.values(choices).join(' / '));
  }
  return selected;
}

// 判断已经用于转发的目标；baseUrl 的主机字符串不能覆盖实际配置的 socket 主机。
function resolveRouteKind(context, upstream) {
  const target = upstream || { mode: 'cc-switch' };
  const secure = /^https:/i.test(String(target.baseUrl || '')) || target.protocol === 'https:';
  const native = secure && String(target.host || '').toLowerCase() === 'chatgpt.com'
    && Number(target.port) === 443
    && String(target.basePath || '').replace(/\/+$/, '') === '/backend-api/codex';
  // 原生扩展必须对应实际 Codex API 路径，普通 gpt 命名不足以证明能力。
  if (native) {
    return ROUTE_KINDS.NATIVE;
  }
  if (target.mode === 'cc-switch') {
    // 此分支只使用 CC Switch 的现有模型路由约定，不声称不同后端密文能互解。
    return context.official && !context.third ? ROUTE_KINDS.CCS_OFFICIAL : ROUTE_KINDS.CCS_EXTERNAL;
  }
  return ROUTE_KINDS.EXTERNAL;
}

// 决策供纯改写和 HTTP 转发共同使用，避免两处对同一个上游作出不同推断。
function resolveCompatPolicy(context, upstream, compat = {}) {
  const routeKind = resolveRouteKind(context, upstream);
  // 只有已知官方通道默认保留私有扩展，不自动信任外部的 gpt 命名。
  const officialRoute = routeKind === ROUTE_KINDS.NATIVE || routeKind === ROUTE_KINDS.CCS_OFFICIAL;
  const ccSwitch = routeKind === ROUTE_KINDS.CCS_OFFICIAL || routeKind === ROUTE_KINDS.CCS_EXTERNAL;
  // 自动值只在没有显式覆盖时生效。
  const replay = policyValue(compat.outputTokenReplay, OUTPUT_REPLAY_POLICIES, OUTPUT_REPLAY_POLICIES.AUTO, 'outputTokenReplay');
  const compression = policyValue(compat.requestCompression, REQUEST_COMPRESSION_POLICIES, REQUEST_COMPRESSION_POLICIES.AUTO, 'requestCompression');
  const models = compat.opaqueTaskModels === undefined ? [] : compat.opaqueTaskModels;
  if (!Array.isArray(models) || models.some((model) => typeof model !== 'string' || !model || model.trim() !== model || /[*?]/.test(model))) {
    throw new Error('compat.opaqueTaskModels 必须是无通配符的非空模型名称数组');
  }
  return {
    routeKind,
    // 移除的是输出选择器，不是输入历史或上游响应中的密文。
    stripOutputInclude: replay === OUTPUT_REPLAY_POLICIES.STRIP || (replay === OUTPUT_REPLAY_POLICIES.AUTO && !officialRoute),
    allowOpaqueTask: officialRoute || models.includes(String(context.model || '')),
    // 正文已修改时仍由传输层强制移除旧编码声明，preserve 不豁免这一规则。
    decodeRequest: compression === REQUEST_COMPRESSION_POLICIES.DECODE || (compression === REQUEST_COMPRESSION_POLICIES.AUTO && !officialRoute),
    unwrapCompactionSummary: !ccSwitch,
    normalizeOrphanOutputs: !officialRoute,
  };
}

module.exports = { OUTPUT_REPLAY_POLICIES, REQUEST_COMPRESSION_POLICIES, ROUTE_KINDS, resolveRouteKind, resolveCompatPolicy };
