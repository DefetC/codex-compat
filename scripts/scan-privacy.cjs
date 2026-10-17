#!/usr/bin/env node
// 隐私扫描：确保发布物里不含内网域名、个人绝对路径与旧工具残留关键词。
//
// 关键词故意用片段拼接，避免扫描脚本本身命中规则。
const fs = require('node:fs');
const path = require('node:path');

// 中文注释：禁止出现的片段（拼接形式，避免本文件自身命中）
const FORBIDDEN = [
  'ctrip' + 'corp',
  'ada-cli-' + 'golang',
  'lark' + 'enterprise',
  'artif' + 'actory',
  'yk' + 'bo',
  'D:/' + 'Users/',
  'C:\\' + 'Users\\',
];

// 中文注释：跳过依赖与运行态目录
const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', 'backups', 'artifacts', 'diagnostics']);

// 中文注释：只扫描文本类文件
const TEXT_EXT = new Set(['.cjs', '.js', '.json', '.md', '.toml', '.yml', '.yaml', '.ps1', '.sh', '.txt', '.jsonl']);

// 中文注释：递归收集文件
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(full, out);
      }
      continue;
    }
    if (TEXT_EXT.has(path.extname(entry.name)) || entry.name === '.gitignore' || entry.name === 'LICENSE') {
      out.push(full);
    }
  }
}

// 中文注释：执行扫描
function main() {
  const root = path.resolve(__dirname, '..');
  const files = [];
  walk(root, files);
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const token of FORBIDDEN) {
      if (text.includes(token)) {
        hits.push({ file: path.relative(root, file), token: token.slice(0, 2) + '***' });
      }
    }
  }
  if (hits.length) {
    for (const hit of hits) {
      process.stderr.write('[隐私扫描] 命中：' + hit.file + '（' + hit.token + '）\n');
    }
    process.exit(1);
  }
  console.log('PRIVACY_SCAN_PASS（已扫描 ' + files.length + ' 个文件，命中 0）');
}

main();
