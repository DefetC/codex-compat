// 日志查看：默认输出最近 N 行，支持 --follow 持续跟踪。
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config.cjs');

// 中文注释：列出日志文件（按修改时间排序）
function listLogFiles(logDir) {
  if (!fs.existsSync(logDir)) {
    return [];
  }
  return fs.readdirSync(logDir)
    .filter((name) => name.endsWith('.jsonl') || name.endsWith('.log'))
    .map((name) => path.join(logDir, name))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

// 中文注释：读取文件末尾若干行
function tail(file, count) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-count);
}

// 中文注释：日志命令入口
async function logs(opts = {}) {
  const cfg = config.loadSafe({ home: opts.home }).cfg;
  const logDir = config.paths(cfg.home).logs;
  const files = listLogFiles(logDir);
  if (!files.length) {
    return { ok: true, code: 'no-logs', lines: ['暂无日志：' + logDir] };
  }
  const target = opts.file ? path.join(logDir, String(opts.file)) : files[files.length - 1];
  if (!fs.existsSync(target)) {
    return { ok: false, code: 'missing', message: '日志文件不存在：' + target };
  }
  const count = Number(opts.lines || 40);
  const header = ['===== ' + path.basename(target) + '（最近 ' + count + ' 行）====='];
  if (opts.verbose) {
    // 中文注释：--verbose 时补充日志目录与文件数量，便于手工排查
    header.unshift('日志目录：' + logDir);
    header.unshift('日志文件：' + files.length + ' 个');
  }
  const output = header.concat(tail(target, count));
  if (opts.follow) {
    output.push('');
    output.push('（--follow 模式：按 Ctrl+C 退出，新日志会持续输出）');
    process.stdout.write(output.join('\n') + '\n');
    let position = fs.statSync(target).size;
    const timer = setInterval(() => {
      try {
        const size = fs.statSync(target).size;
        if (size > position) {
          const fd = fs.openSync(target, 'r');
          const buffer = Buffer.alloc(size - position);
          fs.readSync(fd, buffer, 0, buffer.length, position);
          fs.closeSync(fd);
          process.stdout.write(buffer.toString('utf8'));
          position = size;
        }
      } catch (err) {
        // 中文注释：文件被轮转时忽略本次读取
      }
    }, 1000);
    timer.unref();
    return { ok: true, code: 'follow', lines: [], follow: true };
  }
  return { ok: true, code: 'logs', lines: output };
}

module.exports = { logs, tail, listLogFiles };
