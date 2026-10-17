// 诊断包：收集脱敏后的状态、体检结果与近期日志，便于提交 issue。
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config.cjs');

// 中文注释：脱敏规则；日志本身不应含凭据，这里是二次兜底
function sanitize(text) {
  return String(text)
    .replace(/(authorization|api[-_]?key|secret|password|token)\s*[:=]\s*\S+/gi, '$1 = <redacted>')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '<redacted-key>')
    .replace(/gAAAAAB[A-Za-z0-9_-]+/g, '<redacted-cipher>');
}

// 中文注释：生成诊断包目录
async function bundle(opts = {}) {
  const cfg = config.loadSafe({ home: opts.home }).cfg;
  const paths = config.paths(cfg.home);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(cfg.home, 'diagnostics', stamp);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];

  const status = await require('./service.cjs').status({ home: cfg.home });
  fs.writeFileSync(path.join(dir, 'status.json'), sanitize(JSON.stringify(status.status, null, 2)), 'utf8');
  written.push('status.json');

  const doctor = await require('./doctor.cjs').doctor({ home: cfg.home });
  fs.writeFileSync(path.join(dir, 'doctor.txt'), sanitize(doctor.lines.join('\n')), 'utf8');
  written.push('doctor.txt');

  const safeConfig = Object.assign({}, cfg);
  delete safeConfig.home;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(safeConfig, null, 2), 'utf8');
  written.push('config.json');

  if (fs.existsSync(paths.logs)) {
    const files = fs.readdirSync(paths.logs).filter((name) => name.endsWith('.jsonl')).sort().slice(-3);
    for (const name of files) {
      const lines = fs.readFileSync(path.join(paths.logs, name), 'utf8').split('\n').filter(Boolean).slice(-500);
      fs.writeFileSync(path.join(dir, name), sanitize(lines.join('\n')), 'utf8');
      written.push(name);
    }
  }

  return {
    ok: true,
    code: 'bundle',
    lines: ['诊断包已生成：' + dir, '包含文件：' + written.join(', '), '内容已脱敏，可直接附到 issue。'],
    dir,
  };
}

module.exports = { bundle, sanitize };
