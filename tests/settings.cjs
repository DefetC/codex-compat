// 配置命令回归测试：模块必须能加载（历史 bug：函数名与模块常量重名导致 SyntaxError），
// 且 get/set 在隔离 home 下真实读写。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config.cjs');

// 中文注释：加载即验证没有重复声明问题
const settings = require('../src/commands/settings.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-settings-'));
// 配置测试的映射、目录与备份也必须隔离，不能读取或修改用户主 Codex home。
const originalCodexHome = process.env.CODEX_HOME;
const originalCompatHome = process.env.CODEX_COMPAT_HOME;
const codexHome = path.join(root, 'codex');
fs.mkdirSync(codexHome);
process.env.CODEX_HOME = codexHome;
process.env.CODEX_COMPAT_HOME = root;

(async () => {
  try {
    assert.equal(typeof settings.config, 'function', 'settings 必须导出 config 命令');

    const list = await settings.config({ _: ['config', 'list'], home: root });
    assert.equal(list.ok, true);
    assert.equal(list.config.listen.port, 15731, '默认端口应为 15731');

    const get = await settings.config({ _: ['config', 'get', 'listen.port'], home: root });
    assert.equal(get.value, 15731);

    const set = await settings.config({ _: ['config', 'set', 'listen.port', '15742'], home: root });
    assert.equal(set.ok, true);
    assert.equal(config.loadSafe({ home: root }).cfg.listen.port, 15742, 'set 必须真正写盘');

    const reread = await settings.config({ _: ['config', 'get', 'listen.port'], home: root });
    assert.equal(reread.value, 15742);

    const reclaim = await settings.config({ _: ['config', 'set', 'service.reclaim', 'notify-only'], home: root });
    assert.equal(reclaim.ok, true);
    assert.equal(config.loadSafe({ home: root }).cfg.service.reclaim, 'notify-only');

    // 真实映射具备改变目录的条件，用文件字节断言兼容开关不会顺手应用它。
    const mappingDir = path.join(root, 'config');
    fs.mkdirSync(mappingDir, { recursive: true });
    fs.writeFileSync(path.join(mappingDir, 'model.toml'), '[settings]\nbase_instructions = "不应被兼容开关应用的模板"\n');
    fs.writeFileSync(path.join(mappingDir, 'mappings.toml'), 'version = 1\n[[bindings]]\nmodel_id = "vendor/gpt-model"\nmodel_template = "model.toml"\n');
    const catalogFile = path.join(codexHome, 'cc-switch-model-catalog.json');
    const configFile = path.join(codexHome, 'config.toml');
    const catalogBefore = JSON.stringify({ models: [{ slug: 'vendor/gpt-model', base_instructions: '用户目录正文' }] });
    const configBefore = 'model = "vendor/gpt-model"\n';
    fs.writeFileSync(catalogFile, catalogBefore);
    fs.writeFileSync(configFile, configBefore);
    const compat = await settings.config({ _: ['config', 'set', 'compat.outputTokenReplay', 'strip'], home: root });
    assert.equal(compat.ok, true);
    assert.equal(fs.readFileSync(catalogFile, 'utf8'), catalogBefore, '修改兼容开关不得改变模型目录');
    assert.equal(fs.readFileSync(configFile, 'utf8'), configBefore, '修改兼容开关不得改变 Codex 配置');
    const allowed = await settings.config({ _: ['config', 'set', 'compat.opaqueTaskModels', '["vendor/gpt-model"]'], home: root });
    assert.equal(allowed.ok, true);
    assert.deepEqual(config.load({ home: root }).compat.opaqueTaskModels, ['vendor/gpt-model']);
    assert.equal(fs.readFileSync(catalogFile, 'utf8'), catalogBefore);
    assert.equal(fs.readFileSync(configFile, 'utf8'), configBefore);
    const savedBeforeInvalid = fs.readFileSync(config.paths(root).configFile, 'utf8');
    await assert.rejects(() => settings.config({ _: ['config', 'set', 'compat.opaqueTaskModels', '["*"]'], home: root }), /compat\.opaqueTaskModels/);
    assert.equal(fs.readFileSync(config.paths(root).configFile, 'utf8'), savedBeforeInvalid, '错误配置不能产生部分写入');

    console.log('SETTINGS_TEST_PASS');
  } finally {
    if (originalCodexHome === undefined) { delete process.env.CODEX_HOME; } else { process.env.CODEX_HOME = originalCodexHome; }
    if (originalCompatHome === undefined) { delete process.env.CODEX_COMPAT_HOME; } else { process.env.CODEX_COMPAT_HOME = originalCompatHome; }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
