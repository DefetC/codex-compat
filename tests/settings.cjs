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

    console.log('SETTINGS_TEST_PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
