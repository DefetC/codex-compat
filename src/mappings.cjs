// 中文注释：模型模板映射同步器；只修改明确绑定的模型与角色。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const toml = require('@iarna/toml');
const { isDeepStrictEqual } = require('node:util');
const platform = require('./platform.cjs');
const files = require('./config-files.cjs');
// 中文注释：合法角色名也用于目标文件名，禁止路径穿越。
const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
// 中文注释：所有权记录与启动锁的固定文件名，不含机器专属信息。
const STATE_FILE = '.codex-compat-mappings.json';
const LOCK_FILE = '.codex-compat-mappings.lock';
// 中文注释：上一代工具留下的状态文件命名规律（`.codex-<名字>-mappings.json` / `-roles.json` / `.lock`）。
// 只按规律识别、不写死任何一个具体旧名，既能长期兼容升级，也不在代码里残留无关的第三方名称。
const LEGACY_STATE_PATTERN = /^\.codex-[A-Za-z0-9_-]+-mappings\.json$/;
const LEGACY_ROLES_PATTERN = /^\.codex-[A-Za-z0-9_-]+-roles\.json$/;
const LEGACY_LOCK_PATTERN = /^\.codex-[A-Za-z0-9_-]+-mappings\.lock$/;

// 中文注释：按命名规律查找旧版状态文件；找不到（或目录不可读）返回 null
function findLegacyFile(home, pattern) {
  let names;
  try {
    names = fs.readdirSync(home);
  } catch (err) {
    return null;
  }
  const hit = names.filter((name) => pattern.test(name) && name !== STATE_FILE).sort()[0];
  return hit ? path.join(home, hit) : null;
}

// 中文注释：列出旧版遗留的状态文件（供体检提示清理）；不包含当前使用的文件
function legacyStateFiles(home) {
  let names;
  try {
    names = fs.readdirSync(home);
  } catch (err) {
    return [];
  }
  return names
    .filter((name) => name !== STATE_FILE
      && (LEGACY_STATE_PATTERN.test(name) || LEGACY_ROLES_PATTERN.test(name) || LEGACY_LOCK_PATTERN.test(name)))
    .sort();
}

// 中文注释：解析运行路径；显式选项用于隔离测试和可移植部署。
function options(input = {}) {
  const p = platform.paths(); const home = input.home || platform.codexHome();
  const configFile = path.join(home, 'config.toml');
  const configText = files.read(configFile);
  const configuredCatalog = configText === null ? null : toml.parse(configText).model_catalog_json;
  if (configuredCatalog !== undefined && configuredCatalog !== null && typeof configuredCatalog !== 'string') { throw new Error('model_catalog_json 必须是路径字符串'); }
  // 中文注释：优先使用用户级映射文件，使菜单开关不改动安装目录内容
  const defaultMapping = fs.existsSync(p.mappingFile) ? p.mappingFile : path.join(p.root, 'config/mappings.toml');
  return { ...input, home, mappingFile: path.resolve(input.mappingFile || process.env.CODEX_MAPPING_FILE || defaultMapping),
    catalogFile: path.resolve(input.catalogFile || (configuredCatalog ? path.resolve(home, configuredCatalog) : path.join(home, 'cc-switch-model-catalog.json'))), configFile, stateFile: path.join(home, STATE_FILE),
    backupRoot: input.backupRoot || path.join(p.backups, 'mappings'), logFile: input.logFile || path.join(p.logs, 'mappings.jsonl') };
}
// 中文注释：引用路径以映射根目录为边界，realpath 防止符号链接绕过。
function source(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) { throw new Error('模板引用必须是相对路径'); }
  const file = path.resolve(root, relative); const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { throw new Error('模板引用越界：' + relative); }
  const realRoot = fs.realpathSync(root); const real = fs.realpathSync(file); const realRel = path.relative(realRoot, real);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) { throw new Error('模板链接引用越界：' + relative); }
  return fs.readFileSync(real, 'utf8');
}
// 中文注释：读取配置属性与可信正文；文件引用只允许文本属性路径。
function template(root, relative, identityKeys) {
  const parsed = toml.parse(source(root, relative)); files.validateKeys(parsed);
  if (Object.keys(parsed).some(key => !['settings', 'text_files'].includes(key))) { throw new Error('模板仅支持 settings 与 text_files'); }
  const settings = parsed.settings || {};
  if (!files.object(settings) || !files.object(parsed.text_files || {})) { throw new Error('模板配置必须是表'); }
  for (const [key, relativeFile] of Object.entries(parsed.text_files || {})) {
    const parts = key.split('.');
    if (parts.some(part => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) { throw new Error('非法文本属性路径：' + key); }
    files.validateKeys(Object.fromEntries(parts.map(part => [part, null])));
    if (files.snapshot(settings, parts).exists) { throw new Error('模板属性与正文引用重复：' + key); }
    files.assign(settings, parts, { exists: true, value: source(root, relativeFile) });
  }
  if (identityKeys.some(key => Object.hasOwn(settings, key))) { throw new Error('模板不能覆盖身份字段'); }
  return settings;
}
// 中文注释：全部映射和模板先校验，重复或非法配置不会产生部分写入。
function load(o) {
  const parsed = toml.parse(fs.readFileSync(o.mappingFile, 'utf8')); files.validateKeys(parsed);
  if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) { throw new Error('映射版本或 bindings 无效'); }
  const ids = new Set(); const roles = new Set(); const roleFiles = new Set(); const root = path.dirname(o.mappingFile);
  return parsed.bindings.map(binding => {
    if (Object.keys(binding).some(key => !['model_id', 'model_id_like', 'model_template', 'role_template', 'role_name', 'role_description', 'enabled', 'role_enabled'].includes(key))) { throw new Error('映射包含未知属性'); }
    // 中文注释：model_id（全量）与 model_id_like（末段匹配）至少提供一个
    const hasExact = typeof binding.model_id === 'string' && binding.model_id.trim().length > 0;
    const hasLike = typeof binding.model_id_like === 'string' && binding.model_id_like.trim().length > 0;
    if (!hasExact && !hasLike) { throw new Error('model_id 与 model_id_like 至少配置一个'); }
    if (hasExact && ids.has(binding.model_id)) { throw new Error('模型 ID 无效或重复'); }
    if (hasExact) { ids.add(binding.model_id); }
    if (binding.enabled !== undefined && typeof binding.enabled !== 'boolean') { throw new Error('enabled 必须为布尔值'); }
    if (binding.role_enabled !== undefined && typeof binding.role_enabled !== 'boolean') { throw new Error('role_enabled 必须为布尔值'); }
    if (binding.role_template) {
      if (!ROLE_NAME.test(binding.role_name || '') || roles.has(binding.role_name) || typeof binding.role_description !== 'string' || !binding.role_description.trim()) { throw new Error('角色名称无效或重复'); }
      roles.add(binding.role_name);
      // 中文注释：不同角色名可能生成同一个文件，跨平台按不区分大小写检查。
      const filename = binding.role_name.replace(/_/g, '-').toLowerCase();
      if (roleFiles.has(filename)) { throw new Error('角色目标文件重复'); }
      roleFiles.add(filename);
    } else if (binding.role_name || binding.role_description) { throw new Error('角色配置缺少 role_template'); }
    if (binding.enabled === false) { return binding; }
    const model = template(root, binding.model_template, ['slug']);
    const role = binding.role_template ? template(root, binding.role_template, ['name', 'model', 'description']) : null;
    // 中文注释：developer_instructions 为可选字段；若提供则不能为空
    if (role && role.developer_instructions !== undefined && (typeof role.developer_instructions !== 'string' || !role.developer_instructions.trim())) { throw new Error('角色指导不能为空'); }
    return { ...binding, modelSettings: model, roleSettings: role };
  });
}
// 中文注释：生成受管理文件目标，父目录不能是指向外部的链接。
function roleFile(o, name) {
  if (!ROLE_NAME.test(name)) { throw new Error('角色名称无效'); }
  const dir = path.join(o.home, 'agents');
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) { throw new Error('角色目录是链接，拒绝写入'); }
  return path.join(dir, name.replace(/_/g, '-') + '.toml');
}
// 中文注释：构造同步计划；已有用户角色冲突时跳过整个对应绑定。
// 中文注释：官方模型命名特征；提示词与目录只允许作用于第三方模型
const OFFICIAL_SLUG_PATTERNS = [/^gpt-/, /^codex-/, /^o[0-9]/];

// 中文注释：slug 的最后一段（去掉供应商前缀），用于 like 匹配
function lastSegment(slug) {
  const parts = String(slug).split('/');
  return parts[parts.length - 1];
}

// 中文注释：是否官方模型命名
function isOfficialSlug(slug) {
  return OFFICIAL_SLUG_PATTERNS.some((pattern) => pattern.test(String(slug)));
}

// 中文注释：把 binding 解析到具体 catalog 模型；返回 warning 表示跳过
function resolveTarget(binding, models, claimed) {
  const exact = binding.model_id;
  const like = binding.model_id_like;
  if (exact) {
    const hit = models.find((model) => model.slug === exact);
    if (hit) {
      if (claimed && claimed.has(hit.slug)) {
        return { warning: { code: 'duplicate_target', modelId: hit.slug } };
      }
      return { model: hit, via: 'exact' };
    }
  }
  if (like) {
    const keyword = String(like).toLowerCase();
    const matches = models.filter((model) => lastSegment(model.slug).toLowerCase() === keyword);
    const free = claimed ? matches.filter((model) => !claimed.has(model.slug)) : matches;
    if (free.length === 1) {
      return { model: free[0], via: 'like' };
    }
    if (free.length > 1) {
      return { warning: { code: 'ambiguous_model', modelIdLike: like, matches: free.map((model) => model.slug) } };
    }
    if (matches.length > 0) {
      return { warning: { code: 'duplicate_target', modelIdLike: like, matches: matches.map((model) => model.slug) } };
    }
    return { warning: { code: 'missing_model', modelId: exact || null, modelIdLike: like } };
  }
  return { warning: { code: 'missing_model', modelId: exact || null } };
}

function prepare(o) {
  const bindings = load(o); const catalogText = files.read(o.catalogFile); const configText = files.read(o.configFile);
  if (configText === null) { throw new Error('config.toml 不存在'); }
  // 中文注释：没有模型目录文件时不再抛错，转为明确告警（提示词优化不可用，但不影响兼容层）
  if (catalogText === null) {
    return { warnings: [{ code: 'missing_catalog', detail: '未找到模型目录文件：' + o.catalogFile }], writes: [], modelChanges: [], sections: [], stateChanges: [] };
  }
  const catalog = JSON.parse(catalogText); const originalCatalog = structuredClone(catalog);
  if (!Array.isArray(catalog.models) || catalog.models.some(m => !files.object(m) || typeof m.slug !== 'string') || new Set(catalog.models.map(m => m.slug)).size !== catalog.models.length) { throw new Error('模型目录结构无效或 ID 重复'); }
  const config = toml.parse(configText); let nextConfig = configText;
  const rawState = files.read(o.stateFile);
  // 中文注释：兼容旧版所有权记录，保证升级后仍能识别既有角色
  const legacyStatePath = rawState === null ? findLegacyFile(o.home, LEGACY_STATE_PATTERN) : null;
  const legacyRaw = legacyStatePath === null ? null : files.read(legacyStatePath);
  const state = rawState === null ? (legacyRaw === null ? { version: 1, roles: {} } : JSON.parse(legacyRaw)) : JSON.parse(rawState);
  if (state.version !== 1 || !files.object(state.roles)) { throw new Error('映射所有权记录无效'); }
  // 中文注释：从旧版状态迁移时按「新增」处理，确保新状态文件被真正写出
  const migratedState = rawState === null && legacyRaw !== null;
  const oldState = migratedState ? { version: 1, roles: {} } : structuredClone(state);
  const legacyRolesPath = findLegacyFile(o.home, LEGACY_ROLES_PATTERN);
  const legacyText = legacyRolesPath === null ? null : files.read(legacyRolesPath);
  const legacy = legacyText === null ? { roles: {} } : JSON.parse(legacyText);
  const warnings = []; const writes = []; const sections = [];
  // 中文注释：已认领的模型 slug，保证同一模型只由一个 binding 管理
  const claimed = new Set();
  const v2Before = files.snapshot(config, ['features', 'multi_agent_v2']);
  const v2 = files.object(v2Before.value) ? { ...v2Before.value } : {};
  v2.enabled = true; v2.tool_namespace = 'agents';
  const v2After = { exists: true, value: v2 };
  if (!isDeepStrictEqual(v2Before, v2After)) {
    nextConfig = files.setSection(nextConfig, ['features', 'multi_agent_v2'], v2After);
    sections.push({ path: ['features', 'multi_agent_v2'], before: v2Before, after: v2After });
  }
  for (const binding of bindings) {
    if (binding.enabled === false) { continue; }
    // 中文注释：exact 优先、like（末段精确匹配）兜底；歧义或未命中时跳过并要求改用全量 ID
    const target = resolveTarget(binding, catalog.models, claimed);
    if (target.warning) { warnings.push(target.warning); continue; }
    const model = target.model;
    // 中文注释：官方保护：提示词与目录只允许作用于第三方模型
    if (o.officialGuard !== false && isOfficialSlug(model.slug)) {
      warnings.push({ code: 'official_model_blocked', modelId: model.slug });
      continue;
    }
    claimed.add(model.slug);
    if (binding.roleSettings && binding.role_enabled !== false) {
      const name = binding.role_name; const file = roleFile(o, name); const before = files.read(file);
      const registeredState = files.snapshot(config, ['agents', name]);
      const registered = registeredState.value; const owned = state.roles[name] || legacy.roles?.[name];
      const registeredFile = owned?.registration?.config_file;
      const ownedPath = typeof registeredFile === 'string' && path.resolve(registeredFile) === path.resolve(file);
      // 中文注释：内容漂移（例如工具升级导致模板变化）默认阻止覆盖；
      // 显式 forceRoles 时只允许接管「所有权记录指向本文件」的角色，陌生文件仍然拒绝。
      const contentDrift = (before !== null && files.hash(before) !== (owned && owned.hash))
        || (registeredState.exists && !isDeepStrictEqual(registered, owned && owned.registration));
      // 中文注释：文件与注册都不存在时无需保护，属于首次安装
      const nothingToProtect = before === null && !registeredState.exists;
      if (!nothingToProtect && (!ownedPath || (contentDrift && !o.forceRoles))) {
        warnings.push({ code: 'role_conflict', modelId: model.slug, role: name }); continue;
      }
      const registration = { description: binding.role_description, config_file: file.replace(/\\/g, '/') };
      const content = '# 由 codex-compat 模板映射生成；请修改源模板，不直接修改此文件。\n' + toml.stringify({ ...binding.roleSettings, name, description: binding.role_description, model: model.slug });
      if (before !== content) { writes.push({ kind: 'role', role: name, file, before, after: content }); }
      const a = files.snapshot(config, ['agents', name]); const b = { exists: true, value: registration };
      if (!isDeepStrictEqual(a, b)) { nextConfig = files.setSection(nextConfig, ['agents', name], b); sections.push({ path: ['agents', name], before: a, after: b }); }
      state.roles[name] = { hash: files.hash(content), registration };
    }
    const merged = files.merge(model, binding.modelSettings);
    Object.assign(model, merged);
  }
  const modelChanges = [];
  for (const model of catalog.models) {
    const original = originalCatalog.models.find(m => m.slug === model.slug);
    modelChanges.push(...files.diff(original, model).map(change => ({ ...change, modelId: model.slug })));
  }
  if (modelChanges.length) { writes.push({ kind: 'catalog', file: o.catalogFile, before: catalogText, after: JSON.stringify(catalog, null, 2) + '\n' }); }
  if (nextConfig !== configText) { writes.push({ kind: 'config', file: o.configFile, before: configText, after: nextConfig }); }
  const stateChanges = files.diff(oldState.roles, state.roles);
  if (stateChanges.length) { writes.push({ kind: 'state', file: o.stateFile, before: rawState, after: JSON.stringify(state, null, 2) + '\n' }); }
  return { warnings, writes, modelChanges, sections, stateChanges };
}
// 中文注释：持有进程间排他锁；陈旧锁不自动抢占，避免误判其他同步进程。
function locked(o, action) {
  const lock = path.join(o.home, LOCK_FILE); const fd = fs.openSync(lock, 'wx', 0o600);
  try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, time: new Date().toISOString() })); return action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
// 中文注释：记录小型元数据事件，不记录正文或认证内容。
function log(o, event) {
  fs.mkdirSync(path.dirname(o.logFile), { recursive: true });
  fs.appendFileSync(o.logFile, JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
}
// 中文注释：写前再次比对，先存恢复证据，再原子替换每个文件。
function commit(o, plan, extra = {}) {
  const changeId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID();
  for (const w of plan.writes) { if (files.read(w.file) !== w.before) { throw new Error('写入前检测到外部修改：' + w.file); } }
  const dir = path.join(o.backupRoot, changeId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const journal = { version: 1, changeId, home: path.resolve(o.home), catalogFile: o.catalogFile, status: 'prepared', modelChanges: plan.modelChanges, sections: plan.sections, stateChanges: plan.stateChanges,
    roleChanges: plan.writes.filter(w => w.kind === 'role').map(w => ({ role: w.role, before: w.before, after: w.after })), ...extra };
  const journalFile = path.join(dir, 'transaction.json'); files.atomicWrite(journalFile, JSON.stringify(journal, null, 2));
  for (const [index, w] of plan.writes.entries()) {
    if (files.read(w.file) !== w.before) { throw new Error('写入期间检测到外部修改：' + w.file); }
    if (w.before !== null) { fs.writeFileSync(path.join(dir, index + '-' + path.basename(w.file) + '.bak'), w.before, { mode: 0o600 }); }
    if (w.after === null) {
      // 中文注释：备份后再比对，尽量避免删除回退期间被外部修改的角色。
      if (files.read(w.file) !== w.before) { throw new Error('删除前检测到外部修改：' + w.file); }
      fs.unlinkSync(w.file);
    } else { files.atomicWrite(w.file, w.after, w.before); }
  }
  journal.status = 'committed'; files.atomicWrite(journalFile, JSON.stringify(journal, null, 2));
  log(o, { event: extra.rollbackOf ? 'rollback' : 'applied', changeId, rollbackOf: extra.rollbackOf, backup: dir,
    models: plan.modelChanges.map(c => ({ modelId: c.modelId, path: c.path.join('.'), beforeHash: files.hash(JSON.stringify(c.before)), afterHash: files.hash(JSON.stringify(c.after)) })),
    files: plan.writes.map(w => ({ file: path.relative(o.home, w.file), beforeHash: files.hash(w.before), afterHash: files.hash(w.after) })), warnings: plan.warnings });
  return { ok: !plan.warnings.some(w => w.code === 'role_conflict' || w.code === 'official_model_blocked'), changed: true, changeId, warnings: plan.warnings, files: plan.writes.map(w => w.file), backup: dir };
}
// 中文注释：校验与预演无任何落盘，实际应用只在产生变化时备份及记录日志。
function apply(input = {}) {
  const o = options(input);
  const action = () => {
    const plan = prepare(o);
    // 中文注释：角色冲突与官方模型被拦截都视为需要人工处理的失败
    const blocked = plan.warnings.some(w => w.code === 'role_conflict' || w.code === 'official_model_blocked');
    if (o.dryRun || !plan.writes.length) { return { ok: !blocked, changed: plan.writes.length > 0, warnings: plan.warnings, files: plan.writes.map(w => w.file) }; }
    return commit(o, plan);
  };
  return o.dryRun ? action() : locked(o, action);
}
// 中文注释：回退仅还原受管理值，任一冲突在写入前拒绝，保留无关新配置。
function rollback(input) {
  const o = options(input);
  if (!/^[A-Za-z0-9_-]+$/.test(input.changeId || '')) { throw new Error('变更 ID 无效'); }
  return locked(o, () => {
    const journal = JSON.parse(fs.readFileSync(path.join(o.backupRoot, input.changeId, 'transaction.json'), 'utf8'));
    // 中文注释：首版事务尚未记录目录路径，只允许回退当时固定的默认目录。
    const recordedCatalog = journal.catalogFile || path.resolve(o.home, 'cc-switch-model-catalog.json');
    if (journal.version !== 1 || journal.status !== 'committed' || journal.home !== path.resolve(o.home) || recordedCatalog !== o.catalogFile) { throw new Error('回退记录状态或目标无效'); }
    const catalogText = files.read(o.catalogFile); const catalog = JSON.parse(catalogText); const modelChanges = [];
    for (const c of journal.modelChanges) {
      const model = catalog.models.find(m => m.slug === c.modelId);
      if (!model || !isDeepStrictEqual(files.snapshot(model, c.path), c.after)) { throw new Error('回退冲突，模型属性已改变：' + c.modelId + '/' + c.path.join('.')); }
      files.validateKeys(Object.fromEntries(c.path.map(key => [key, null])));
      files.assign(model, c.path, c.before); modelChanges.push({ ...c, before: c.after, after: c.before });
    }
    const configText = files.read(o.configFile); let nextConfig = configText; const sections = [];
    for (const c of journal.sections.slice().reverse()) {
      if (!(c.path.join('.') === 'features.multi_agent_v2' || (c.path.length === 2 && c.path[0] === 'agents' && ROLE_NAME.test(c.path[1])))) { throw new Error('回退配置目标非法'); }
      if (!isDeepStrictEqual(files.snapshot(toml.parse(nextConfig), c.path), c.after)) { throw new Error('回退冲突，角色或 v2 注册已改变'); }
      nextConfig = files.setSection(nextConfig, c.path, c.before); sections.push({ ...c, before: c.after, after: c.before });
    }
    const writes = [];
    for (const c of journal.roleChanges) {
      const file = roleFile(o, c.role); const current = files.read(file);
      if (current !== c.after) { throw new Error('回退冲突，角色文件已改变：' + c.role); }
      writes.push({ kind: 'role', role: c.role, file, before: current, after: c.before });
    }
    const stateText = files.read(o.stateFile); const state = stateText === null ? { version: 1, roles: {} } : JSON.parse(stateText); const stateChanges = [];
    for (const c of journal.stateChanges) {
      if (!isDeepStrictEqual(files.snapshot(state.roles, c.path), c.after)) { throw new Error('回退冲突，所有权记录已改变'); }
      files.assign(state.roles, c.path, c.before); stateChanges.push({ ...c, before: c.after, after: c.before });
    }
    if (modelChanges.length) { writes.push({ kind: 'catalog', file: o.catalogFile, before: catalogText, after: JSON.stringify(catalog, null, 2) + '\n' }); }
    if (nextConfig !== configText) { writes.push({ kind: 'config', file: o.configFile, before: configText, after: nextConfig }); }
    if (stateChanges.length) { writes.push({ kind: 'state', file: o.stateFile, before: stateText, after: JSON.stringify(state, null, 2) + '\n' }); }
    // 中文注释：删除仅限本次生成且仍与写后内容一致的角色文件，有备份可恢复。
    const result = commit(o, { writes, modelChanges, sections, stateChanges, warnings: [] }, { rollbackOf: input.changeId });
    return result;
  });
}
// 中文注释：读取映射绑定，供菜单展示与开关使用
function readBindings(input = {}) {
  const o = options(input);
  const parsed = toml.parse(fs.readFileSync(o.mappingFile, 'utf8'));
  if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) { throw new Error('映射版本或 bindings 无效'); }
  return { file: o.mappingFile, bindings: parsed.bindings };
}
// 中文注释：写入用户级映射文件；禁止直接改写包内默认文件
function writeBindings(bindings, input = {}) {
  const o = options(input);
  const target = input.mappingFile ? path.resolve(input.mappingFile) : o.mappingFile;
  const packaged = path.join(platform.paths().root, 'config', 'mappings.toml');
  if (path.resolve(target) === path.resolve(packaged)) { throw new Error('拒绝改写包内默认映射，请先运行 codex-compat install 落位用户配置'); }
  const text = toml.stringify({ version: 1, bindings });
  const parsed = toml.parse(text);
  if (parsed.version !== 1 || !Array.isArray(parsed.bindings) || parsed.bindings.length !== bindings.length) { throw new Error('映射序列化结果无效'); }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  return target;
}
// 中文注释：按模型 ID 修改开关；未提供的字段保持不变
function setBindingFlags(input = {}) {
  const current = readBindings(input);
  const bindings = current.bindings.map((binding) => {
    if (input.modelId && binding.model_id !== input.modelId) { return binding; }
    const next = Object.assign({}, binding);
    if (input.enabled !== undefined) { next.enabled = !!input.enabled; }
    if (input.roleEnabled !== undefined) { next.role_enabled = !!input.roleEnabled; }
    return next;
  });
  return writeBindings(bindings, { ...input, mappingFile: input.mappingFile || current.file });
}

module.exports = {
  apply,
  rollback,
  load,
  options,
  readBindings,
  writeBindings,
  setBindingFlags,
  // 中文注释：供目录托管等模块复用同一套解析规则
  resolveTarget,
  isOfficialSlug,
  lastSegment,
  OFFICIAL_SLUG_PATTERNS,
  // 中文注释：供目录托管复用同一套模板解析（settings + text_files）
  loadModelTemplate: (root, relative) => template(root, relative, ['slug']),
  // 中文注释：供体检复用同一套旧版遗留识别规则
  legacyStateFiles,
};
