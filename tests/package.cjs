// 中文注释：打包内容校验：以 npm pack --dry-run 的真实文件清单为准，
// 中文注释：确保发布包包含运行所需文件，且不夹带本地运行态数据与私有配置。
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// 中文注释：Windows 上 npm 的可执行文件名是 npm.cmd
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// 中文注释：本文件位于 tests/，仓库根目录是上一级
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 中文注释：发布包必须包含的条目；以 / 结尾表示目录，其余为精确文件路径
const REQUIRED_ENTRIES = [
  'bin/',
  'src/',
  'config/mappings.toml',
  'config/prompts/deepseek-codex.md',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'THIRD_PARTY_NOTICES.md',
];

// 中文注释：不应进入发布包的本地运行态目录（运行期由安装脚本在仓库内创建）
const FORBIDDEN_DIRECTORIES = ['profiles/', 'backups/', 'logs/', 'artifacts/', 'node_modules/'];

// 中文注释：不应进入发布包的运行态文件与私有目录：本地 cc-switch 目录、模型目录清单、旧提示词副本
const FORBIDDEN_KEYWORDS = ['.cc-switch', 'cc-switch-model-catalog', 'deepseek-developer.md'];

// 中文注释：config.toml 是本机 cc-switch 配置，安装脚本还会生成 config.toml.<时间戳>.bak 备份
const FORBIDDEN_CONFIG_TOML = /(^|\/)config\.toml([.~]|$)/;

// 中文注释：读取 npm pack 的文件清单；--dry-run 保证只计算清单、不生成 tarball
function readPackedFiles() {
  // 中文注释：Windows 必须经由 shell 才能启动 npm.cmd（Node 18.20+/20.12+ 禁止直接 spawn .cmd）
  const output = execFileSync(NPM_COMMAND, ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    cwd: PROJECT_ROOT,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  // 中文注释：npm 可能在对钩子输出之外混入额外文本，这里截取首个 [ 到末个 ] 的 JSON 主体
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start < 0 || end <= start) {
    throw new Error('无法解析 npm pack --json 输出：' + output.slice(0, 200));
  }
  const parsed = JSON.parse(output.slice(start, end + 1));
  const first = Array.isArray(parsed) ? parsed[0] : null;
  if (!first || !Array.isArray(first.files)) {
    throw new Error('npm pack --json 输出缺少 files 清单');
  }
  // 中文注释：统一分隔符，保证 Windows 与类 Unix 判定一致
  return first.files.map(item => String(item.path).replace(/\\/g, '/'));
}

// 中文注释：必需但缺失的条目清单
function findMissingEntries(files) {
  return REQUIRED_ENTRIES.filter(entry => entry.endsWith('/')
    ? !files.some(file => file.startsWith(entry))
    : !files.includes(entry));
}

// 中文注释：被夹带进发布包的禁止条目清单
function findForbiddenEntries(files) {
  return files.filter(file => FORBIDDEN_DIRECTORIES.some(dir => file.startsWith(dir) || file === dir.slice(0, -1))
    || FORBIDDEN_KEYWORDS.some(keyword => file.includes(keyword))
    || FORBIDDEN_CONFIG_TOML.test(file));
}

// 中文注释：提取顶层条目（路径第一段），便于快速确认发布包结构
function topLevelEntries(files) {
  const entries = new Set();
  for (const file of files) {
    const segments = file.split('/');
    entries.add(segments.length > 1 ? segments[0] + '/' : segments[0]);
  }
  return [...entries].sort();
}

// 中文注释：执行校验；通过打印 PACKAGE_TEST_PASS，失败打印具体缺失/多余文件并退出 1
function main() {
  const files = readPackedFiles();
  const missing = findMissingEntries(files);
  const forbidden = findForbiddenEntries(files);

  if (missing.length > 0 || forbidden.length > 0) {
    console.error('PACKAGE_TEST_FAIL');
    for (const entry of missing) {
      console.error('  缺少必需条目：' + entry);
    }
    for (const file of forbidden) {
      console.error('  夹带不应发布的条目：' + file);
    }
    console.error('实际打包文件清单（' + files.length + ' 项）：');
    for (const file of files) {
      console.error('  ' + file);
    }
    process.exit(1);
  }

  console.log('PACKAGE_TEST_PASS');
  console.log('打包文件共 ' + files.length + ' 项，顶层条目：' + topLevelEntries(files).join('、'));
}

try {
  main();
}
catch (err) {
  console.error('PACKAGE_TEST_FAIL');
  console.error('  打包校验执行失败：' + (err && err.message ? err.message : String(err)));
  if (err && err.stderr) {
    console.error(String(err.stderr));
  }
  process.exit(1);
}
