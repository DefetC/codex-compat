// 轻量参数解析：支持 --flag、--key value、--key=value 与 --no-flag。

// 中文注释：把 kebab-case 转成 camelCase
function camel(name) {
  return String(name).replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

// 中文注释：解析 argv，位置参数放入 _
function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token === 'string' && token.startsWith('--')) {
      const eq = token.indexOf('=');
      const rawName = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      let value;
      if (eq >= 0) {
        value = token.slice(eq + 1);
      } else if (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--')) {
        value = argv[++i];
      } else {
        value = true;
      }
      if (rawName.startsWith('no-')) {
        out[camel(rawName.slice(3))] = false;
      } else {
        out[camel(rawName)] = value;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

module.exports = { parse, camel };
