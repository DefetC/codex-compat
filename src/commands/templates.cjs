// 模板与提示词同步命令（第一跳的手动入口）：把包内 templates/ 与 prompts/ 刷新到运行目录。
// 受管语义与自动路径一致：没被本地改过的才刷新，被改过的需要 --force 才覆盖（覆盖前有备份）。
const config = require('../config.cjs');
const templatesLib = require('../templates.cjs');

// 中文注释：状态到中文说明，便于人工阅读
const STATUS_LABEL = {
  current: '与包内一致',
  adoptable: '与包内一致（本次补记所有权）',
  outdated: '包内已更新',
  edited: '本地改过，未覆盖',
  divergent: '与包内不一致且无所有权记录，未覆盖',
  absent: '运行目录缺失',
};

// 中文注释：执行一次刷新；默认按受管语义（等价 auto 策略），--force 连本地改动一起覆盖
async function refresh(opts = {}) {
  const { cfg, error } = config.loadSafe({ home: opts.home });
  const report = templatesLib.sync({
    home: cfg.home,
    policy: 'auto',
    force: !!opts.force,
    dryRun: !!opts.dryRun,
    pkgVersion: config.version(),
  });
  const lines = [templatesLib.describe(report)];
  if (report.backup) {
    lines.push('备份：' + report.backup);
  }
  for (const entry of report.entries) {
    const label = entry.unreadable
      ? '不可读或为链接，未处理（' + entry.unreadable + '）'
      : (STATUS_LABEL[entry.status] || entry.status);
    lines.push('  ' + entry.relative + '：' + label);
  }
  if (report.edited.length && !opts.force) {
    lines.push('如需用包内版本覆盖上面标记为「本地改过」的文件，加 --force（会先备份）。');
  }
  return {
    ok: report.ok !== false,
    code: 'templates-refresh',
    dryRun: !!opts.dryRun,
    changed: report.changed,
    written: report.written,
    adopted: report.adopted,
    edited: report.edited,
    lines,
    report: { policy: report.policy, pkgVersion: report.pkgVersion, entries: report.entries.map((e) => ({ relative: e.relative, status: e.status })) },
  };
}

module.exports = { refresh };
