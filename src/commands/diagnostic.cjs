// 诊断包：收集脱敏后的状态、体检结果与近期日志，便于提交 issue。
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config.cjs');
const { sanitizeText, redactValue, reportRedactionError } = require('../redact.cjs');

// 保留旧文本脱敏接口，结构化快照另在序列化前按字段遮盖。
function sanitize(text) {
  return sanitizeText(text);
}

// 中文注释：生成诊断包目录
async function bundle(opts = {}) {
  const cfg = config.loadSafe({ home: opts.home }).cfg;
  const paths = config.paths(cfg.home);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(cfg.home, 'diagnostics', stamp);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  let omittedLogLines = 0;

  const status = await require('./service.cjs').status({ home: cfg.home });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(redactValue(status.status), null, 2), 'utf8');
  written.push('status.json');

  const doctor = await require('./doctor.cjs').doctor({ home: cfg.home });
  fs.writeFileSync(path.join(dir, 'doctor.txt'), sanitize(doctor.lines.join('\n')), 'utf8');
  written.push('doctor.txt');

  const safeConfig = Object.assign({}, cfg);
  delete safeConfig.home;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(redactValue(safeConfig), null, 2), 'utf8');
  written.push('config.json');

  if (fs.existsSync(paths.logs)) {
    const files = fs.readdirSync(paths.logs).filter((name) => name.endsWith('.jsonl')).sort().slice(-3);
    for (const name of files) {
      const lines = fs.readFileSync(path.join(paths.logs, name), 'utf8').split('\n').filter(Boolean).slice(-500);
      // JSONL 按字段脱敏；损坏行可能带未闭合的正文，明确省略而不是伪装成完整记录。
      const safeLines = lines.map((line) => {
        try {
          return JSON.stringify(redactValue(JSON.parse(line)));
        } catch (err) {
          reportRedactionError(err);
          omittedLogLines++;
          return JSON.stringify({ event: 'diagnostic_line_omitted', reason: 'unparseable_log' });
        }
      });
      fs.writeFileSync(path.join(dir, name), safeLines.join('\n'), 'utf8');
      written.push(name);
    }
  }

  return {
    ok: true,
    code: 'bundle',
    lines: ['诊断包已生成：' + dir, '包含文件：' + written.join(', '), '内容已按规则脱敏，分享前仍须人工检查；不要直接公开。'].concat(omittedLogLines ? ['已省略 ' + omittedLogLines + ' 行无法解析的日志，诊断记录可能不完整。'] : []),
    dir,
    omittedLogLines,
  };
}

module.exports = { bundle, sanitize };
