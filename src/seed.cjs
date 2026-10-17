// 用户级配置目录：把包内默认的模板与提示词复制到 ~/.codex-compat/config。
//
// 复制后用户级 mappings.toml 的模板相对路径仍然成立，菜单开关只改这一份。
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config.cjs');

// 中文注释：包内默认配置目录
function packageConfigDir() {
  return path.join(config.rootDir(), 'config');
}

// 中文注释：落位用户级配置；已存在且未指定 force 时不覆盖
function seed(home, options = {}) {
  const target = config.paths(home).configDir;
  const mapping = path.join(target, 'mappings.toml');
  if (fs.existsSync(mapping) && !options.force) {
    return { created: false, target, mapping };
  }
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(packageConfigDir(), target, { recursive: true, force: !!options.force, errorOnExist: false });
  return { created: true, target, mapping };
}

module.exports = { packageConfigDir, seed };
