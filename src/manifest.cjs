// 安装清单：记录本次安装改动了什么，供还原与卸载精确回退。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 中文注释：清单结构版本
const VERSION = 1;

// 中文注释：内容哈希，用于判断目标是否被外部修改
function hash(value) {
  return crypto.createHash('sha256').update(value === null ? '<missing>' : value).digest('hex');
}

// 中文注释：读取清单，缺失返回 null
function read(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  const text = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(text);
  if (!parsed || parsed.version !== VERSION || typeof parsed !== 'object') {
    throw new Error('安装清单结构无效：' + file);
  }
  return parsed;
}

// 中文注释：原子写入清单
function write(file, manifest) {
  // 中文注释：结构版本必须由本模块决定，不能被调用方字段覆盖
  const payload = Object.assign({}, manifest, { version: VERSION });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return payload;
}

// 中文注释：删除清单
function remove(file) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

module.exports = { VERSION, hash, read, write, remove };
