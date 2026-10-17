// 中文注释：显式收费验收；全新 CLI、真实调用记录和逐字指导三者共同判定。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const toml = require('@iarna/toml');
const platform = require('../src/platform.cjs');
// 中文注释：在线验收产物，不包含认证文件。
const OUTPUT = path.resolve(__dirname, '../artifacts/mappings-live');
// 中文注释：CLI 可由使用者通过环境变量指定。
const CLI = process.env.CODEX_BIN || path.join(process.env.LOCALAPPDATA, 'OpenAI/Codex/bin/9691020b546a15b2/codex.exe');
// 中文注释：角色验收组合；模型默认与主控继承必须分别验证。
const CASES = [
  { name: 'auto_low', role: 'deepseek_auto', effort: 'low', expected: 'low', model: 'ccs-deepseek/auto(free)' },
  { name: 'auto_high', role: 'deepseek_auto', effort: 'high', expected: 'high', model: 'ccs-deepseek/auto(free)' },
  { name: 'auto_inherit', role: 'deepseek_auto', expected: 'low', model: 'ccs-deepseek/auto(free)' },
  { name: 'flash_low', role: 'deepseek_flash', effort: 'low', expected: 'low', model: 'ccs-deepseek/deepseek-v4.1-flash' },
  { name: 'flash_high', role: 'deepseek_flash', effort: 'high', expected: 'high', model: 'ccs-deepseek/deepseek-v4.1-flash' },
  { name: 'flash_inherit', role: 'deepseek_flash', expected: 'low', model: 'ccs-deepseek/deepseek-v4.1-flash' },
  { name: 'flash_default', role: 'deepseek_flash', explicitModel: true, expected: 'high', model: 'ccs-deepseek/deepseek-v4.1-flash' },
];
// 中文注释：额度有限时仅验收指定模型，默认仍覆盖全部映射。
const SELECTED_CASES = process.env.CODEX_LIVE_MODEL === 'flash' ? CASES.filter(test => test.role === 'deepseek_flash') : CASES;
// 中文注释：解析 JSONL，跳过行尾空行但不吞掉非法记录。
function events(text) { return text.split('\n').filter(Boolean).map(JSON.parse); }
// 中文注释：读取首行，不扫描无关历史正文。
function meta(file) {
  const fd = fs.openSync(file, 'r');
  try { const buffer = Buffer.alloc(1024 * 1024); const n = fs.readSync(fd, buffer, 0, buffer.length, 0); return JSON.parse(buffer.subarray(0, n).toString('utf8').split('\n')[0]).payload; }
  finally { fs.closeSync(fd); }
}
// 中文注释：定位父线程及它的同日子线程记录。
function sessions(id) {
  const dir = path.join(platform.codexHome(), 'sessions');
  const parent = fs.readdirSync(dir, { recursive: true }).find(file => path.basename(file).includes(id));
  assert.ok(parent, '找不到 CLI 会话：' + id);
  const file = path.join(dir, parent); const folder = path.dirname(file);
  return { parent: events(fs.readFileSync(file, 'utf8')), children: fs.readdirSync(folder).filter(name => name.endsWith('.jsonl')).map(name => path.join(folder, name)).map(file => ({ file, meta: meta(file) })).filter(c => c.meta.source?.subagent?.thread_spawn?.parent_thread_id === id) };
}
// 中文注释：异步 CLI 驱动，进程退出后关闭继承管道，防止旧同步驱动的收尾等待。
function run(label, model, effort, prompt) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '--model', model, '--skip-git-repo-check', '--json'];
    if (effort) { args.push('-c', 'model_reasoning_effort="' + effort + '"'); }
    args.push('-');
    const child = spawn(CLI, args, { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 300000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => {
      clearTimeout(timer);
      setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy();
        fs.mkdirSync(OUTPUT, { recursive: true }); fs.writeFileSync(path.join(OUTPUT, label + '.jsonl'), stdout);
        if (timedOut || code !== 0) { reject(new Error(label + ' CLI 失败，code=' + code + '；' + stderr.slice(-1500))); return; }
        const parsed = events(stdout); const id = parsed.find(e => e.type === 'thread.started')?.thread_id;
        if (!id || !parsed.some(e => e.type === 'turn.completed') || parsed.some(e => e.type === 'turn.failed')) { reject(new Error(label + ' 缺少完成证据')); return; }
        console.log(JSON.stringify({ label, threadId: id, completed: true })); resolve(id);
      }, 100);
    });
    child.stdin.end(prompt);
  });
}
// 中文注释：检验真实子代理配置、任务返回和完整开发者消息。
function verifyRoles(id) {
  const record = sessions(id);
  const calls = record.parent.filter(e => e.payload?.type === 'function_call' && e.payload.name === 'spawn_agent').map(e => JSON.parse(e.payload.arguments));
  const results = [];
  for (const test of SELECTED_CASES) {
    const call = calls.find(c => c.task_name === test.name); assert.ok(call, '未真实调用：' + test.name);
    assert.equal(call.agent_type, test.role); assert.equal(call.reasoning_effort, test.effort);
    assert.equal(call.model, test.explicitModel ? test.model : undefined);
    const child = record.children.find(c => c.meta.agent_path === '/root/' + test.name); assert.ok(child, '没有子线程：' + test.name);
    const ev = events(fs.readFileSync(child.file, 'utf8')); const context = ev.find(e => e.type === 'turn_context')?.payload;
    assert.equal(context?.model, test.model); assert.equal(context?.effort, test.expected);
    const roleFile = path.join(platform.codexHome(), 'agents', test.role.replace(/_/g, '-') + '.toml');
    const role = toml.parse(fs.readFileSync(roleFile, 'utf8')); assert.equal(role.model_reasoning_effort, undefined);
    const guidance = ev.some(e => e.payload?.role === 'developer' && e.payload.content?.some(c => c.text?.includes(role.developer_instructions)));
    assert.ok(guidance, '角色正文未逐字送达：' + test.name);
    const answer = ev.filter(e => e.payload?.role === 'assistant').flatMap(e => e.payload.content || []).map(c => c.text || '').join('\n');
    assert.ok(answer.includes('MAP-' + test.name) && answer.includes('194'), '子代理返回不正确：' + test.name);
    results.push({ name: test.name, threadId: child.meta.id, model: context.model, effort: context.effort, exactGuidance: guidance });
  }
  return results;
}
// 中文注释：新模型主控验收完整模型模板和最终强度。
function verifyMain(id, model) {
  const record = sessions(id).parent; const session = record.find(e => e.type === 'session_meta')?.payload;
  const context = record.find(e => e.type === 'turn_context')?.payload;
  const catalog = JSON.parse(fs.readFileSync(require('../src/mappings.cjs').options().catalogFile, 'utf8'));
  const entry = catalog.models.find(m => m.slug === model);
  const instructions = typeof session.base_instructions === 'string' ? session.base_instructions : session.base_instructions?.text;
  assert.equal(instructions, entry.base_instructions); assert.equal(context.model, model); assert.equal(context.effort, 'high');
  return { threadId: id, model, effort: context.effort, exactTemplate: true, catalogDefault: entry.default_reasoning_level };
}
// 中文注释：顺序派发避免超过并发名额；没有任何生产文件修改任务。
async function main() {
  const tasks = SELECTED_CASES.map(t => ({ task_name: t.name, agent_type: t.role, fork_turns: 'none', ...(t.effort ? { reasoning_effort: t.effort } : {}), ...(t.explicitModel ? { model: t.model } : {}), message: '只回答 MAP-' + t.name + ' 和 97*2 的结果，不调用工具、不修改文件。' }));
  const prompt = '只读验收，禁止修改任何文件。按以下参数顺序实际调用内置 spawn_agent，严格保留参数，未提供的 model 或 reasoning_effort 不能自行添加。每次等待子代理完成后再派下一个，最后贴出全部原始结果。参数：\n' + JSON.stringify(tasks);
  const parentId = await run('roles', 'gpt-6.1-sol', 'low', prompt);
  const roles = verifyRoles(parentId); console.log(JSON.stringify({ roleVerification: roles }));
  const autoId = process.env.CODEX_LIVE_MODEL === 'flash' ? null : await run('auto-main', 'ccs-deepseek/auto(free)', null, '只回答 MAP-AUTO-MAIN 和 101*2 的结果，不调用工具、不修改文件。');
  const flashId = await run('flash-main', 'ccs-deepseek/deepseek-v4.1-flash', null, '只回答 MAP-FLASH-MAIN 和 103*2 的结果，不调用工具、不修改文件。');
  const mains = [...(autoId ? [verifyMain(autoId, 'ccs-deepseek/auto(free)')] : []), verifyMain(flashId, 'ccs-deepseek/deepseek-v4.1-flash')];
  fs.writeFileSync(path.join(OUTPUT, 'proof.json'), JSON.stringify({ parentId, roles, mains }, null, 2));
  console.log('MAPPINGS_LIVE_PASS ' + JSON.stringify({ parentId, roles, mains }));
}
main().catch(err => { console.error('在线验收失败', err); process.exitCode = 1; });
