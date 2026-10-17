// 第一跳：把包内 config/{prompts,templates} 落到运行目录，并让运行目录那份与包内保持一致。
//
// 为什么需要它：mappings.apply（第二跳）读的是运行目录里那份拷贝，而 seed() 只在首次安装时
// 整目录拷一次 —— 之后包内模板再更新也到不了运行目录，且没有任何地方会报出这件事（2026-08~10
// 实测：运行目录那份少了 501 字节的两条约束，四天无人发现）。这里把它变成被管理的步骤：
// 记所有权 hash → 没被本地改过的自动刷新、被改过的只报告、缺失的按策略重建。
//
// 约束：只写包内存在的同名文件，绝不删除运行目录里包内没有的文件；mappings.toml 不在受管集合内
// （菜单开关本来就要改它）；只读的安装目录不影响（读包内、写运行目录）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const files = require('./config-files.cjs');

// 中文注释：受管目录（相对 config 根）；mappings.toml 由菜单开关管理，不在此列
const MANAGED_DIRS = ['prompts', 'templates'];
const STATE_VERSION = 1;

// 中文注释：逐文件状态的取值，便于测试与回报文案
const STATUS = {
  current: 'current',     // 与包内一致，且记录一致
  adoptable: 'adoptable', // 与包内一致，但还没有所有权记录（老安装/首次接管）
  outdated: 'outdated',   // 有记录且未被改动，但包内已更新
  edited: 'edited',       // 已被本地改过：永不自动覆盖
  divergent: 'divergent', // 无记录且与包内不同：不自动覆盖
  absent: 'absent',       // 运行目录里没有（首次安装或文件被删）
};

// 中文注释：状态文件路径（运行目录下的 state/，与 mappings 状态文件同级）
function stateFile(home) {
  return path.join(home, 'state', 'templates.json');
}

// 中文注释：受管资源在运行目录中的落点
function targetRoot(home) {
  return path.join(home, 'config');
}

// 中文注释：递归列出包内受管文件（相对 config 根的 POSIX 风格路径）
function walk(root, relative, out) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    return;
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const childRelative = relative + '/' + entry.name;
    if (entry.isDirectory()) {
      walk(root, childRelative, out);
    } else if (entry.isFile()) {
      out.push(childRelative);
    }
  }
}

// 中文注释：包内受管集合；包内没有的文件一律不管
function listManaged(packageRoot) {
  const out = [];
  for (const dir of MANAGED_DIRS) {
    walk(packageRoot, dir, out);
  }
  return out;
}

// 中文注释：读取所有权记录；损坏时按「无记录」处理并回报原因，绝不因此中断安装。
// 注意：内容损坏也要保留原文，写入时才能通过「外部修改」检查。
function readState(home) {
  let text = null;
  try {
    text = files.read(stateFile(home));
  } catch (err) {
    // 中文注释：读不出来（例如目标是链接）时按无记录处理，且不把它当作可覆写的已知内容
    return { version: STATE_VERSION, pkgVersion: null, files: {}, raw: undefined, error: String(err && err.message || err) };
  }
  if (text === null) {
    return { version: STATE_VERSION, pkgVersion: null, files: {}, raw: null, error: null };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // 中文注释：内容损坏
  }
  if (!parsed || parsed.version !== STATE_VERSION || !files.object(parsed.files)) {
    return { version: STATE_VERSION, pkgVersion: null, files: {}, raw: text, error: '模板所有权记录无效，已按无记录处理' };
  }
  return { version: STATE_VERSION, pkgVersion: parsed.pkgVersion || null, files: parsed.files, raw: text, error: null };
}

// 中文注释：逐文件判定当前状态（纯读，不落盘）
function inspect(input) {
  const home = input.home;
  const packageRoot = input.packageRoot;
  const state = input.state || readState(home);
  const entries = [];
  for (const relative of listManaged(packageRoot)) {
    const desired = fs.readFileSync(path.join(packageRoot, relative), 'utf8');
    let current = null;
    let unreadable = null;
    try {
      current = files.read(path.join(targetRoot(home), relative));
    } catch (err) {
      // 中文注释：链接或读取失败一律不碰，只报告
      unreadable = String(err && err.message || err);
    }
    const record = state.files[relative];
    const recordedHash = record && typeof record.hash === 'string' ? record.hash : null;
    let status;
    if (unreadable) {
      status = STATUS.divergent;
    } else if (current === null) {
      // 中文注释：包内有、运行目录没有：首次安装或被删，按策略重建
      status = STATUS.absent;
    } else if (recordedHash !== null && files.hash(current) !== recordedHash) {
      status = STATUS.edited;
    } else if (current === desired) {
      status = recordedHash === null ? STATUS.adoptable : STATUS.current;
    } else {
      status = recordedHash === null ? STATUS.divergent : STATUS.outdated;
    }
    entries.push({ relative, status, desired, current, recordedHash, unreadable });
  }
  return entries;
}

// 中文注释：按策略决定每个文件是否行动；force 表示显式覆盖本地改动
function decide(entries, options) {
  const policy = options.policy || 'auto';
  const force = options.force === true;
  const actions = [];
  for (const entry of entries) {
    const write = () => actions.push({ relative: entry.relative, action: 'write', status: entry.status });
    const adopt = () => actions.push({ relative: entry.relative, action: 'adopt', status: entry.status });
    const skip = () => actions.push({ relative: entry.relative, action: 'skip', status: entry.status });
    if (entry.unreadable) {
      actions.push({ relative: entry.relative, action: 'blocked', status: entry.status, error: entry.unreadable });
      continue;
    }
    if (force && (entry.status === STATUS.edited || entry.status === STATUS.divergent)) {
      write();
      continue;
    }
    switch (entry.status) {
      case STATUS.current:
        skip();
        break;
      case STATUS.adoptable:
        // 中文注释：接管已有内容（与包内一致）不写文件，只补记所有权；
        // notify-only 也允许这一步（纯记账），off 则完全不碰。
        if (policy === 'off') {
          skip();
        } else {
          adopt();
        }
        break;
      case STATUS.outdated:
      case STATUS.absent:
        policy === 'auto' ? write() : skip();
        break;
      case STATUS.edited:
      case STATUS.divergent:
      default:
        skip();
        break;
    }
  }
  return actions;
}

// 中文注释：写入前的备份目录（与 mappings 的备份并列，便于人工查找）
function backupDir(home, changeId) {
  return path.join(home, 'backups', 'templates', changeId);
}

// 中文注释：执行一次同步；dryRun 时只读不写，返回可展示的报告
function sync(input = {}) {
  const home = input.home;
  if (!home) {
    throw new Error('sync 需要运行目录 home');
  }
  const packageRoot = input.packageRoot || path.join(require('./config.cjs').rootDir(), 'config');
  const policy = input.policy || 'auto';
  const dryRun = input.dryRun === true;
  const state = readState(home);
  let entries;
  try {
    entries = inspect({ home, packageRoot, state });
  } catch (err) {
    return { ok: false, policy, dryRun, error: String(err && err.message || err), entries: [], written: [], adopted: [], skipped: [], blocked: [] };
  }
  const actions = decide(entries, { policy, force: input.force });
  const report = {
    ok: true,
    policy,
    dryRun,
    packageRoot,
    stateError: state.error,
    pkgVersion: input.pkgVersion || null,
    entries,
    actions,
    written: actions.filter(a => a.action === 'write').map(a => a.relative),
    adopted: actions.filter(a => a.action === 'adopt').map(a => a.relative),
    skipped: actions.filter(a => a.action === 'skip' && a.status !== STATUS.current).map(a => a.relative),
    unchanged: actions.filter(a => a.action === 'skip' && a.status === STATUS.current).map(a => a.relative),
    blocked: actions.filter(a => a.action === 'blocked').map(a => ({ relative: a.relative, error: a.error })),
    edited: entries.filter(e => e.status === STATUS.edited || e.status === STATUS.divergent).map(e => e.relative),
    outdated: entries.filter(e => e.status === STATUS.outdated).map(e => e.relative),
    changeId: null,
    backup: null,
  };
  report.changed = report.written.length > 0 || report.adopted.length > 0;
  if (dryRun || !report.changed) {
    return report;
  }

  // 中文注释：真正落盘：先备份再原子替换，最后更新所有权记录
  const changeId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID();
  const dir = backupDir(home, changeId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const nextState = { version: STATE_VERSION, pkgVersion: input.pkgVersion || state.pkgVersion, files: Object.assign({}, state.files) };
  const errors = [];
  const journal = { version: 1, changeId, kind: 'templates', home: path.resolve(home), packageRoot, policy, files: [] };
  for (const action of actions) {
    if (action.action !== 'write' && action.action !== 'adopt') {
      continue;
    }
    const entry = entries.find(e => e.relative === action.relative);
    try {
      if (action.action === 'write') {
        const target = path.join(targetRoot(home), action.relative);
        if (entry.current !== null) {
          const backupFile = path.join(dir, action.relative.replace(/[\\/]/g, '__'));
          fs.writeFileSync(backupFile, entry.current, { mode: 0o600 });
        }
        files.atomicWrite(target, entry.desired, entry.current === null ? undefined : entry.current);
      }
      nextState.files[action.relative] = {
        hash: files.hash(entry.desired),
        refreshedAt: new Date().toISOString(),
        origin: action.action === 'adopt' ? 'adopt' : 'refresh',
      };
      journal.files.push({ file: action.relative, action: action.action, status: entry.status, beforeHash: entry.current === null ? null : files.hash(entry.current), afterHash: files.hash(entry.desired) });
    } catch (err) {
      errors.push({ relative: action.relative, error: String(err && err.message || err) });
    }
  }
  try {
    fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
    files.atomicWrite(stateFile(home), JSON.stringify(nextState, null, 2) + '\n', state.raw);
  } catch (err) {
    errors.push({ relative: '<state>', error: String(err && err.message || err) });
  }
  report.changeId = changeId;
  report.backup = dir;
  report.errors = errors;
  if (errors.length) {
    report.ok = false;
  }
  return report;
}

// 中文注释：按报告生成一行人类可读摘要，供动作列表与 doctor 复用；如实反映状态，不依赖策略
function describe(report) {
  if (!report.ok && report.error) {
    return '模板同步失败：' + report.error;
  }
  const parts = [];
  if (report.written.length) {
    parts.push('已刷新 ' + report.written.length + ' 份' + (report.pkgVersion ? '（包内 ' + report.pkgVersion + '）' : ''));
  }
  if (report.adopted.length) {
    parts.push('已接管 ' + report.adopted.length + ' 份（与包内一致，补记所有权）');
  }
  if (report.outdated.length) {
    parts.push('包内已更新待刷新 ' + report.outdated.length + ' 份');
  }
  if (report.edited.length) {
    parts.push('跳过 ' + report.edited.length + ' 份本地改过或与包内不一致的：' + report.edited.slice(0, 3).join('、'));
  }
  if (report.blocked.length) {
    parts.push('跳过 ' + report.blocked.length + ' 份不可读的');
  }
  if (report.stateError) {
    parts.push('所有权记录异常（' + report.stateError + '）');
  }
  if (!parts.length) {
    return '与包内一致（' + report.unchanged.length + ' 份）';
  }
  return parts.join('；');
}

// 中文注释：报告里是否存在值得关注/行动的差异；供守护判定是否触发刷新或通知。
// 「与包内一致、只是还没记所有权」不算差异（接管是记账，不该通知）。
function drifted(report) {
  if (!report || !Array.isArray(report.entries)) {
    return false;
  }
  return report.entries.some((entry) => entry.status !== STATUS.current && entry.status !== STATUS.adoptable);
}

module.exports = { MANAGED_DIRS, STATUS, stateFile, targetRoot, listManaged, readState, inspect, decide, sync, describe, drifted };
