#!/usr/bin/env node
// 守护编排：兼容层不在时把它拉起来；可被计划任务高频调用（幂等、无副作用）。
//
// 与旧版的区别：默认经隐藏启动器执行，且不主动抢占焦点。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('../src/config.cjs');
const platform = require('../src/platform.cjs');
const ports = require('../src/ports.cjs');

// 中文注释：命令行参数
const argv = process.argv.slice(2);
function argValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}
const QUIET = argv.includes('--quiet');
const HOME = argValue('--home') || config.compatHome();
const cfg = config.loadSafe({ home: HOME }).cfg;
const P = config.paths(HOME);

// 中文注释：日志
function log(message) {
  if (!QUIET) {
    process.stdout.write('[guard] ' + message + '\n');
  }
  try {
    fs.mkdirSync(P.logs, { recursive: true });
    fs.appendFileSync(path.join(P.logs, 'guard.jsonl'), JSON.stringify({
      ts: new Date().toISOString(),
      platform: process.platform,
      message,
    }) + '\n');
  } catch (err) {
    // 中文注释：日志失败忽略
  }
}

// 中文注释：主流程
async function main() {
  // 0. 有意停止时不介入
  if (config.isIntentionalStopped(HOME)) {
    log('检测到有意停止标记，跳过拉起');
    process.exit(0);
  }
  // 1. 端口正常 -> 无动作
  const probe = await ports.probeCompat(cfg.listen.host, cfg.listen.port);
  if (probe.ours) {
    log('端口 ' + cfg.listen.port + ' 正常');
    process.exit(0);
  }
  log('端口 ' + cfg.listen.port + ' 无兼容层响应，开始拉起');

  // 2. 清理陈旧锁
  try {
    if (fs.existsSync(P.lockFile)) {
      const owner = parseInt(fs.readFileSync(P.lockFile, 'utf8').trim(), 10);
      let alive = false;
      if (Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); alive = true; } catch (err) { alive = false; }
      }
      if (!alive) {
        fs.writeFileSync(P.lockFile, '0', 'utf8');
        log('已清理陈旧锁（原 pid ' + owner + '）');
      }
    }
  } catch (err) {
    // 中文注释：锁清理失败不阻断拉起
  }

  // 3. 服务注册状态
  const status = platform.serviceStatus();
  log('服务状态：' + status.detail);
  if (!status.installed) {
    const result = platform.installService({ cfg });
    log('已注册服务：' + result.detail);
  } else if (!status.running) {
    if (platform.IS_WINDOWS) {
      spawnSync('powershell', ['-NoProfile', '-Command', "Start-ScheduledTask -TaskName '" + platform.SERVICE_NAME + "'"], { windowsHide: true });
    } else if (platform.IS_MACOS) {
      spawnSync('launchctl', ['load', '-w', path.join(require('node:os').homedir(), 'Library', 'LaunchAgents', platform.MAC_LABEL + '.plist')]);
    } else {
      spawnSync('systemctl', ['--user', 'start', platform.LINUX_UNIT]);
    }
    log('已请求启动服务');
  }

  // 4. 等待就绪
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if ((await ports.probeCompat(cfg.listen.host, cfg.listen.port)).ours) {
      log('已恢复，端口 ' + cfg.listen.port + ' 监听中');
      process.exit(0);
    }
  }

  // 5. 兜底：直接以后台进程拉起
  log('服务方式未生效，改用后台进程兜底');
  platform.startWatchdogDetached(HOME);
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if ((await ports.probeCompat(cfg.listen.host, cfg.listen.port)).ours) {
      log('兜底拉起成功');
      process.exit(0);
    }
  }
  log('拉起失败，请查看 logs/watchdog.jsonl');
  process.exit(1);
}

main().catch((err) => {
  log('异常：' + String(err && err.message || err));
  process.exit(1);
});
