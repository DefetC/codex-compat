// 进程管理：只识别并结束「本安装目录」下的兼容层进程。
//
// 关键点：Windows 命令行里的路径是单反斜杠，构造 PowerShell 正则时不能再做一次转义。
const { spawnSync } = require('node:child_process');
const platform = require('./platform.cjs');
const powershell = require('./powershell.cjs');

// 中文注释：本工具会作为 node 进程出现的脚本名
const SCRIPT_PATTERN = 'watchdog\\.cjs|compat-proxy\\.cjs|guard\\.cjs';

// 中文注释：正则转义，供命令行匹配使用
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 中文注释：列出本安装目录下的兼容层进程
function listProcesses(root, home) {
  const pattern = escapeRegex(root);
  if (platform.IS_WINDOWS) {
    // 中文注释：PowerShell 单引号字符串里反斜杠是字面量，只有单引号需要转义
    const quoted = pattern.replace(/'/g, "''");
    const conditions = ["$_.CommandLine -match '" + SCRIPT_PATTERN + "'", "$_.CommandLine -match '" + quoted + "'"];
    if (home) {
      // 中文注释：同一份代码可能被不同运行目录同时使用，必须用 home 再收窄一次
      conditions.push("$_.CommandLine -match '" + escapeRegex(home).replace(/'/g, "''") + "'");
    }
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue';",
      "Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' |",
      'Where-Object { ' + conditions.join(' -and ') + ' } |',
      'Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress',
    ].join('\n');
    const result = powershell.run(script);
    try {
      const parsed = JSON.parse((result.stdout || '').trim() || '[]');
      return (Array.isArray(parsed) ? parsed : [parsed])
        .filter(Boolean)
        .map((item) => ({ pid: Number(item.ProcessId), cmd: item.CommandLine }));
    } catch (err) {
      return [];
    }
  }
  const result = spawnSync('pgrep', ['-af', SCRIPT_PATTERN], { encoding: 'utf8' });
  return String(result.stdout || '').split('\n').filter(Boolean)
    .filter((line) => line.includes(root))
    .map((line) => {
      const index = line.indexOf(' ');
      return { pid: Number(line.slice(0, index)), cmd: line.slice(index + 1) };
    })
    .filter((item) => Number.isInteger(item.pid));
}

// 中文注释：结束单个进程
function killProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (platform.IS_WINDOWS) {
    spawnSync('powershell', ['-NoProfile', '-Command', 'Stop-Process -Id ' + pid + ' -Force -ErrorAction SilentlyContinue'], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    // 中文注释：进程可能已退出
  }
}

// 中文注释：结束本安装目录下的全部兼容层进程，并复核是否真的清干净
async function killInstance(root, home, options = {}) {
  const before = listProcesses(root, home);
  for (const item of before) {
    killProcess(item.pid);
  }
  const waitMs = Number(options.waitMs || 2000);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const after = listProcesses(root, home);
  return {
    killed: before.map((item) => item.pid),
    remaining: after.map((item) => item.pid),
  };
}

module.exports = { SCRIPT_PATTERN, escapeRegex, listProcesses, killProcess, killInstance };
