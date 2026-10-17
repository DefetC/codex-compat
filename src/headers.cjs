// 请求头规范化：清理 hop-by-hop 头并重写 Host，避免分帧冲突与虚拟主机错配。

// 中文注释：RFC 7230 定义的逐跳头，转发时必须剥离
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

// 中文注释：生成转发用请求头；host 指向真实上游
function normalizeHeaders(headers, upstreamHost, upstreamPort) {
  const out = Object.assign({}, headers);
  for (const name of HOP_BY_HOP) {
    delete out[name];
  }
  out.host = upstreamPort ? upstreamHost + ':' + upstreamPort : upstreamHost;
  return out;
}

module.exports = { HOP_BY_HOP, normalizeHeaders };
