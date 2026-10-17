// Codex CLI 版本探测与能力判定：用于决定能否使用 provider 级 model_catalog_url。
const { spawnSync } = require('node:child_process');

// 中文注释：provider 级模型目录 URL 的最低支持版本
const MIN_PROVIDER_CATALOG = { major: 0, minor: 156 };

// 中文注释：本工具实测通过的 Codex CLI 基线版本；升级后如遇异常，可回退到该版本
const VERIFIED_BASELINE = '0.160.1';

// 中文注释：从 `codex --version` 输出里解析版本号
function parse(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw: match[0] };
}

// 中文注释：探测本机 Codex CLI 版本
function detect(options = {}) {
  const bin = options.bin || process.env.CODEX_BIN || 'codex';
  try {
    const result = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeoutMs || 8000,
      shell: process.platform === 'win32',
    });
    const text = String(result.stdout || '') + String(result.stderr || '');
    const version = parse(text);
    if (!version) {
      return { ok: false, raw: text.trim() };
    }
    return Object.assign({ ok: true }, version);
  } catch (err) {
    return { ok: false, raw: String(err && err.message || err) };
  }
}

// 中文注释：是否支持 provider 级模型目录；探测不到时按支持处理，避免误伤新版本
function supportsProviderCatalog(options = {}) {
  const version = options.version || detect(options);
  if (!version.ok) {
    return { ok: true, unknown: true, raw: version.raw };
  }
  const supported = version.major > MIN_PROVIDER_CATALOG.major
    || (version.major === MIN_PROVIDER_CATALOG.major && version.minor >= MIN_PROVIDER_CATALOG.minor);
  return { ok: supported, unknown: false, raw: version.raw, version };
}

module.exports = { MIN_PROVIDER_CATALOG, VERIFIED_BASELINE, parse, detect, supportsProviderCatalog };
