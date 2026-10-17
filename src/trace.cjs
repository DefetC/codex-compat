// Codex 请求/响应诊断追踪：验证提示词是否送达，以及请求是否正常结束
//
// 默认关闭。需要临时诊断时，可设置 COMPAT_TRACE=1，或把 logs/trace.flag 写为 1。
// 诊断日志与普通兼容层事件日志分离，避免普通运行持续落盘完整系统指令。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const config = require('./config.cjs');

// 中文注释：仓库根目录
const DIR = path.resolve(__dirname, '..');

// 中文注释：追踪日志目录；优先环境变量，其次运行目录（绝不在仓库内落盘）
function traceDir() {
  if (process.env.COMPAT_TRACE_DIR) {
    return process.env.COMPAT_TRACE_DIR;
  }
  try {
    return config.paths(config.loadSafe().cfg.home).logs;
  } catch (err) {
    return path.join(DIR, 'logs');
  }
}

// 中文注释：追踪开关文件路径
function flagFile() {
  return path.join(traceDir(), 'trace.flag');
}

// 中文注释：单个追踪日志文件的默认上限，超过后自动滚动
const DEFAULT_TRACE_MAX_BYTES = 16 * 1024 * 1024;

// 中文注释：单个模型完整 instructions 的默认留存上限
const DEFAULT_INSTRUCTIONS_MAX_BYTES = 128 * 1024;

// 中文注释：降低开关文件同步检查频率，避免每个流分片都访问磁盘
const FLAG_REFRESH_INTERVAL_MS = 1000;

// 中文注释：追踪日志单文件大小上限
const TRACE_MAX_BYTES = positiveInteger(process.env.COMPAT_TRACE_MAX, DEFAULT_TRACE_MAX_BYTES);

// 中文注释：完整 instructions 文件大小上限
const INSTRUCTIONS_MAX_BYTES = positiveInteger(
  process.env.COMPAT_TRACE_INSTRUCTIONS_MAX,
  DEFAULT_INSTRUCTIONS_MAX_BYTES,
);

// 中文注释：完整 instructions 的异步保存目录
function instructionsDir() {
  return process.env.COMPAT_TRACE_INSTRUCTIONS_DIR || path.join(traceDir(), 'instructions');
}

// 中文注释：是否落盘完整 instructions；默认仅在诊断开启时落盘，设为 0 可关闭
const STORE_FULL_INSTRUCTIONS = process.env.COMPAT_TRACE_FULL_INSTRUCTIONS !== '0';

// 中文注释：当前追踪开关缓存状态
let cachedEnabled = false;

// 中文注释：最近一次读取追踪开关的时间
let flagCheckedAt = 0;

// 中文注释：异步追踪日志写入流
let traceStream = null;

// 中文注释：当前追踪日志文件已写入字节数
let traceBytes = 0;

// 中文注释：同一毫秒内滚动时使用的递增序号
let traceSequence = 0;

// 中文注释：按模型文件串行写入，避免异步写入乱序
const pendingInstructionWrites = new Map();

// 中文注释：instructions 目录的异步初始化任务
let instructionDirReady = null;

// 中文注释：把环境变量解析为正整数，非法值回退到默认值
function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// 中文注释：读取追踪开关文件；文件内容为 0 或空时关闭
function readFlag() {
  try {
    const file = flagFile();
    if (!fs.existsSync(file)) {
      return false;
    }
    const value = fs.readFileSync(file, 'utf8').trim();
    return value !== '' && value !== '0';
  } catch (err) {
    return false;
  }
}

// 中文注释：配置项 runtime.trace 也可开启追踪（与开关文件、环境变量等价）
function configEnabled() {
  try {
    return config.loadSafe().cfg.runtime.trace === true;
  } catch (err) {
    return false;
  }
}

// 中文注释：判断追踪是否开启，并对开关文件与配置读取做短时缓存
function enabled() {
  if (process.env.COMPAT_TRACE === '1') {
    return true;
  }
  const now = Date.now();
  if (now - flagCheckedAt < FLAG_REFRESH_INTERVAL_MS) {
    return cachedEnabled;
  }
  flagCheckedAt = now;
  cachedEnabled = readFlag() || configEnabled();
  return cachedEnabled;
}

// 中文注释：为模型名生成安全的 instructions 文件名
function safeModelName(model) {
  return String(model || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

// 中文注释：计算 instructions 的 SHA-256，便于不落正文时校验版本
function hashInstructions(instructions) {
  return crypto.createHash('sha256').update(instructions, 'utf8').digest('hex');
}

// 中文注释：按字节截断完整 instructions，避免超出留存上限
function limitInstructions(instructions) {
  const bytes = Buffer.byteLength(instructions, 'utf8');
  if (bytes <= INSTRUCTIONS_MAX_BYTES) {
    return instructions;
  }
  const suffix = '\n...[instructions truncated by trace limit]...\n';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const prefixBytes = Math.max(0, INSTRUCTIONS_MAX_BYTES - suffixBytes);
  const prefix = Buffer.from(instructions, 'utf8')
    .subarray(0, prefixBytes)
    .toString('utf8');
  return prefix + suffix;
}

// 中文注释：异步保存最近一次模型 instructions，单模型文件覆盖更新
function storeInstructions(model, instructions) {
  if (!STORE_FULL_INSTRUCTIONS) {
    return;
  }
  try {
    const dir = instructionsDir();
    const file = path.join(dir, safeModelName(model) + '.txt');
    const content = limitInstructions(instructions);
    if (!instructionDirReady) {
      instructionDirReady = fsp.mkdir(dir, { recursive: true }).catch(() => {});
    }
    const previous = pendingInstructionWrites.get(file) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => instructionDirReady)
      .then(() => fsp.writeFile(file, content, 'utf8'))
      .catch(() => {});
    pendingInstructionWrites.set(file, next);
  } catch (err) {
    // 中文注释：诊断写盘失败不能影响请求转发
  }
}

// 中文注释：创建或滚动异步追踪日志文件
function ensureTraceStream(nextBytes) {
  if (traceStream && traceBytes + nextBytes <= TRACE_MAX_BYTES) {
    return;
  }
  try {
    if (traceStream) {
      traceStream.end();
    }
    const dir = traceDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, 'trace-' + stamp + '-' + traceSequence++ + '.jsonl');
    traceStream = fs.createWriteStream(file, { flags: 'a' });
    traceStream.on('error', () => {
      traceStream = null;
      traceBytes = 0;
    });
    traceBytes = 0;
  } catch (err) {
    traceStream = null;
    traceBytes = 0;
  }
}

// 中文注释：异步写入一条追踪事件，不阻塞请求转发主链路
function write(obj) {
  if (!enabled()) {
    return;
  }
  try {
    const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, obj)) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    ensureTraceStream(bytes);
    if (!traceStream) {
      return;
    }
    traceBytes += bytes;
    traceStream.write(line);
  } catch (err) {
    // 中文注释：诊断写盘失败不能影响请求转发
  }
}

// 中文注释：把任意形态的正文取值统一成字符串（纯字符串、{ text } 结构、内容分片数组）
function textOfParts(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => textOfParts(part))
      .filter((text) => text.length > 0)
      .join('\n');
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    return value.text;
  }
  return '';
}

// 中文注释：instructions 的投递位置与形态随 Codex 版本变化：0.160 及以前是顶层 instructions 字段，
// 0.162 起该字段消失、正文改由 input 里的 developer 消息携带（实测抓包确认，模板逐字节在其中）。
// 两处都认，这个「提示词是否送达」的诊断才不会在版本升级后误报成空。
function locateInstructions(parsed) {
  const direct = textOfParts(parsed.instructions);
  if (direct) {
    return { source: 'instructions', text: direct };
  }
  if (Array.isArray(parsed.input)) {
    for (const item of parsed.input) {
      if (!item || item.role !== 'developer') {
        continue;
      }
      const text = textOfParts(item.content);
      // 中文注释：只取第一条 developer 消息。实测它就是 base_instructions（与目录里的模型模板
      // 逐字节一致），这样 instructionsHash 能直接和模板对拍；其后的 skills / multi-agent 块
      // 是客户端附加内容，不参与模板比对。
      if (text) {
        return { source: 'developer-message', text };
      }
    }
  }
  return { source: 'none', text: '' };
}

// 中文注释：记录请求侧信息，完整正文仅在诊断模式下按上限异步留存
function traceRequest(parsed, url) {
  if (!enabled() || !parsed) {
    return;
  }
  const located = locateInstructions(parsed);
  const instructions = located.text;
  if (instructions.length > 0) {
    storeInstructions(parsed.model, instructions);
  }
  write({
    kind: 'request',
    url,
    model: parsed.model,
    instructionsSource: located.source,
    instructionsBytes: Buffer.byteLength(instructions, 'utf8'),
    instructionsHash: hashInstructions(instructions),
    instructionsStored: STORE_FULL_INSTRUCTIONS && instructions.length > 0,
    instructionsLen: instructions.length,
    hasInstructionPriority: instructions.indexOf('Instruction priority') >= 0,
    hasExecutionResponsibility: instructions.indexOf('Execution responsibility') >= 0,
    hasAutonomy: instructions.indexOf('Autonomy and persistence') >= 0,
    hasMultiStep: instructions.indexOf('Working through multi-step') >= 0,
    // 中文注释：只记录首尾片段，避免把完整正文写入 JSONL
    head: instructions.slice(0, 120),
    tail: instructions.slice(-120),
  });
}

// 中文注释：记录响应侧信息 —— 流是否以正常终止事件结束
function createStreamTracer(model) {
  const state = {
    events: [],
    terminal: null,
    bytes: 0,
    sawDone: false,
    lastEventName: null,
    textChars: 0,
    toolCallCount: 0,
  };

  return {
    // 中文注释：消费响应分片并累计轻量统计信息
    onChunk(chunk) {
      if (!enabled()) {
        return;
      }
      state.bytes += chunk.length;
      const text = chunk.toString('utf8');
      const nameMatches = text.match(/event:\s*([\w.]+)/g);
      if (nameMatches) {
        for (const m of nameMatches) {
          const name = m.replace(/event:\s*/, '').trim();
          state.lastEventName = name;
          if (state.events.length < 40) {
            state.events.push(name);
          }
          if (name === 'response.completed' || name === 'response.failed' || name === 'response.incomplete') {
            state.terminal = name;
          }
        }
      }
      if (text.indexOf('[DONE]') >= 0) {
        state.sawDone = true;
      }
      const outMatches = text.match(/"type":"output_text"/g);
      if (outMatches) {
        state.textChars += outMatches.length;
      }
      const toolMatches = text.match(/"type":"function_call"/g);
      if (toolMatches) {
        state.toolCallCount += toolMatches.length;
      }
    },

    // 中文注释：响应结束时异步记录终止状态
    finish(aborted, statusCode) {
      if (!enabled()) {
        return;
      }
      write({
        kind: 'response',
        model,
        statusCode,
        abortedByClient: !!aborted,
        bytes: state.bytes,
        terminalEvent: state.terminal,
        sawDone: state.sawDone,
        lastEventName: state.lastEventName,
        eventCount: state.events.length,
        events: state.events,
        textChunks: state.textChars,
        toolCalls: state.toolCallCount,
        // 中文注释：无终止事件即判定为可疑截断
        suspicious: !state.terminal,
      });
    },
  };
}

module.exports = { enabled, traceRequest, createStreamTracer, traceDir, flagFile, instructionsDir };
