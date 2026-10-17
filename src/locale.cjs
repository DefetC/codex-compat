// 语言探测：决定菜单文案用中文还是英文。
//
// 优先级：CODEX_COMPAT_LANG > 缓存到配置的 runtime.lang > 系统区域探测。
const { spawnSync } = require('node:child_process');

// 中文注释：把任意区域标识归一化成 zh / en
function normalize(value) {
  return /^zh/i.test(String(value || '')) ? 'zh' : 'en';
}

// 中文注释：读取系统区域；Windows 下 Intl 常常给出 en-US，因此额外问一次 Get-Culture
function systemLocale() {
  const intl = normalize(Intl.DateTimeFormat().resolvedOptions().locale);
  if (intl === 'zh') {
    return 'zh';
  }
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('powershell', ['-NoProfile', '-Command', "(Get-Culture).Name"], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      const name = (result.stdout || '').trim();
      if (name) {
        return normalize(name);
      }
    } catch (err) {
      // 中文注释：探测失败按 Intl 结果处理
    }
  }
  return intl;
}

// 中文注释：解析最终生效语言
function resolve(cached) {
  if (process.env.CODEX_COMPAT_LANG) {
    return normalize(process.env.CODEX_COMPAT_LANG);
  }
  if (cached && cached !== 'auto') {
    return normalize(cached);
  }
  return systemLocale();
}

module.exports = { normalize, systemLocale, resolve };
