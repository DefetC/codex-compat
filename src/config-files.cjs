// 中文注释：配置文件的校验、局部 TOML 编辑与原子写入。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const toml = require('@iarna/toml');
const { isDeepStrictEqual } = require('node:util');

// 中文注释：生成内容指纹，不把正文输出到日志。
function hash(value) { return crypto.createHash('sha256').update(value === null ? '<missing>' : value).digest('hex'); }
// 中文注释：读取文件，不存在与空文件明确区分；拒绝通过目标链接覆盖其他文件。
function read(file) {
  if (!fs.existsSync(file)) { return null; }
  if (fs.lstatSync(file).isSymbolicLink()) { throw new Error('目标文件是链接，拒绝写入：' + file); }
  return fs.readFileSync(file, 'utf8');
}
// 中文注释：结构化配置只能含普通属性，阻止原型污染。
function validateKeys(value) {
  if (!value || typeof value !== 'object') { return; }
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) { throw new Error('非法配置属性：' + key); }
    validateKeys(item);
  }
}
// 中文注释：仅把普通对象视为可递归合并的配置表，数组按完整值处理。
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
// 中文注释：读取属性快照，保留缺失与显式空值的区别。
function snapshot(root, keys) {
  let value = root;
  for (const key of keys) {
    if (!object(value) || !Object.hasOwn(value, key)) { return { exists: false }; }
    value = value[key];
  }
  return { exists: true, value: structuredClone(value) };
}
// 中文注释：更新指定属性；删除后收起仅由该属性产生的空父对象。
function assign(root, keys, state) {
  let target = root; const parents = [];
  for (const key of keys.slice(0, -1)) {
    if (!object(target[key])) { target[key] = {}; }
    parents.push([target, key]); target = target[key];
  }
  const key = keys[keys.length - 1];
  if (state.exists) { target[key] = structuredClone(state.value); }
  else {
    delete target[key];
    for (const [parent, part] of parents.reverse()) { if (Object.keys(parent[part]).length === 0) { delete parent[part]; } else { break; } }
  }
}
// 中文注释：递归合并模板指定的属性，其他属性保持不变。
function merge(current, settings) {
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(settings)) {
    next[key] = object(value) ? merge(object(next[key]) ? next[key] : {}, value) : structuredClone(value);
  }
  return next;
}
// 中文注释：生成属性级差异，便于局部回退而不是整份覆盖。
function diff(before, after, prefix = []) {
  const result = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = snapshot(before, [key]); const b = snapshot(after, [key]);
    if (isDeepStrictEqual(a, b)) { continue; }
    if (a.exists && b.exists && object(a.value) && object(b.value)) { result.push(...diff(a.value, b.value, [...prefix, key])); }
    else { result.push({ path: [...prefix, key], before: a, after: b }); }
  }
  return result;
}
// 中文注释：局部替换标准 TOML 表或父表中的标量，并验证其他语义未改变。
function setSection(text, keys, state) {
  const before = toml.parse(text); const expected = structuredClone(before);
  const old = snapshot(before, keys);
  if (isDeepStrictEqual(old, state)) { return text; }
  assign(expected, keys, state);
  const section = keys.join('.'); const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^\\[' + escaped + '\\][ \\t]*(?:#[^\\r\\n]*)?\\r?$', 'gm');
  const headers = [...text.matchAll(pattern)];
  if (headers.length > 1) { throw new Error('TOML 表无法安全局部更新：' + section); }
  let next = text;
  if (headers.length) {
    const start = headers[0].index; const bodyStart = start + headers[0][0].length;
    const tail = text.slice(bodyStart); const following = /\n[ \t]*\[/.exec(tail);
    const end = following ? bodyStart + following.index : text.length;
    next = text.slice(0, start) + text.slice(end);
  } else if (old.exists) {
    const parent = keys.slice(0, -1).join('.');
    const parentPattern = new RegExp('^\\[' + parent.replace(/\./g, '\\.') + '\\][ \\t]*(?:#[^\\r\\n]*)?\\r?$', 'm');
    const header = parentPattern.exec(next);
    if (!header) { throw new Error('TOML 标量无法安全局部更新：' + section); }
    const start = header.index + header[0].length; const tail = next.slice(start);
    const following = /\n[ \t]*\[/.exec(tail); const end = following ? start + following.index : next.length;
    const scalar = new RegExp('^[ \\t]*' + keys[keys.length - 1] + '[ \\t]*=[^\\r\\n]*\\r?$', 'gm');
    next = next.slice(0, start) + next.slice(start, end).replace(scalar, '') + next.slice(end);
  }
  if (state.exists && object(state.value)) {
    const rendered = toml.stringify({ placeholder: state.value }).replace(/\[placeholder(?=\]|\.)/g, '[' + section);
    next += '\n' + rendered;
  } else if (state.exists) {
    const parent = keys.slice(0, -1).join('.'); const name = keys[keys.length - 1];
    const header = new RegExp('^\\[' + parent.replace(/\./g, '\\.') + '\\][ \\t]*(?:#[^\\r\\n]*)?\\r?$', 'm');
    const value = toml.stringify({ [name]: state.value }).trim();
    next = header.test(next) ? next.replace(header, match => match + '\n' + value) : next + '\n[' + parent + ']\n' + value + '\n';
  }
  if (!isDeepStrictEqual(toml.parse(next), expected)) { throw new Error('TOML 无法安全局部更新，未写入：' + section); }
  return next;
}
// 中文注释：临时文件与目标同目录，异常时清理临时文件并保留完整错误。
function atomicWrite(file, content, expected) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // 中文注释：准备完成后再次核对，缩小外部写入窗口；不宣称跨进程严格 CAS。
    if (expected !== undefined && read(file) !== expected) { throw new Error('原子替换前检测到外部修改：' + file); }
    fs.renameSync(temp, file);
  }
  catch (err) { console.error('[config] 原子写入失败', err); if (fs.existsSync(temp)) { fs.unlinkSync(temp); } throw err; }
}
module.exports = { hash, read, validateKeys, object, snapshot, assign, merge, diff, setSection, atomicWrite };
