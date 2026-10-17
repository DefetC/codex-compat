// 实例（多开 / lab）命令层：与菜单、CLI 共用同一实现，统一返回 {ok, code, lines}。
//
// 约定：所有子命令都走同一个导出函数 instance(opts)，由位置参数识别具体动作。
const instances = require('../instances.cjs');

// 中文注释：取出 "--" 之后的原始参数，原样透传给 codex；未使用 "--" 时返回空数组
function codexPassthrough(opts = {}) {
  const fromArgv = instances.splitPassthrough(process.argv.slice(2));
  if (fromArgv.tail.length) {
    return fromArgv.tail;
  }
  if (Array.isArray(opts.raw)) {
    return opts.raw.map((item) => String(item));
  }
  return [];
}

// 中文注释：实例子命令分发
async function instance(opts = {}) {
  const home = opts.home ? String(opts.home) : undefined;
  const { sub } = instances.parseInvocation(opts);
  switch (sub) {
    case 'create':
      return instances.createInstance(opts, home);
    case 'list':
      return instances.listCommand(opts, home);
    case 'status':
      return instances.statusCommand(opts, home);
    case 'start':
      return instances.startCommand(opts, home);
    case 'stop':
      return instances.stopCommand(opts, home);
    case 'env':
      return instances.envCommand(opts, home);
    case 'run':
      return instances.runCommand(opts, home, codexPassthrough(opts));
    case 'refresh-catalog':
    case 'refresh':
      return instances.refreshCatalogCommand(opts, home);
    case 'update':
      return instances.updateCommand(opts, home);
    case 'remove':
      return instances.removeCommand(opts, home);
    default:
      return instances.helpCommand();
  }
}

module.exports = {
  instance,
  maskSecret: instances.maskSecret,
};
