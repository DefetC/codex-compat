// restore / uninstall / bypass：按安装清单精确回退，冲突时拒绝而不是猜测。
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config.cjs');
const platform = require('../platform.cjs');
const manifestLib = require('../manifest.cjs');
const codexconfig = require('../codexconfig.cjs');
const mappings = require('../mappings.cjs');
const files = require('../config-files.cjs');
const { stop } = require('./service.cjs');

// 中文注释：把 base_url 写回指定地址，写前校验当前值仍是我们管理的地址
function writeBack(configPath, providerKey, target, expectCurrent) {
  const text = fs.readFileSync(configPath, 'utf8');
  const current = codexconfig.readBaseUrl(text, providerKey);
  if (expectCurrent && current !== expectCurrent) {
    throw new Error('config.toml 的 base_url 已被外部修改（当前 ' + current + '），拒绝覆盖');
  }
  const next = codexconfig.writeBaseUrl(text, providerKey, target);
  files.atomicWrite(configPath, next, text);
  return { from: current, to: target };
}

// 中文注释：回滚映射变更
function rollbackMappings(manifest, opts) {
  if (!manifest.appliedChangeId) {
    return { ok: true, detail: '无映射变更需要回滚' };
  }
  try {
    const result = mappings.rollback({ home: platform.codexHome(), changeId: manifest.appliedChangeId });
    return { ok: true, detail: '映射回滚完成（changeId=' + manifest.appliedChangeId + '）', result };
  } catch (err) {
    return { ok: false, detail: '映射回滚失败：' + String(err && err.message || err) };
  }
}

// 中文注释：仅还原 Codex 配置，保留本工具
async function restore(opts = {}) {
  const cfg = config.loadSafe({ home: opts.home }).cfg;
  const paths = config.paths(cfg.home);
  const manifest = manifestLib.read(paths.manifestFile);
  if (!manifest) {
    return { ok: false, code: 'no-manifest', message: '未找到安装清单，无法精确还原。如确需强制还原请加 --force 并手动确认 base_url。' };
  }
  const lines = ['开始还原：'];
  const expected = codexconfig.listenUrl({ listen: { host: manifest.listenHost || cfg.listen.host, port: manifest.listenPort || cfg.listen.port }, upstream: { basePath: (manifest.upstream && manifest.upstream.basePath) || cfg.upstream.basePath } });
  // 中文注释：已经还原过且当前 base_url 不再是兼容层地址时直接返回，保证可重复执行
  if (manifest.installed === false && !opts.force) {
    try {
      const text = fs.readFileSync(manifest.configPath, 'utf8');
      if (codexconfig.readBaseUrl(text, manifest.providerKey) !== expected) {
        return { ok: true, code: 'already-restored', lines: ['配置此前已还原，无需重复操作'] };
      }
    } catch (err) {
      // 中文注释：读取失败继续走正常流程，由后续步骤给出明确错误
    }
  }
  if (manifest.originalBaseUrl && manifest.originalBaseUrl.value) {
    try {
      const done = writeBack(manifest.configPath, manifest.providerKey, manifest.originalBaseUrl.value, opts.force ? null : expected);
      lines.push('  base_url：' + done.from + ' → ' + done.to);
    } catch (err) {
      return { ok: false, code: 'conflict', message: '还原冲突：' + String(err && err.message || err), lines };
    }
  } else {
    lines.push('  清单未记录原始 base_url，跳过 base_url 还原');
  }
  const rolled = rollbackMappings(manifest, opts);
  lines.push('  ' + rolled.detail);
  // 中文注释：回收我们写入的 provider 级扩展键（如 model_catalog_url），冲突则跳过并提示
  for (const extra of (manifest.extraWrites || []).slice().reverse()) {
    try {
      const currentText = fs.readFileSync(manifest.configPath, 'utf8');
      const parsed = require('@iarna/toml').parse(currentText);
      if (!require('node:util').isDeepStrictEqual(files.snapshot(parsed, extra.keys), extra.after)) {
        lines.push('  跳过扩展键回收（已被外部修改）：' + extra.keys.join('.'));
        continue;
      }
      const nextText = files.setSection(currentText, extra.keys, extra.before);
      files.atomicWrite(manifest.configPath, nextText, currentText);
      lines.push('  已回收扩展键：' + extra.keys.join('.'));
    } catch (err) {
      lines.push('  扩展键回收失败：' + extra.keys.join('.') + '（' + String(err && err.message || err) + '）');
    }
  }
  manifestLib.write(paths.manifestFile, Object.assign({}, manifest, { installed: false, restoredAt: new Date().toISOString() }));
  lines.push('  已标记安装清单为 restored');
  lines.push('');
  lines.push('还原完成。重启 Codex 后生效。');
  return { ok: true, code: 'restored', lines, rollback: rolled };
}

// 中文注释：应急旁路：直接把 base_url 指回原上游，保留工具与服务
async function bypass(opts = {}) {
  const cfg = config.loadSafe({ home: opts.home }).cfg;
  const paths = config.paths(cfg.home);
  const manifest = manifestLib.read(paths.manifestFile);
  if (!manifest || !manifest.originalBaseUrl || !manifest.originalBaseUrl.value) {
    return { ok: false, code: 'no-manifest', message: '未找到原始上游地址，无法旁路' };
  }
  const expected = codexconfig.listenUrl({ listen: { host: manifest.listenHost, port: manifest.listenPort }, upstream: { basePath: (manifest.upstream && manifest.upstream.basePath) || cfg.upstream.basePath } });
  const done = writeBack(manifest.configPath, manifest.providerKey, manifest.originalBaseUrl.value, expected);
  return {
    ok: true,
    code: 'bypassed',
    lines: ['已旁路：base_url ' + done.from + ' → ' + done.to, '兼容层仍在运行但不再参与流量；恢复接入请运行 codex-compat repair。'],
  };
}

// 中文注释：卸载：停服务 + 还原 + 可选清理运行目录
async function uninstall(opts = {}) {
  const cfg = config.loadSafe({ home: opts.home }).cfg;
  const stopped = await stop(opts);
  const restored = await restore(opts);
  const lines = stopped.lines.concat([''], restored.lines || []);
  if (!restored.ok && restored.message) {
    lines.push('还原失败：' + restored.message);
  }
  if (opts.purge) {
    try {
      fs.rmSync(config.paths(cfg.home).home, { recursive: true, force: true });
      lines.push('已删除运行目录 ' + config.paths(cfg.home).home);
    } catch (err) {
      lines.push('删除运行目录失败：' + String(err && err.message || err));
    }
  } else {
    lines.push('运行目录保留在 ' + config.paths(cfg.home).home + '（如需删除请加 --purge）');
  }
  return { ok: restored.ok !== false, code: 'uninstalled', lines };
}

module.exports = { restore, uninstall, bypass, writeBack };
