// 自检：离线改写用例 + 运行态健康检查 + 上游可达性 + 映射预演。
const config = require('../config.cjs');
const platform = require('../platform.cjs');
const ports = require('../ports.cjs');
const mappings = require('../mappings.cjs');
const rewrite = require('../rewrite.cjs');
const { normalizeOrphanToolOutputs } = require('../compat-input.cjs');

// 中文注释：构造带 encrypted 标记的协作工具请求
function collabRequest(model, encryptedContent) {
  return {
    model,
    input: [
      {
        type: 'additional_tools',
        tools: [
          { name: 'spawn_agent', parameters: { properties: { message: { type: 'string', encrypted: true } } } },
        ],
      },
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/child',
        content: [{ type: 'input_text', text: 'Message Type: NEW_TASK' }, { encrypted_content: encryptedContent }],
      },
    ],
  };
}

// 中文注释：逐条执行离线改写用例
function rewriteChecks() {
  const results = [];
  // 官方父请求 + 混合路由：应剥离 encrypted 标记
  const official = collabRequest('gpt-6', '明文任务');
  const r1 = rewrite.rewriteRequest(official, { stripAlways: true });
  results.push({ name: 'strip-official-marker', ok: r1.stat.stripped.length === 1 && official.input[0].tools[0].parameters.properties.message.encrypted === undefined });
  // 明文容器：应投影成 user 消息
  results.push({ name: 'project-plaintext', ok: r1.stat.projected === 1 && r1.reject === null });
  // 真密文 + 第三方下游：应显式拒绝
  const third = collabRequest('ccs-deepseek/deepseek-v4.1-flash', 'gAAAAAB-opaque');
  const r2 = rewrite.rewriteRequest(third, { stripAlways: true });
  results.push({ name: 'reject-opaque-third-party', ok: r2.third === true && !!r2.reject });
  // 真密文 + 官方下游：应放行
  const officialOpaque = collabRequest('gpt-6', 'gAAAAAB-opaque');
  const r3 = rewrite.rewriteRequest(officialOpaque, { stripAlways: true });
  results.push({ name: 'allow-opaque-official', ok: r3.reject === null && r3.stat.opaque === 1 });
  // 孤立工具输出：第三方上游应被归一化
  const orphan = { model: 'ccs-deepseek/deepseek-v4.1-flash', input: [{ type: 'function_call_output', call_id: null, output: '<codex_delegation>hi</codex_delegation>' }] };
  const normalized = normalizeOrphanToolOutputs(orphan);
  results.push({ name: 'normalize-orphan-output', ok: normalized >= 1 });
  return results;
}

// 中文注释：自检入口
async function selftest(opts = {}) {
  const cfg = config.loadSafe({ home: opts.home }).cfg;
  const results = rewriteChecks();
  const probe = await ports.probeCompat(cfg.listen.host, cfg.listen.port);
  results.push({ name: 'health', ok: probe.ours, detail: probe.ours ? 'v' + (probe.data.version || '?') : '无响应' });
  const reachable = await ports.isReachable(cfg.upstream.host, cfg.upstream.port, 2000);
  results.push({ name: 'upstream', ok: reachable, detail: cfg.upstream.host + ':' + cfg.upstream.port });
  try {
    const applied = mappings.apply({ home: platform.codexHome(), mappingFile: config.paths(cfg.home).mappingFile, dryRun: true });
    results.push({ name: 'mappings', ok: applied.ok, detail: '待同步 ' + (applied.changed ? '有' : '无') });
  } catch (err) {
    results.push({ name: 'mappings', ok: false, detail: String(err && err.message || err) });
  }
  const failed = results.filter((item) => !item.ok);
  const lines = ['codex-compat 自检', ''].concat(results.map((item) => (item.ok ? '[通过] ' : '[异常] ') + item.name + (item.detail ? '：' + item.detail : '')));
  lines.push('');
  lines.push(failed.length ? '结论：' + failed.length + ' 项异常。' : '结论：全部通过。');
  return { ok: failed.length === 0, code: failed.length ? 'selftest-failed' : 'selftest-passed', lines, results };
}

module.exports = { selftest, rewriteChecks };
