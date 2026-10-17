// 实例（多开 / lab）自检：临时目录隔离 + 平台/进程模块打桩，不启动 codex、不访问真实网络。
//
// 覆盖：create 落盘字段与配置、端口不重复、密钥掩码、默认不注册自启、stop 无残留、remove 清理。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// 中文注释：用临时目录彻底隔离真实 ~/.codex-compat
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-instances-'));
process.env.CODEX_COMPAT_HOME = sandbox;

const args = require('../src/args.cjs');
const platform = require('../src/platform.cjs');
const processes = require('../src/processes.cjs');
const command = require('../src/commands/instance.cjs');

// 中文注释：测试用的明文密钥（必须保证长度 ≥10，掩码才会同时保留首 4 位与后 4 位）
const PLAIN_KEY = 'lab-secret-key-1234';
// 中文注释：第二个实例使用的密钥环境变量名（只记名字，不落盘）
const SECOND_KEY_ENV = 'CODEX_COMPAT_LAB_KEY_B';
// 中文注释：实例名称
const NAME_A = 'lab1';
const NAME_B = 'lab2';
const NAME_C = 'lab3';
const NAME_PROBE = 'lab-probe-fail';
// 中文注释：凭据预检用例的实例名
const NAME_AUTH_BAD = 'lab-auth-bad';
const NAME_AUTH_OK = 'lab-auth-ok';
// 中文注释：目录模式用例的实例名
const NAME_AUTO = 'lab-auto-mode';
const NAME_BAD_MODE = 'lab-bad-mode';

// 中文注释：按真实 CLI 口径解析参数后再调用命令，避免手工拼 opts 与真实行为脱节
function invoke(argv) {
  return command.instance(args.parse(argv));
}

// 中文注释：把多行输出拼成一段文本，便于断言
function textOf(result) {
  return (result && result.lines ? result.lines : []).join('\n');
}

// 中文注释：读取实例元数据
function readMeta(name) {
  const file = path.join(sandbox, 'instances', name, 'instance.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 中文注释：取一个确定无人监听的端口（先监听再释放），用于验证 /models 探测失败分支
function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  // 中文注释：打桩 —— 被调用即计数并抛错，用于证明「默认不注册自启」
  let serviceCalls = 0;
  let guardCalls = 0;
  platform.installService = () => {
    serviceCalls += 1;
    throw new Error('默认不得注册常驻服务');
  };
  platform.registerGuard = () => {
    guardCalls += 1;
    throw new Error('默认不得注册守护任务');
  };
  // 中文注释：打桩 —— 禁止真的去枚举/结束系统进程
  processes.killInstance = async () => ({ killed: [], remaining: [] });
  processes.listProcesses = () => [];
  // 中文注释：打桩 —— catalog 模式不访问真实网络与真实上游，直接返回托管成功
  const catalogModule = require('../src/catalog.cjs');
  catalogModule.prepareForInstance = async () => ({
    ok: true,
    mode: 'fetched',
    total: 1,
    injected: [{ slug: 'deepseek-chat', via: 'exact' }],
  });

  // 用例 1：create 成功 + 落盘字段与配置齐全
  const createdA = await invoke(['instance', 'create', NAME_A, '--model', 'deepseek-chat', '--key', PLAIN_KEY]);
  assert.equal(createdA.ok, true, 'create 必须成功：' + JSON.stringify(createdA.lines));
  const dirA = path.join(sandbox, 'instances', NAME_A);
  const metaA = readMeta(NAME_A);
  for (const field of ['name', 'createdAt', 'kind', 'codexHome', 'compatHome', 'listenPort', 'upstream', 'model', 'models', 'catalogMode', 'keyEnv', 'keyStored', 'autostart']) {
    assert.ok(Object.prototype.hasOwnProperty.call(metaA, field), 'instance.json 缺少字段 ' + field);
  }
  assert.equal(metaA.name, NAME_A);
  assert.equal(metaA.kind, 'lab');
  assert.equal(metaA.codexHome, path.join(dirA, 'codex'), 'codexHome 必须是实例目录下的 codex');
  assert.equal(metaA.compatHome, path.join(dirA, 'compat'), 'compatHome 必须是实例目录下的 compat');
  assert.equal(metaA.model, 'deepseek-chat');
  assert.deepEqual(metaA.models, ['deepseek-chat']);
  // 中文注释：默认目录模式为 instructions——实测 Codex 0.160.1 不拉取 provider 级目录，故不默认托管
  assert.equal(metaA.catalogMode, 'instructions');
  assert.equal(metaA.keyEnv, 'CODEX_COMPAT_LAB_KEY');
  assert.equal(metaA.keyStored, true);
  assert.equal(metaA.autostart, false);
  for (const field of ['mode', 'host', 'port', 'basePath', 'baseUrl']) {
    assert.ok(Object.prototype.hasOwnProperty.call(metaA.upstream, field), 'upstream 缺少字段 ' + field);
  }
  assert.equal(metaA.upstream.mode, 'cc-switch');
  assert.ok(metaA.listenPort >= 15900, '实例端口必须 ≥15900，实际 ' + metaA.listenPort);
  assert.ok(metaA.listenPort <= 16000, '实例端口必须 ≤16000，实际 ' + metaA.listenPort);

  // 中文注释：codex/config.toml 必须是无 BOM 的 UTF-8；instructions 模式写 model_instructions_file，且不得写 provider 目录 URL
  const tomlFile = path.join(dirA, 'codex', 'config.toml');
  const tomlRaw = fs.readFileSync(tomlFile);
  assert.notEqual(tomlRaw[0], 0xef, 'config.toml 不得带 UTF-8 BOM');
  const tomlText = tomlRaw.toString('utf8');
  assert.ok(tomlText.includes('model = "deepseek-chat"'), 'config.toml 必须写入 model');
  const promptFile = path.join(dirA, 'prompts', 'deepseek-codex.md');
  assert.ok(tomlText.includes('model_instructions_file = ' + JSON.stringify(promptFile)),
    'instructions 模式必须写入 model_instructions_file，实际：\n' + tomlText);
  // 中文注释：必须写在 [model_providers.lab] 之前——写进 provider 表内会被 Codex 忽略
  assert.ok(tomlText.indexOf('model_instructions_file') < tomlText.indexOf('[model_providers.lab]'),
    'model_instructions_file 必须是顶层键，早于 [model_providers.lab] 出现，实际：\n' + tomlText);
  assert.ok(!tomlText.includes('model_catalog_url'), 'instructions 模式不得写 provider 目录 URL');
  assert.ok(fs.existsSync(promptFile), 'instructions 模式必须把提示词副本复制到实例目录');
  assert.ok(tomlText.includes('env_key = "CODEX_COMPAT_LAB_KEY"'), 'config.toml 必须写入 env_key');
  assert.ok(tomlText.includes('[features.multi_agent_v2]'), 'config.toml 必须写入 multi_agent_v2');
  // 中文注释：Windows 上 lab 实例必须带原生沙箱模式，否则 shell 命令会被策略拦下
  if (process.platform === 'win32') {
    assert.ok(tomlText.includes('[windows]'), 'Windows 上 config.toml 必须写入 [windows] 段，实际：\n' + tomlText);
    assert.ok(/sandbox = "(elevated|unelevated)"/.test(tomlText), 'Windows 上必须声明沙箱模式，实际：\n' + tomlText);
  }

  // 中文注释：实例目录 → 实例自己的 CODEX_HOME（watchdog 靠它避免把映射同步写进宿主 ~/.codex）
  const instancesLib = require('../src/instances.cjs');
  assert.equal(instancesLib.instanceCodexHome(path.join(sandbox, 'instances', NAME_A, 'compat')), path.join(dirA, 'codex'),
    'instanceCodexHome 必须解析出实例自己的 codex 目录');
  assert.equal(instancesLib.instanceCodexHome(sandbox), null, '非实例运行目录必须返回 null');
  assert.equal(instancesLib.instanceCodexHome(path.join(sandbox, 'instances', NAME_A)), null, '非 compat 目录必须返回 null');

  // 中文注释：兼容层 home 的 listen.port 必须等于实例端口
  const compatCfg = JSON.parse(fs.readFileSync(path.join(dirA, 'compat', 'config.json'), 'utf8'));
  assert.equal(compatCfg.listen.port, metaA.listenPort, 'compat/config.json 的 listen.port 必须等于实例端口');
  assert.equal(compatCfg.upstream.port, metaA.upstream.port, 'compat/config.json 的 upstream.port 必须等于上游端口');

  // 中文注释：--key 必须落盘到 secrets.env，且格式为 KEYENV=value
  const secretsA = path.join(dirA, 'secrets.env');
  assert.equal(fs.readFileSync(secretsA, 'utf8'), 'CODEX_COMPAT_LAB_KEY=' + PLAIN_KEY + '\n', 'secrets.env 内容必须是 KEYENV=value');

  // 用例 2：两个实例端口不重复
  const createdB = await invoke(['instance', 'create', NAME_B, '--models', 'model-x,model-y', '--key-env', SECOND_KEY_ENV]);
  assert.equal(createdB.ok, true, '第二个 create 必须成功：' + JSON.stringify(createdB.lines));
  const metaB = readMeta(NAME_B);
  assert.notEqual(metaB.listenPort, metaA.listenPort, '两个实例的端口不得重复');
  assert.ok(metaB.listenPort >= 15900 && metaB.listenPort <= 16000, '端口必须落在扫描区间，实际 ' + metaB.listenPort);
  assert.equal(metaB.model, 'model-x', '--models 的第一个模型作为默认模型');
  assert.deepEqual(metaB.models, ['model-x', 'model-y']);
  assert.equal(metaB.keyEnv, SECOND_KEY_ENV);
  assert.equal(metaB.keyStored, false);
  assert.equal(fs.existsSync(path.join(sandbox, 'instances', NAME_B, 'secrets.env')), false, '--key-env 不得落盘密钥文件');

  // 用例 3：list / env 输出只出现掩码，绝不出现明文密钥
  const listed = await invoke(['instance', 'list']);
  assert.equal(listed.ok, true);
  const listText = textOf(listed);
  assert.ok(listText.includes('****'), 'list 输出必须包含掩码 ****：' + listText);
  assert.ok(!listText.includes(PLAIN_KEY), 'list 输出不得出现明文密钥');
  assert.ok(listText.includes(NAME_A) && listText.includes(NAME_B), 'list 必须列出两个实例');

  const envA = await invoke(['instance', 'env', NAME_A]);
  assert.equal(envA.ok, true);
  const envText = textOf(envA);
  assert.ok(envText.includes('****'), 'env 输出必须包含掩码 ****');
  assert.ok(!envText.includes(PLAIN_KEY), 'env 输出不得出现明文密钥');
  assert.ok(envText.includes('CODEX_HOME=' + path.join(dirA, 'codex')), 'env 必须给出 CODEX_HOME');
  assert.ok(envText.includes('set "CODEX_HOME='), 'env 必须给出 cmd 版可复制命令');
  assert.ok(envText.includes("$env:CODEX_HOME='"), 'env 必须给出 pwsh 版可复制命令');
  assert.ok(envText.includes('codex'), 'env 必须给出 codex 启动命令');

  const envB = await invoke(['instance', 'env', NAME_B]);
  assert.equal(envB.ok, true);
  assert.ok(!textOf(envB).includes(PLAIN_KEY), 'env 输出不得泄露其他实例的明文密钥');

  // 用例 3.1：status 读取元数据（进程枚举已打桩，不会触碰真实系统进程）
  const statusA = await invoke(['instance', 'status', NAME_A]);
  assert.equal(statusA.ok, true, 'status 必须成功：' + JSON.stringify(statusA.lines));
  assert.equal(statusA.instance.listenPort, metaA.listenPort);
  assert.equal(statusA.processCount, 0);
  assert.ok(!textOf(statusA).includes(PLAIN_KEY), 'status 输出不得出现明文密钥');

  // 用例 3.2：菜单使用的 refresh 简写必须路由到 refresh-catalog，而不是误落到 list
  const refreshed = await invoke(['instance', 'refresh', NAME_B]);
  assert.ok(!textOf(refreshed).includes('实例列表'), 'instance refresh 必须路由到 refresh-catalog');

  // 用例 4（补充）：未指定模型时降级为 ok=false，并提示候选（这里用无人监听的端口触发失败分支）
  const deadPort = await freePort();
  const probeFail = await invoke(['instance', 'create', NAME_PROBE, '--provider', '127.0.0.1:' + deadPort]);
  assert.equal(probeFail.ok, false, '未指定 --model 必须返回 ok=false');
  assert.ok(textOf(probeFail).includes('--model'), '失败输出必须提示用 --model 指定模型');
  assert.ok(!fs.existsSync(path.join(sandbox, 'instances', NAME_PROBE)), '未指定模型时不得创建实例目录');

  // 用例 4：--autostart 时自启桩必须被调用（换为计数不抛错的桩）
  serviceCalls = 0;
  guardCalls = 0;
  platform.installService = () => {
    serviceCalls += 1;
    return { ok: true, detail: 'stub service' };
  };
  platform.registerGuard = () => {
    guardCalls += 1;
    return { ok: true, detail: 'stub guard' };
  };
  // 中文注释：显式 --catalog-mode catalog 时才托管 provider 级目录，必须写入 model_catalog_url
  const createdC = await invoke(['instance', 'create', NAME_C, '--model', 'deepseek-chat', '--catalog-mode', 'catalog', '--autostart']);
  assert.equal(createdC.ok, true, '带 --autostart 的 create 必须成功：' + JSON.stringify(createdC.lines));
  assert.equal(serviceCalls, 1, '--autostart 时必须调用 platform.installService');
  assert.equal(guardCalls, 1, '--autostart 时必须调用 platform.registerGuard');
  assert.equal(readMeta(NAME_C).autostart, true, 'instance.json 必须记录 autostart=true');
  const tomlC = fs.readFileSync(path.join(sandbox, 'instances', NAME_C, 'codex', 'config.toml'), 'utf8');
  assert.ok(tomlC.includes('model_catalog_url = "http://127.0.0.1:' + readMeta(NAME_C).listenPort + '/__compat/catalog"'),
    '显式 catalog 模式必须写入 model_catalog_url，实际：\n' + tomlC);

  // 用例 4.1：instance update 把包内提示词刷到实例目录，覆盖前留备份，已是当前版本时报告「已是最新」；
  // 非 instructions 模式的实例（NAME_C）没有提示词文件，必须明确跳过。
  const promptA = path.join(sandbox, 'instances', NAME_A, 'prompts', 'deepseek-codex.md');
  assert.ok(fs.existsSync(promptA), 'instructions 模式的实例必须有提示词文件');
  fs.writeFileSync(promptA, 'stale prompt\n');
  const updatedA = await invoke(['instance', 'update', NAME_A]);
  assert.equal(updatedA.ok, true, 'update 必须成功：' + JSON.stringify(updatedA.lines));
  assert.equal(updatedA.changed, true);
  const packedPrompt = fs.readFileSync(path.join(__dirname, '..', 'config', 'prompts', 'deepseek-codex.md'), 'utf8');
  assert.equal(fs.readFileSync(promptA, 'utf8'), packedPrompt, 'update 必须写入包内当前版本');
  const promptBackups = fs.readdirSync(path.join(sandbox, 'instances', NAME_A, 'compat', 'backups'));
  assert.equal(promptBackups.length, 1, 'update 必须留下旧版备份');
  assert.equal(fs.readFileSync(path.join(sandbox, 'instances', NAME_A, 'compat', 'backups', promptBackups[0]), 'utf8'), 'stale prompt\n');
  const againA = await invoke(['instance', 'update', NAME_A]);
  assert.equal(againA.changed, false);
  assert.ok(textOf(againA).includes('已是最新'), '已是最新时必须报告：' + textOf(againA));
  const allUpdate = await invoke(['instance', 'update']);
  assert.equal(allUpdate.ok, true);
  assert.ok(textOf(allUpdate).includes('catalogMode=catalog'), 'catalog 模式实例必须明确跳过：' + textOf(allUpdate));

  // 用例 5：stop 无残留
  const stopped = await invoke(['instance', 'stop', NAME_A]);
  assert.equal(stopped.ok, true, 'stop 必须成功：' + JSON.stringify(stopped.lines));
  assert.deepEqual(stopped.remaining, [], 'stop 不得有残留进程');

  // 用例 6：remove 后实例目录不存在，list 不再包含它
  const removed = await invoke(['instance', 'remove', NAME_C]);
  assert.equal(removed.ok, true, 'remove 必须成功：' + JSON.stringify(removed.lines));
  assert.equal(removed.deleted, path.join(sandbox, 'instances', NAME_C));
  assert.equal(fs.existsSync(path.join(sandbox, 'instances', NAME_C)), false, 'remove 后实例目录必须不存在');
  const listedAfter = await invoke(['instance', 'list']);
  const afterText = textOf(listedAfter);
  assert.ok(!afterText.includes(NAME_C), 'remove 后 list 不得再包含该实例');
  assert.ok(afterText.includes(NAME_A) && afterText.includes(NAME_B), 'remove 不得影响其他实例');

  // 用例 7：凭据预检——上游返回 401 必须告警，但不得阻断创建
  const badAuth = http.createServer((req, res) => {
    if (/\/models$/.test(req.url || '')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid or expired API key' } }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((resolve) => badAuth.listen(0, '127.0.0.1', resolve));
  const badAuthPort = badAuth.address().port;
  const createdBad = await invoke(['instance', 'create', NAME_AUTH_BAD, '--provider', '127.0.0.1:' + badAuthPort, '--model', 'x-model', '--key', 'wrong-key-1234']);
  assert.equal(createdBad.ok, true, '凭据预检不得阻断创建：' + JSON.stringify(createdBad.lines));
  assert.ok(createdBad.warnings.some((item) => item.includes('上游拒绝该密钥（HTTP 401）')),
    '401 时必须给出凭据告警，实际：' + JSON.stringify(createdBad.warnings));
  assert.ok(!textOf(createdBad).includes('wrong-key-1234'), '告警输出不得出现明文密钥');
  await new Promise((resolve) => badAuth.close(resolve));

  // 用例 8：凭据有效（200）时不得出现凭据告警
  const goodAuth = http.createServer((req, res) => {
    if (/\/models$/.test(req.url || '')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'x-model' }] }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((resolve) => goodAuth.listen(0, '127.0.0.1', resolve));
  const goodAuthPort = goodAuth.address().port;
  const createdGood = await invoke(['instance', 'create', NAME_AUTH_OK, '--provider', '127.0.0.1:' + goodAuthPort, '--model', 'x-model', '--key', 'good-key-1234']);
  assert.equal(createdGood.ok, true, '凭据有效时必须创建成功：' + JSON.stringify(createdGood.lines));
  assert.ok(!createdGood.warnings.some((item) => item.includes('上游拒绝该密钥')),
    '凭据有效时不得出现凭据告警，实际：' + JSON.stringify(createdGood.warnings));
  await new Promise((resolve) => goodAuth.close(resolve));

  // 用例 9：--catalog-mode auto 必须落到 instructions（否则两条注入路径都不写，提示词静默失效）
  const createdAuto = await invoke(['instance', 'create', NAME_AUTO, '--model', 'deepseek-chat', '--catalog-mode', 'auto']);
  assert.equal(createdAuto.ok, true, 'auto 模式必须创建成功：' + JSON.stringify(createdAuto.lines));
  assert.equal(readMeta(NAME_AUTO).catalogMode, 'instructions', 'auto 必须解析为 instructions');
  const autoToml = fs.readFileSync(path.join(sandbox, 'instances', NAME_AUTO, 'codex', 'config.toml'), 'utf8');
  assert.ok(autoToml.includes('model_instructions_file'), 'auto 模式必须写入 model_instructions_file，实际：\n' + autoToml);
  assert.ok(createdAuto.warnings.some((item) => item.includes('auto 已按 instructions 处理')),
    'auto 必须给出降级说明，实际：' + JSON.stringify(createdAuto.warnings));

  // 用例 10：非法 --catalog-mode 必须直接报错，不得创建实例
  const badMode = await invoke(['instance', 'create', NAME_BAD_MODE, '--model', 'deepseek-chat', '--catalog-mode', 'bogus']);
  assert.equal(badMode.ok, false, '非法目录模式必须失败');
  assert.ok(textOf(badMode).includes('--catalog-mode 只能是'), '非法目录模式必须说明可选值：' + textOf(badMode));
  assert.ok(!fs.existsSync(path.join(sandbox, 'instances', NAME_BAD_MODE)), '非法目录模式不得创建实例目录');

  return true;
}

main().then(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log('INSTANCES_TEST_PASS');
}).catch((err) => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
