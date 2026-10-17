// PowerShell 调用封装：用 -EncodedCommand 传脚本，彻底避免 Windows 命令行引号转义问题。
const { spawnSync } = require('node:child_process');

// 中文注释：把脚本编码成 UTF-16LE Base64，spawn 时无需再处理任何引号
function encode(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

// 中文注释：同步执行 PowerShell 脚本并返回 spawnSync 结果
function run(script, options = {}) {
  return spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)], Object.assign({
    windowsHide: true,
    encoding: 'utf8',
  }, options));
}

module.exports = { encode, run };
