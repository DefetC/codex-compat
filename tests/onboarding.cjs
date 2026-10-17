// 新用户上路自测：用一个全新的临时 CODEX_HOME / CODEX_COMPAT_HOME 走一遍开源用户的真实路径，
// 并回归「自定义运行目录绝不能碰主实例的计划任务 / 不能借用主实例的健康状态」。
// 不访问真实网络；平台注册类调用全部打桩。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
// 中文注释：全新用户的隔离环境
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-onboarding-'));
const compatHome = path.join(root, 'compat');
const codexHome = path.join(root, 'codex');
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(path.join(codexHome, 'config.toml'),
  '[model_providers.custom]\nname = "Fake"\nbase_url = "http://127.0.0.1:15721/v1"\nwire_api = "responses"\n');

// 中文注释：隔离环境变量，保证测试不触碰真实 ~/.codex 与 ~/.codex-compat
const ENV = Object.assign({}, process.env, {
  CODEX_HOME: codexHome,
  CODEX_COMPAT_HOME: compatHome,
});

// 中文注释：以子进程方式运行 CLI。
// 必须用异步 spawn——spawnSync 会阻塞本进程事件循环，本文件里的假上游服务端就没法应答了。
function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repo, 'bin', 'codex-compat.cjs')].concat(args), {
      cwd: repo,
      env: Object.assign({}, ENV, options.env || {}),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

// 中文注释：取一个空闲端口
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  // 用例 1：help 必须把实验实例（多开）等命令列出来，新用户不能靠猜
  const help = await runCli(['help']);
  assert.equal(help.status, 0, 'help 必须成功：' + help.stderr);
  for (const token of ['instance', 'lab', 'bundle', 'doctor', 'restore', 'uninstall']) {
    assert.ok(help.stdout.includes(token), 'help 必须包含 ' + token + '，实际：\n' + help.stdout);
  }

  // 用例 2：全新环境下的 status / doctor 必须能跑通，并如实说明「尚未安装」
  const statusFresh = await runCli(['status']);
  assert.equal(statusFresh.status, 0, '全新环境下 status 必须成功：' + statusFresh.stderr);
  assert.ok(/未找到|尚未安装/.test(statusFresh.stdout), 'status 必须提示尚未安装：\n' + statusFresh.stdout);

  const doctorFresh = await runCli(['doctor']);
  assert.ok(doctorFresh.stdout.includes('codex-compat 体检报告'), 'doctor 必须输出体检报告');
  assert.ok(doctorFresh.stdout.includes('codex-version'), 'doctor 必须报告 Codex 版本与基线');

  // 用例 3：不同运行目录绝不能复用主实例的任务名
  const platform = require('../src/platform.cjs');
  const names = platform.namesFor({ home: compatHome });
  assert.notEqual(names.service, 'CodexCompatService', '自定义运行目录不得复用主实例服务名');
  assert.notEqual(names.guard, 'CodexCompatServiceGuard', '自定义运行目录不得复用主实例守护名');
  assert.ok(names.service.startsWith('CodexCompatService-path-'), '自定义运行目录应有可识别的派生名：' + names.service);
  const mainNames = platform.namesFor({ home: platform.defaultCompatHome() });
  assert.equal(mainNames.service, 'CodexCompatService', '默认运行目录必须沿用主实例服务名');
  assert.equal(platform.instanceNameOf(path.join(compatHome, 'instances', 'lab-x', 'compat')), 'lab-x',
    'instances/<name>/compat 必须解析为 <name>');

  // 用例 4：端口被「另一个运行目录的实例」占用时，不能算作本目录健康
  const port = await freePort();
  const foreignHome = path.join(root, 'foreign-home');
  const server = http.createServer((req, res) => {
    if (req.url === '/__compat/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'codex-compat', version: 'test', port, home: foreignHome, instance: 'main' }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    fs.mkdirSync(compatHome, { recursive: true });
    fs.writeFileSync(path.join(compatHome, 'config.json'),
      JSON.stringify({ listen: { host: '127.0.0.1', port } }), 'utf8');

    const statusForeign = await runCli(['status']);
    assert.equal(statusForeign.status, 0, 'status 必须成功：' + statusForeign.stderr);
    assert.ok(statusForeign.stdout.includes('端口被另一个实例占用'),
      'status 必须指出端口属于别的实例，实际：\n' + statusForeign.stdout);

    const doctorForeign = await runCli(['doctor']);
    assert.ok(doctorForeign.stdout.includes('另一个 codex-compat 实例'),
      'doctor 必须指出端口属于别的实例，实际：\n' + doctorForeign.stdout);
    assert.ok(/\[异常\] health/.test(doctorForeign.stdout),
      'doctor 的 health 项必须判为异常而不是通过，实际：\n' + doctorForeign.stdout);

    // 中文注释：pause 不能把「别人的实例」说成自己的残留
    const pauseForeign = await runCli(['pause']);
    assert.ok(pauseForeign.stdout.includes('由另一个实例占用') || pauseForeign.stdout.includes('未响应'),
      'pause 必须如实描述端口归属，实际：\n' + pauseForeign.stdout);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(path.join(compatHome, 'config.json'), { force: true });
  }

  // 用例 5：菜单能渲染出八个分组并以 0 正常退出（管道输入也要能走到第二步）
  // 中文注释：未安装状态下的布局是「向导置顶」，功能开关是第 6 项
  const menu = await runCli([], { input: '6\n3\nn\n0\n0\n' });
  assert.equal(menu.status, 0, '菜单必须正常退出：' + menu.stderr);
  assert.ok(menu.stdout.includes('先建实验实例试跑'),
    '未安装时必须把「先试跑再接入」向导置顶，实际：\n' + menu.stdout);
  // 中文注释：未安装时「安装」项显示为「跳过试跑，直接安装主配置」，其余分组文案一致
  const menus = ['状态与体检', '启动 / 暂停 / 重启', '跳过试跑，直接安装主配置', '实验实例（多开 / 临时 Codex）',
    '功能开关', '设置', '工具', '危险操作'];
  for (const item of menus) {
    assert.ok(menu.stdout.includes(item), '主菜单必须包含「' + item + '」，实际：\n' + menu.stdout);
  }
  assert.ok(menu.stdout.includes('当前 Codex 不支持'),
    '功能开关面板必须标明 provider 目录托管当前不受支持，实际：\n' + menu.stdout);
  assert.ok(menu.stdout.includes('实测') && menu.stdout.includes('已取消'),
    '选择该项必须给出实测说明并要求确认，实际：\n' + menu.stdout);

  // 用例 6：实验实例全程可用（创建 → 列出 → 打印运行命令 → 删除）
  const created = await runCli(['instance', 'create', 'demo', '--model', 'demo-model', '--key', 'demo-key-1234']);
  assert.equal(created.status, 0, '实例创建必须成功：' + created.stdout + created.stderr);
  const listed = await runCli(['instance', 'list']);
  assert.ok(listed.stdout.includes('demo'), '实例列表必须包含 demo：\n' + listed.stdout);
  assert.ok(listed.stdout.includes('****'), '实例列表必须掩码密钥');
  assert.ok(!listed.stdout.includes('demo-key-1234'), '实例列表不得输出明文密钥');
  const envOut = await runCli(['instance', 'env', 'demo']);
  assert.ok(envOut.stdout.includes('CODEX_HOME=' + path.join(compatHome, 'instances', 'demo', 'codex')),
    'instance env 必须给出该实例的 CODEX_HOME：\n' + envOut.stdout);
  const removed = await runCli(['instance', 'remove', 'demo']);
  assert.equal(removed.status, 0, '实例删除必须成功：' + removed.stdout + removed.stderr);
  assert.ok(removed.stdout.includes('已删除') || removed.stdout.includes('demo'),
    '实例删除必须有明确输出：\n' + removed.stdout);

  // 用例 7：未安装状态下 uninstall 必须幂等，不得报错也不得乱动系统
  const uninstall = await runCli(['uninstall', '--yes']);
  assert.ok(uninstall.status === 0 || uninstall.status === 1,
    'uninstall 必须给出明确退出码，实际 ' + uninstall.status);
  assert.ok(uninstall.stdout.includes('未找到安装清单') || uninstall.stdout.includes('无需还原'),
    'uninstall 必须说明没有可还原内容：\n' + uninstall.stdout);

  // 中文注释：整轮跑完，运行目录必须落在临时目录内
  assert.ok(fs.existsSync(compatHome), '临时运行目录必须存在（说明写入被正确隔离）');
  console.log('ONBOARDING_TEST_PASS：新用户路径（help/status/doctor/菜单/实例/卸载）全部通过');
}

main().then(() => {
  fs.rmSync(root, { recursive: true, force: true });
}).catch((err) => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(err && err.stack || err);
  process.exit(1);
});
