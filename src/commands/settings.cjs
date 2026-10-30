// 配置读写：config get / set / list，并同步 DeepSeek 开关到映射文件。
const config = require('../config.cjs');
const platform = require('../platform.cjs');
const mappings = require('../mappings.cjs');

// 中文注释：把 "a.b.c" 转成路径数组
function splitKey(key) {
  return String(key).split('.').filter(Boolean);
}

// 中文注释：读取嵌套值
function getPath(object, keys) {
  let current = object;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

// 中文注释：写入嵌套值
function setPath(object, keys, value) {
  let current = object;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

// 中文注释：字面量转换
function coerce(value, key) {
  // 仅已声明的兼容名单支持 JSON 数组，避免把任意配置字符串隐式改成对象。
  if ((key === 'compat.opaqueTaskModels' || key === 'compat.thirdPartyPrefixes') && typeof value === 'string') {
    return JSON.parse(value);
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^-?\d+$/.test(String(value))) {
    return Number(value);
  }
  return value;
}

// 中文注释：配置命令（函数名不能与上面的 config 模块同名，否则模块加载即报重复声明）
async function configCommand(opts = {}) {
  const cfg = config.loadSafe({ home: opts.home }).cfg;
  const action = opts._[1] || 'list';
  const home = cfg.home;

  if (action === 'list') {
    const payload = Object.assign({}, cfg);
    delete payload.home;
    return { ok: true, code: 'config', lines: [JSON.stringify(payload, null, 2)], config: payload };
  }

  if (action === 'get') {
    const value = getPath(cfg, splitKey(opts._[2] || ''));
    return { ok: true, code: 'config', lines: [JSON.stringify(value)], value };
  }

  if (action === 'set') {
    const key = opts._[2];
    if (!key || opts._[3] === undefined) {
      return { ok: false, code: 'usage', message: '用法：codex-compat config set <key> <value>' };
    }
    const keys = splitKey(key);
    setPath(cfg, keys, coerce(opts._[3], key));
    config.save(cfg, home);
    const lines = ['已更新 ' + key + ' = ' + JSON.stringify(getPath(cfg, keys))];
    // 代理兼容策略不管理 Codex 模型目录或角色配置，保存后不得触发无关映射写入。
    if (keys[0] === 'compat') {
      return { ok: true, code: 'config', lines, config: cfg };
    }

    // 中文注释：DeepSeek 开关需同步到用户级映射文件并重新应用
    const mappingFile = config.paths(home).mappingFile;
    try {
      if (keys.join('.') === 'features.deepseekPrompt') {
        mappings.setBindingFlags({ home: platform.codexHome(), mappingFile, enabled: !!cfg.features.deepseekPrompt });
        lines.push('已同步映射 enabled=' + cfg.features.deepseekPrompt);
      } else if (keys.join('.') === 'features.deepseekRoles') {
        mappings.setBindingFlags({ home: platform.codexHome(), mappingFile, roleEnabled: !!cfg.features.deepseekRoles });
        lines.push('已同步映射 role_enabled=' + cfg.features.deepseekRoles);
      }
      const applied = mappings.apply({ home: platform.codexHome(), mappingFile, officialGuard: cfg.features.officialGuard });
      lines.push('映射应用：' + (applied.changed ? '已更新' : '无变化') + (applied.ok ? '' : '（存在告警）'));
    } catch (err) {
      lines.push('映射同步失败：' + String(err && err.message || err));
    }

    if (keys.join('.') === 'listen.port' && opts.apply !== false) {
      lines.push('端口变更需要执行 codex-compat repair 才会改写 Codex base_url 并重启服务。');
    }
    return { ok: true, code: 'config', lines, config: cfg };
  }

  return { ok: false, code: 'usage', message: '可用：config list / config get <key> / config set <key> <value>' };
}

module.exports = { config: configCommand, configCommand, getPath, setPath, coerce };
