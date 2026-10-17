// 追踪模块自检：验证异步写入、文件滚动、指令截断和哈希记录
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');

// 中文注释：使用系统临时目录，避免污染正式诊断日志
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-trace-'));
process.env.COMPAT_TRACE = '1';
process.env.COMPAT_TRACE_DIR = tempRoot;
process.env.COMPAT_TRACE_INSTRUCTIONS_DIR = path.join(tempRoot, 'instructions');
process.env.COMPAT_TRACE_MAX = '512';
process.env.COMPAT_TRACE_INSTRUCTIONS_MAX = '64';

// 中文注释：在设置环境变量后再加载模块，确保测试使用隔离配置
const trace = require('../src/trace.cjs');

// 中文注释：写入两条请求，触发追踪日志滚动和 instructions 截断
trace.traceRequest({
  model: 'test-model',
  instructions: 'A'.repeat(200),
}, '/v1/responses');
trace.traceRequest({
  model: 'test-model',
  instructions: 'B'.repeat(200),
}, '/v1/responses');
// 中文注释：instructions 也可能是 { text } 结构（目录条目被原样带出时）
trace.traceRequest({
  model: 'structured-model',
  instructions: { text: 'C'.repeat(200), provenance: { source: 'catalog' } },
}, '/v1/responses');
// 中文注释：Codex 0.162.1 起顶层 instructions 字段消失，正文改由 input 的 developer 消息携带
trace.traceRequest({
  model: 'developer-model',
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'D'.repeat(200) }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  ],
}, '/v1/responses');

// 中文注释：异步写入完成后校验产物
setTimeout(() => {
  try {
    const traceFiles = fs.readdirSync(tempRoot)
      .filter((name) => name.indexOf('trace-') === 0 && name.endsWith('.jsonl'));
    if (traceFiles.length < 2) {
      throw new Error('追踪日志没有按大小滚动');
    }
    const lines = traceFiles
      .flatMap((name) => fs.readFileSync(path.join(tempRoot, name), 'utf8').trim().split(/\r?\n/))
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (lines.length !== 4 || lines.some((line) => !line.instructionsHash || line.instructionsStored !== true)) {
      throw new Error('追踪元数据或 instructions 哈希缺失');
    }
    // 中文注释：顶层 instructions（字符串与 { text } 结构）都记为 instructions
    if (lines.filter((line) => line.model === 'test-model' || line.model === 'structured-model')
      .some((line) => line.instructionsSource !== 'instructions')) {
      throw new Error('顶层 instructions 的来源标记不正确');
    }
    // 中文注释：{ text } 结构必须与纯字符串得到同样的正文、字节数与哈希
    const structured = lines.find((line) => line.model === 'structured-model');
    const hashOf = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    if (!structured || structured.instructionsHash !== hashOf('C'.repeat(200)) || structured.instructionsLen !== 200
      || structured.instructionsBytes !== 200) {
      throw new Error('{ text } 结构的 instructions 未被识别');
    }
    // 中文注释：0.162.1 的 developer 消息同样要被识别为指令正文
    const developer = lines.find((line) => line.model === 'developer-model');
    if (!developer || developer.instructionsSource !== 'developer-message'
      || developer.instructionsHash !== hashOf('D'.repeat(200)) || developer.instructionsLen !== 200) {
      throw new Error('developer 消息里的 instructions 未被识别');
    }
    if (!fs.existsSync(path.join(tempRoot, 'instructions', 'structured-model.txt'))) {
      throw new Error('结构化 instructions 未落盘');
    }
    if (!fs.existsSync(path.join(tempRoot, 'instructions', 'developer-model.txt'))) {
      throw new Error('developer 消息里的 instructions 未落盘');
    }
    const instructionFile = path.join(tempRoot, 'instructions', 'test-model.txt');
    if (!fs.existsSync(instructionFile) || fs.statSync(instructionFile).size > 64) {
      throw new Error('instructions 截断上限未生效');
    }
    console.log('TRACE_TEST_PASS');
  } catch (err) {
    console.error('TRACE_TEST_FAIL: ' + err.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}, 200);
