// 中文注释：用真实临时配置验证失败分支，只替换系统服务注册这一外部副作用。
//
// 覆盖两种失败：
//   1. 角色冲突：预检通过，配置应完成接入（base_url 指向兼容层），但不得生成冲突角色文件
//   2. config.toml 语法错误：预检失败，任何配置都不得改写
// 两种情况下都必须保持「对话必经服务」已注册。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 中文注释：所有测试配置仅放在本次临时目录
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-install-safety-'));

// 中文注释：构造隔离的 CODEX_HOME 与映射目录
function fixture(name, configText) {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), configText);
  fs.writeFileSync(path.join(home, 'cc-switch-model-catalog.json'), JSON.stringify({ models: [{ slug: 'vendor/auto' }] }));
  const mappingDir = path.join(home, 'mapping');
  fs.mkdirSync(mappingDir);
  fs.writeFileSync(path.join(mappingDir, 'model.toml'), '[settings]\ndefault_reasoning_level = "high"\n');
  fs.writeFileSync(path.join(mappingDir, 'role.toml'), '[text_files]\ndeveloper_instructions = "隔离测试指导"\n');
  fs.writeFileSync(path.join(mappingDir, 'mappings.toml'),
    'version = 1\n[[bindings]]\nmodel_id = "vendor/auto"\nmodel_template = "model.toml"\nrole_template = "role.toml"\nrole_name = "deepseek_auto"\nrole_description = "隔离角色"\n');
  return { home, mappingDir };
}

// 中文注释：在临时 CODEX_HOME 下执行安装，仅拦截计划任务注册
function runInstall(home, mappingDir) {
  const code = [
    "const platform=require('./src/platform.cjs');",
    "const ports=require('./src/ports.cjs');",
    "const processes=require('./src/processes.cjs');",
    'const original=platform.paths;',
    'platform.paths=()=>({...original(),backups:' + JSON.stringify(path.join(home, 'backups')) + '});',
    "platform.installService=()=>{console.log('TEST_SERVICE_REGISTERED');return {ok:true,detail:'模拟系统服务注册'}};",
    "platform.registerGuard=()=>{console.log('TEST_GUARD_REGISTERED');return {ok:true,detail:'模拟系统守护注册'}};",
    "platform.startWatchdogDetached=()=>({ok:true,detail:'模拟兜底拉起'});",
    "platform.cleanupOwnLegacyTasks=()=>({removed:[],detail:'模拟清理'});",
    "platform.cleanupLegacyTasks=()=>({removed:[],detail:'模拟清理'});",
    "platform.legacyTasks=()=>[];",
    "processes.killInstance=async()=>({killed:[],remaining:[]});",
    "ports.probeCompat=async(host,port)=>(port===15731?{ours:true,data:{name:'codex-compat',version:'test',port:15731,upstreamPort:15721}}:{ours:false,data:null});",
    "process.argv=['node','install','--yes'];",
    "require('./scripts/install.cjs');",
  ].join('');
  return spawnSync(process.execPath, ['-e', code], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      CODEX_HOME: home,
      CODEX_MAPPING_FILE: path.join(mappingDir, 'mappings.toml'),
      CODEX_COMPAT_HOME: path.join(home, 'compat-home'),
    },
    encoding: 'utf8',
    windowsHide: true,
  });
}

try {
  // 场景 1：角色冲突必须显式失败，但不得生成冲突角色文件
  const conflictText = 'base_url = "http://127.0.0.1:15731/v1"\n[features.multi_agent_v2]\nenabled = true\ntool_namespace = "agents"\n[agents.deepseek_auto]\nconfig_file = "user.toml"\n';
  const conflict = fixture('role-conflict', conflictText);
  const conflictResult = runInstall(conflict.home, conflict.mappingDir);
  assert.equal(conflictResult.status, 1, '角色冲突必须返回失败状态');
  assert.ok(conflictResult.stdout.includes('TEST_SERVICE_REGISTERED'), '失败不得跳过服务注册');
  assert.ok(conflictResult.stdout.includes('TEST_GUARD_REGISTERED'), '失败不得跳过守护注册');
  assert.equal(fs.existsSync(path.join(conflict.home, 'agents', 'deepseek-auto.toml')), false, '冲突不得生成部分角色文件');
  const conflictConfig = fs.readFileSync(path.join(conflict.home, 'config.toml'), 'utf8');
  assert.ok(/base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/.test(conflictConfig), '角色冲突时仍应完成 base_url 接入');
  assert.ok(conflictConfig.includes('[agents.deepseek_auto]'), '用户已有角色注册不得被删除');
  assert.ok(conflictConfig.includes('config_file = "user.toml"'), '用户已有角色配置不得被覆盖');

  // 场景 2：config.toml 语法错误必须在预检阶段终止，不产生任何写入
  const invalidText = 'base_url = "http://127.0.0.1:15731/v1"\n[features.multi_agent_v2\n';
  const invalid = fixture('invalid-toml', invalidText);
  const invalidResult = runInstall(invalid.home, invalid.mappingDir);
  assert.equal(invalidResult.status, 1, '非法 TOML 必须返回失败状态');
  assert.ok(invalidResult.stdout.includes('TEST_SERVICE_REGISTERED'), '预检失败仍须保证服务注册');
  assert.equal(fs.readFileSync(path.join(invalid.home, 'config.toml'), 'utf8'), invalidText, '预检失败不得改写配置');
  assert.equal(fs.existsSync(path.join(invalid.home, 'agents')), false, '预检失败不得生成角色目录');

  // 场景 3：纯官方配置（没有第三方 provider）必须零写入、零进程、零计划任务
  const pureText = 'model_provider = "openai"\n';
  const pure = fixture('pure-official', pureText);
  const pureResult = runInstall(pure.home, pure.mappingDir);
  assert.equal(pureResult.status, 1, '纯官方场景必须返回失败');
  assert.ok(!pureResult.stdout.includes('TEST_SERVICE_REGISTERED'), '纯官方场景不得注册常驻服务');
  assert.ok(!pureResult.stdout.includes('TEST_GUARD_REGISTERED'), '纯官方场景不得注册守护任务');
  assert.equal(fs.readFileSync(path.join(pure.home, 'config.toml'), 'utf8'), pureText, '纯官方配置不得被改写');
  assert.equal(fs.existsSync(path.join(pure.home, 'agents')), false, '纯官方场景不得生成角色目录');

  console.log('安装安全测试通过：角色冲突显式失败；非法 TOML 预检即终止且保持服务；纯官方场景零写入零服务。');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
