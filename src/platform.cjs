// 平台适配层：路径解析、系统通知、服务注册与状态查询。
//
//   服务托管  Windows -> 计划任务；macOS -> launchd；Linux -> systemd user unit
//   系统通知  Windows -> 气泡通知；macOS -> osascript；Linux -> notify-send/zenity
//   隐藏启动  Windows -> 动态生成 VBS 启动器，避免控制台窗口闪现
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const config = require('./config.cjs');

// 中文注释：平台判定
const IS_WINDOWS = process.platform === 'win32';
const IS_MACOS = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

// 中文注释：服务与通知使用的标识名；刻意与上一代工具的 CodexCompatLayer/CodexCompatGuard 区分
const SERVICE_NAME = 'CodexCompatService';
const GUARD_NAME = 'CodexCompatServiceGuard';
// 中文注释：旧命名会与上一代工具冲突，仅在明确授权（--cleanup-legacy）或动作指向本运行目录时清理
const LEGACY_TASK_NAMES = ['CodexCompatLayer', 'CodexCompatGuard', 'CodexCompatWatch'];
const MAC_LABEL = 'com.codex-compat';
const MAC_GUARD_LABEL = 'com.codex-compat.guard';
const LINUX_UNIT = 'codex-compat.service';
const LINUX_GUARD_SERVICE = 'codex-compat-guard.service';
const LINUX_GUARD_TIMER = 'codex-compat-guard.timer';

// 中文注释：默认运行目录；只有它才沿用主实例的固定任务名/单元名
function defaultCompatHome() {
  return path.join(os.homedir(), '.codex-compat');
}

// 中文注释：从运行目录推导实例名。
//   instances/<name>/...  → <name>
//   默认运行目录          → main（沿用 CodexCompatService / CodexCompatServiceGuard）
//   其他自定义目录        → path-<目录名>-<路径哈希>，绝不与主实例共用任务名
// 说明：早期实现把所有非 instances 目录都当成 main，导致用临时 CODEX_COMPAT_HOME
// 执行 uninstall/stop 时会删掉真机主实例的计划任务。
function instanceNameOf(home) {
  const value = String(home || '');
  const parts = value.split(/[\\/]/).filter(Boolean);
  const index = parts.lastIndexOf('instances');
  if (index >= 0 && parts.length > index + 1) {
    return parts[index + 1];
  }
  if (!value || path.resolve(value) === path.resolve(defaultCompatHome())) {
    return 'main';
  }
  const base = parts.length ? parts[parts.length - 1] : '';
  const safe = base.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  // 中文注释：带上路径哈希，避免不同自定义目录因为目录名相同而撞名
  const digest = require('node:crypto').createHash('sha1').update(path.resolve(value)).digest('hex').slice(0, 6);
  return 'path-' + (safe || 'custom') + '-' + digest;
}

// 中文注释：按实例派生任务/单元名；main 沿用固定旧名，多开实例带 -<name> 后缀
function namesFor(options = {}) {
  const home = (options.cfg && options.cfg.home) || options.home || config.compatHome();
  const raw = options.instance || instanceNameOf(home);
  const instance = !raw || raw === 'main' ? 'main' : raw;
  const main = instance === 'main';
  return {
    instance,
    service: main ? SERVICE_NAME : SERVICE_NAME + '-' + instance,
    guard: main ? GUARD_NAME : GUARD_NAME + '-' + instance,
    macLabel: main ? MAC_LABEL : MAC_LABEL + '.' + instance,
    macGuardLabel: main ? MAC_GUARD_LABEL : MAC_GUARD_LABEL + '.' + instance,
    linuxUnit: main ? LINUX_UNIT : 'codex-compat-' + instance + '.service',
    linuxGuardService: main ? LINUX_GUARD_SERVICE : 'codex-compat-guard-' + instance + '.service',
    linuxGuardTimer: main ? LINUX_GUARD_TIMER : 'codex-compat-guard-' + instance + '.timer',
  };
}

// 中文注释：最近执行过的系统命令（仅用于 --verbose 展示，最多保留 20 条）
const recentCommands = [];

// 中文注释：记录一条系统命令；脚本过长时截断，避免刷屏
function recordCommand(label, script) {
  recentCommands.push({ label, script: String(script).replace(/\s+/g, ' ').slice(0, 240) });
  if (recentCommands.length > 20) {
    recentCommands.shift();
  }
}

// 中文注释：导出最近命令快照，供 verbose 输出使用
function recentCommandsSnapshot() {
  return recentCommands.slice();
}

// 中文注释：仓库根目录（src 的上一级）
function repoRoot() {
  return path.resolve(__dirname, '..');
}

// 中文注释：Codex 配置目录，优先使用 CODEX_HOME
function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// 中文注释：运行路径集合；运行态统一放在 compat home，不在仓库内落盘
function paths(home) {
  const runtime = config.paths(home);
  const root = repoRoot();
  return Object.assign(runtime, {
    root,
    src: path.join(root, 'src'),
    compatEntry: path.join(root, 'src', 'compat-proxy.cjs'),
    watchdogEntry: path.join(root, 'src', 'watchdog.cjs'),
    guardEntry: path.join(root, 'scripts', 'guard.cjs'),
    config: path.join(codexHome(), 'config.toml'),
    catalog: path.join(codexHome(), 'cc-switch-model-catalog.json'),
  });
}

// 中文注释：转义 PowerShell 单引号字符串里的引号
function escapePs(text) {
  return String(text).replace(/'/g, "''");
}

// 中文注释：VBS 字符串转义；用 Chr(38) 代表 &，避免拼接语义被打破
function vbsString(value) {
  return '"' + String(value).replace(/&/g, '" & Chr(38) & "').replace(/"/g, '""') + '"';
}

// 中文注释：生成隐藏启动器；返回 null 表示生成失败（调用方回退为直接执行）
function writeHiddenLauncher(home, name, nodeExe, scriptPath, extraArgs = []) {
  if (!IS_WINDOWS) {
    return null;
  }
  try {
    const dir = path.join(home, 'run');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name + '.vbs');
    const parts = [vbsString(nodeExe), vbsString(scriptPath)].concat(extraArgs.map((arg) => vbsString(arg)));
    const content = [
      'Option Explicit',
      'Dim shell, cmd',
      'Set shell = CreateObject("WScript.Shell")',
      'shell.CurrentDirectory = ' + vbsString(path.dirname(scriptPath)),
      'cmd = ' + parts.join(' & " " & '),
      'shell.Run cmd, 0, False',
      '',
    ].join('\r\n');
    fs.writeFileSync(file, content, 'ascii');
    return file;
  } catch (err) {
    return null;
  }
}

// 中文注释：Windows 通知脚本；展示时间不宜过长，避免阻塞
function windowsNotifyScript(title, message, seconds) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$ni = New-Object System.Windows.Forms.NotifyIcon',
    '$ni.Icon = [System.Drawing.SystemIcons]::Information',
    "$ni.BalloonTipTitle = '" + escapePs(title) + "'",
    "$ni.BalloonTipText = '" + escapePs(message) + "'",
    '$ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info',
    '$ni.Visible = $true',
    '$ni.ShowBalloonTip(' + seconds * 1000 + ')',
    // 中文注释：留出展示时间，立即释放会导致气泡不显示
    'Start-Sleep -Seconds ' + seconds,
    '$ni.Dispose()',
  ].join('\n');
}

// 中文注释：发送系统通知（同步，适合一次性 CLI）
function notify(title, message) {
  try {
    if (IS_WINDOWS) {
      spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', windowsNotifyScript(title, message, 8)], { windowsHide: true });
      return true;
    }
    if (IS_MACOS) {
      const script = 'display notification "' + String(message).replace(/"/g, '\\"')
        + '" with title "' + String(title).replace(/"/g, '\\"') + '" sound name "Basso"';
      return spawnSync('osascript', ['-e', script]).status === 0;
    }
    if (IS_LINUX) {
      let result = spawnSync('notify-send', ['-u', 'normal', title, message]);
      if (result.error) {
        result = spawnSync('zenity', ['--info', '--title=' + title, '--text=' + message]);
      }
      return result.status === 0;
    }
  } catch (err) {
    // 中文注释：通知失败不影响主流程
  }
  return false;
}

// 中文注释：异步通知，供常驻进程使用，绝不阻塞巡检
function notifyAsync(title, message) {
  try {
    if (IS_WINDOWS) {
      const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', windowsNotifyScript(title, message, 10)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return true;
    }
    if (IS_MACOS) {
      const script = 'display notification "' + String(message).replace(/"/g, '\\"')
        + '" with title "' + String(title).replace(/"/g, '\\"') + '"';
      const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    if (IS_LINUX) {
      const child = spawn('notify-send', ['-u', 'normal', title, message], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
  } catch (err) {
    // 中文注释：通知失败不影响主流程
  }
  return false;
}

// 中文注释：Windows 计划任务状态查询
function windowsTaskStatus(name) {
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$t = Get-ScheduledTask -TaskName '" + escapePs(name) + "'",
    "if ($null -eq $t) { Write-Output 'MISSING'; exit 0 }",
    "$i = Get-ScheduledTaskInfo -TaskName '" + escapePs(name) + "'",
    "Write-Output ('STATE=' + $t.State)",
    "Write-Output ('LAST=' + $i.LastRunTime)",
  ].join('\n');
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, encoding: 'utf8' });
  const output = (result.stdout || '').trim();
  const installed = output.length > 0 && !output.includes('MISSING');
  const running = /STATE=Running/.test(output);
  return { installed, running, detail: output.replace(/\r?\n/g, ' ').trim() || 'unknown' };
}

// 中文注释：读取计划任务动作文本，用来判断该任务是不是本安装目录注册的
function windowsTaskAction(name) {
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$t = Get-ScheduledTask -TaskName '" + escapePs(name) + "'",
    'if ($null -ne $t) { $t.Actions | ForEach-Object { $_.Execute + " " + $_.Arguments } }',
  ].join('\n');
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, encoding: 'utf8' });
  return (result.stdout || '').trim();
}

// 中文注释：清理旧命名任务中「动作指向本运行目录」的那部分，属于本工具自己的残留
function cleanupOwnLegacyTasks(home) {
  if (!IS_WINDOWS) {
    return { removed: [], detail: '仅 Windows 计划任务需要清理' };
  }
  const removed = [];
  for (const name of LEGACY_TASK_NAMES) {
    const action = windowsTaskAction(name);
    if (action && action.includes(home)) {
      spawnSync('powershell', ['-NoProfile', '-Command',
        "Unregister-ScheduledTask -TaskName '" + escapePs(name) + "' -Confirm:$false -ErrorAction SilentlyContinue"
      ], { windowsHide: true });
      removed.push(name);
    }
  }
  return { removed, detail: removed.length ? ('已清理本工具的旧命名任务：' + removed.join(', ')) : '无本工具的旧命名任务' };
}

// 中文注释：强制清理全部旧命名任务（包含其他目录注册的），需要用户显式确认
function cleanupLegacyTasks() {
  if (!IS_WINDOWS) {
    return { removed: [], detail: '仅 Windows 需要清理旧命名任务' };
  }
  const removed = [];
  for (const name of LEGACY_TASK_NAMES) {
    const status = windowsTaskStatus(name);
    if (!status.installed) {
      continue;
    }
    spawnSync('powershell', ['-NoProfile', '-Command',
      "Unregister-ScheduledTask -TaskName '" + escapePs(name) + "' -Confirm:$false -ErrorAction SilentlyContinue"
    ], { windowsHide: true });
    removed.push(name);
  }
  return { removed, detail: removed.length ? ('已清理旧命名任务：' + removed.join(', ')) : '无旧命名任务' };
}

// 中文注释：列出旧命名任务及其动作，供 doctor 提示
function legacyTasks() {
  if (!IS_WINDOWS) {
    return [];
  }
  return LEGACY_TASK_NAMES.map((name) => ({ name, action: windowsTaskAction(name) })).filter((item) => item.action);
}

// 中文注释：注册 Windows 计划任务；hiddenLauncher 为 VBS 路径，null 时直接执行 node
function registerWindowsTask(name, hiddenLauncher, nodeExe, scriptPath, args, triggers) {
  const action = hiddenLauncher
    ? { exe: 'wscript.exe', arg: '"' + hiddenLauncher + '"' }
    : { exe: nodeExe, arg: '"' + scriptPath + '"' + (args.length ? ' ' + args.map((a) => '"' + a + '"').join(' ') : '') };
  const ps = [
    '$action = New-ScheduledTaskAction -Execute \'' + escapePs(action.exe) + '\' -Argument \'' + escapePs(action.arg) + '\'',
    triggers,
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden',
    '$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    'Unregister-ScheduledTask -TaskName \'' + escapePs(name) + '\' -Confirm:$false -ErrorAction SilentlyContinue',
    'Register-ScheduledTask -TaskName \'' + escapePs(name) + '\' -Action $action -Trigger @($triggers) -Settings $settings -Principal $principal -Force | Out-Null',
    'Start-ScheduledTask -TaskName \'' + escapePs(name) + '\'',
  ].join('\n');
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, encoding: 'utf8' });
  recordCommand('register-task:' + name, ps);
  return { ok: result.status === 0, detail: (result.stderr || '').trim() || ('task registered: ' + name) };
}

// 中文注释：把常驻服务注册为登录自启
function installService(options = {}) {
  const cfg = options.cfg || config.loadSafe().cfg;
  const p = paths(cfg.home);
  const nodeExe = process.execPath;
  const args = ['--home', cfg.home];
  const names = namesFor({ cfg });

  if (IS_WINDOWS) {
    const launcher = writeHiddenLauncher(cfg.home, 'watchdog-launch', nodeExe, p.watchdogEntry, args);
    const triggers = '$triggers = New-ScheduledTaskTrigger -AtLogOn';
    return registerWindowsTask(names.service, launcher, nodeExe, p.watchdogEntry, args, triggers);
  }

  if (IS_MACOS) {
    const agentDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(p.logs, { recursive: true });
    const plistPath = path.join(agentDir, names.macLabel + '.plist');
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key><string>' + names.macLabel + '</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      '    <string>' + nodeExe + '</string>',
      '    <string>' + p.watchdogEntry + '</string>',
      '    <string>--home</string>',
      '    <string>' + cfg.home + '</string>',
      '  </array>',
      '  <key>WorkingDirectory</key><string>' + p.root + '</string>',
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      '  <key>StandardOutPath</key><string>' + path.join(p.logs, 'launchd-out.log') + '</string>',
      '  <key>StandardErrorPath</key><string>' + path.join(p.logs, 'launchd-err.log') + '</string>',
      '</dict>',
      '</plist>',
    ].join('\n');
    fs.writeFileSync(plistPath, plist, 'utf8');
    spawnSync('launchctl', ['unload', plistPath]);
    const result = spawnSync('launchctl', ['load', '-w', plistPath]);
    return { ok: result.status === 0, detail: 'launchd agent: ' + plistPath };
  }

  if (IS_LINUX) {
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.mkdirSync(p.logs, { recursive: true });
    const unitPath = path.join(unitDir, names.linuxUnit);
    const unit = [
      '[Unit]',
      'Description=Codex cross-provider subagent compat layer',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'ExecStart=' + nodeExe + ' ' + p.watchdogEntry + ' --home ' + cfg.home,
      'WorkingDirectory=' + p.root,
      'Restart=always',
      'RestartSec=3',
      '',
      '[Install]',
      'WantedBy=default.target',
    ].join('\n');
    fs.writeFileSync(unitPath, unit, 'utf8');
    spawnSync('systemctl', ['--user', 'daemon-reload']);
    const result = spawnSync('systemctl', ['--user', 'enable', '--now', names.linuxUnit]);
    return { ok: result.status === 0, detail: 'systemd user unit: ' + unitPath };
  }

  return { ok: false, detail: 'unsupported platform: ' + process.platform };
}

// 中文注释：移除常驻服务注册
function uninstallService(options = {}) {
  const names = namesFor(options);
  if (IS_WINDOWS) {
    const ps = [
      'Stop-ScheduledTask -TaskName \'' + names.service + '\' -ErrorAction SilentlyContinue',
      'Unregister-ScheduledTask -TaskName \'' + names.service + '\' -Confirm:$false -ErrorAction SilentlyContinue',
    ].join('\n');
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
    recordCommand('unregister-task:' + names.service, ps);
    return { ok: true, detail: 'scheduled task removed: ' + names.service };
  }
  if (IS_MACOS) {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', names.macLabel + '.plist');
    spawnSync('launchctl', ['unload', '-w', plistPath]);
    try { fs.unlinkSync(plistPath); } catch (err) { /* 中文注释：可能不存在 */ }
    return { ok: true, detail: 'launchd agent removed' };
  }
  if (IS_LINUX) {
    spawnSync('systemctl', ['--user', 'disable', '--now', names.linuxUnit]);
    const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', names.linuxUnit);
    try { fs.unlinkSync(unitPath); } catch (err) { /* 中文注释：可能不存在 */ }
    spawnSync('systemctl', ['--user', 'daemon-reload']);
    return { ok: true, detail: 'systemd user unit removed' };
  }
  return { ok: false, detail: 'unsupported platform' };
}

// 中文注释：注册每分钟巡检的守护任务（Windows 走隐藏启动器，不再闪窗）
function registerGuard(options = {}) {
  const cfg = options.cfg || config.loadSafe().cfg;
  const p = paths(cfg.home);
  const nodeExe = process.execPath;
  const args = ['--quiet', '--home', cfg.home];
  const names = namesFor({ cfg });

  if (IS_WINDOWS) {
    const launcher = writeHiddenLauncher(cfg.home, 'guard-launch', nodeExe, p.guardEntry, args);
    const triggers = [
      '$triggers = @(',
      '  (New-ScheduledTaskTrigger -AtLogOn),',
      '  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))',
      ')',
    ].join('\n');
    return registerWindowsTask(names.guard, launcher, nodeExe, p.guardEntry, args, triggers);
  }

  if (IS_MACOS) {
    const agentDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(agentDir, { recursive: true });
    const plistPath = path.join(agentDir, names.macGuardLabel + '.plist');
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key><string>' + names.macGuardLabel + '</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      '    <string>' + nodeExe + '</string>',
      '    <string>' + p.guardEntry + '</string>',
      '    <string>--quiet</string>',
      '    <string>--home</string>',
      '    <string>' + cfg.home + '</string>',
      '  </array>',
      '  <key>WorkingDirectory</key><string>' + p.root + '</string>',
      '  <key>RunAtLoad</key><true/>',
      '  <key>StartInterval</key><integer>60</integer>',
      '</dict>',
      '</plist>',
    ].join('\n');
    fs.writeFileSync(plistPath, plist, 'utf8');
    spawnSync('launchctl', ['unload', plistPath]);
    const result = spawnSync('launchctl', ['load', '-w', plistPath]);
    return { ok: result.status === 0, detail: 'guard launchd: ' + plistPath };
  }

  if (IS_LINUX) {
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, names.linuxGuardService), [
      '[Unit]',
      'Description=Codex compat layer guard',
      '',
      '[Service]',
      'Type=oneshot',
      'ExecStart=' + nodeExe + ' ' + p.guardEntry + ' --quiet --home ' + cfg.home,
      'WorkingDirectory=' + p.root,
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(unitDir, names.linuxGuardTimer), [
      '[Unit]',
      'Description=Run Codex compat guard every minute',
      '',
      '[Timer]',
      'OnBootSec=1min',
      'OnUnitActiveSec=1min',
      '',
      '[Install]',
      'WantedBy=timers.target',
    ].join('\n'), 'utf8');
    spawnSync('systemctl', ['--user', 'daemon-reload']);
    const result = spawnSync('systemctl', ['--user', 'enable', '--now', names.linuxGuardTimer]);
    return { ok: result.status === 0, detail: 'guard timer: ' + names.linuxGuardTimer };
  }

  return { ok: false, detail: 'unsupported platform' };
}

// 中文注释：移除守护任务
function unregisterGuard(options = {}) {
  const names = namesFor(options);
  if (IS_WINDOWS) {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "Unregister-ScheduledTask -TaskName '" + names.guard + "' -Confirm:$false -ErrorAction SilentlyContinue"
    ], { windowsHide: true });
    recordCommand('unregister-task:' + names.guard, 'Unregister-ScheduledTask ' + names.guard);
    return { ok: true, detail: 'guard task removed: ' + names.guard };
  }
  if (IS_MACOS) {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', names.macGuardLabel + '.plist');
    spawnSync('launchctl', ['unload', '-w', plistPath]);
    try { fs.unlinkSync(plistPath); } catch (err) { /* 中文注释：可能不存在 */ }
    return { ok: true, detail: 'guard launchd removed' };
  }
  if (IS_LINUX) {
    spawnSync('systemctl', ['--user', 'disable', '--now', names.linuxGuardTimer]);
    return { ok: true, detail: 'guard timer removed' };
  }
  return { ok: false, detail: 'unsupported platform' };
}

// 中文注释：脱离父进程直接拉起看门狗，用于服务注册失败时的兜底
function startWatchdogDetached(home) {
  const p = paths(home);
  const child = spawn(process.execPath, [p.watchdogEntry, '--home', home], {
    cwd: p.root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: Object.assign({}, process.env, { CODEX_COMPAT_HOME: home }),
  });
  child.unref();
  return { ok: true, detail: 'watchdog spawned detached', pid: child.pid };
}

// 中文注释：服务状态查询
function serviceStatus(instance) {
  const names = namesFor({ instance });
  if (IS_WINDOWS) {
    return windowsTaskStatus(names.service);
  }
  if (IS_MACOS) {
    const result = spawnSync('launchctl', ['list', names.macLabel], { encoding: 'utf8' });
    return { installed: result.status === 0, running: result.status === 0, detail: result.status === 0 ? 'launchd loaded' : 'launchd not loaded' };
  }
  if (IS_LINUX) {
    const result = spawnSync('systemctl', ['--user', 'is-active', names.linuxUnit], { encoding: 'utf8' });
    const state = (result.stdout || '').trim();
    return { installed: state.length > 0, running: state === 'active', detail: state || 'unknown' };
  }
  return { installed: false, running: false, detail: 'unsupported platform' };
}

// 中文注释：守护任务状态查询
function guardStatus(instance) {
  const names = namesFor({ instance });
  if (IS_WINDOWS) {
    return windowsTaskStatus(names.guard);
  }
  if (IS_MACOS) {
    const result = spawnSync('launchctl', ['list', names.macGuardLabel], { encoding: 'utf8' });
    return { installed: result.status === 0, running: result.status === 0, detail: result.status === 0 ? 'guard loaded' : 'guard not loaded' };
  }
  if (IS_LINUX) {
    const result = spawnSync('systemctl', ['--user', 'is-active', names.linuxGuardTimer], { encoding: 'utf8' });
    const state = (result.stdout || '').trim();
    return { installed: state.length > 0, running: state === 'active', detail: state || 'unknown' };
  }
  return { installed: false, running: false, detail: 'unsupported platform' };
}

module.exports = {
  IS_WINDOWS,
  IS_MACOS,
  IS_LINUX,
  SERVICE_NAME,
  GUARD_NAME,
  defaultCompatHome,
  instanceNameOf,
  namesFor,
  MAC_LABEL,
  LINUX_UNIT,
  repoRoot,
  codexHome,
  paths,
  notify,
  notifyAsync,
  writeHiddenLauncher,
  startWatchdogDetached,
  windowsTaskAction,
  cleanupOwnLegacyTasks,
  cleanupLegacyTasks,
  legacyTasks,
  LEGACY_TASK_NAMES,
  recentCommandsSnapshot,
  recordCommand,
  installService,
  uninstallService,
  registerGuard,
  unregisterGuard,
  serviceStatus,
  guardStatus,
};
