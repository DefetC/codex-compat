# Privacy

## Summary

`codex-compat` has **no telemetry**. It does not contain analytics, usage reporting, crash reporting, advertising identifiers, or update pings, and it never contacts any server of its own — there is no server of its own. Everything it does happens on your machine.

The only network traffic it produces is the traffic you asked for:

1. Codex connects to the layer on the loopback interface (default `127.0.0.1:15731`).
2. The layer forwards those requests to the upstream you configured (a local CC Switch proxy by default, or your own OpenAI-compatible endpoint).

Nothing else is sent anywhere. `selftest` and `doctor` make no model calls: their runtime checks only talk to the local health endpoint and to the upstream address you configured.

## What is stored, and where

兼容层自身的设置、日志、状态和备份存放在运行目录（默认 `~/.codex-compat`，可用 `CODEX_COMPAT_HOME` / `--home` 更改）。安装器还会按清单改写 Codex 的配置和模型目录；实验实例有独立 `CODEX_HOME`，主动在线回归则使用临时 home/workspace 并写入仓库的 `artifacts/`。这些范围不应混同于默认代理日志。

| Data | Location | Contents |
| --- | --- | --- |
| Settings | `~/.codex-compat/config.json` | 默认保存地址、开关与策略；用户自行写入 URL 或自定义字段的值可能包含敏感信息，原配置不等同于脱敏诊断副本 |
| Logs | `~/.codex-compat/logs/` | 事件类型、计数、模型名、时间戳；异常只记录类型和错误码，不记录正文片段、裸词或原始异常消息 |
| Diagnostic trace | `~/.codex-compat/logs/` | Off by default. See the section below |
| Backups | `~/.codex-compat/backups/` | Copies of the files taken immediately before a write, so changes can be rolled back |
| Install manifest | `~/.codex-compat/install-manifest.json` | Which files the installer changed, and content hashes used to detect external edits |
| Locks and flags | `~/.codex-compat/run/` | Single-instance lock and runtime flags |
| Diagnostic bundle | `~/.codex-compat/diagnostics/` | Created only on demand: status, doctor report, configuration, and recent logs, sanitized before writing |

## What is never stored

- 转发路径中的 API key、token、cookie 与认证头只在内存中透传，不落默认事件日志；诊断副本按规则脱敏。用户主动保存的原始配置、备份，以及使用 `instance create --key` 生成的实例 `secrets.env` 仍可能含凭据，不能将“转发不记凭据”误解为所有运行文件都可公开。
- Task bodies and message content: the normal logging path records counts and model names only. It does not record what you asked a subagent to do, and it does not record model output.
- 原生密文：不尝试解密、不删除历史输出/推理/原生压缩密文，也不在默认日志中保存。`ccswitch-compaction-v1:` 是 Base64 文本摘要而非原生密文；只有绕过 CC Switch 时才严格还原为普通 user 消息，摘要同样不落默认日志。

## Logging policy

Normal logs answer "did the rewrite happen, and how often", not "what was said":

- 进程内累计元数据：请求、改写、标记剥离、明文投影、孤立输出、参数修复、拒绝及异常；新增 `filteredOutputIncludes`、`decodedBodies`、`compactionSummariesProjected`。计数随进程重启重置，也可能来自拒绝或解压，不代表上游成功或孩子完成。
- Model identity and event type, so you can tell official traffic from gateway traffic.
- Error events for decode, parse, upstream, and listen failures. These describe the failure, not the payload.

Log files roll over at a fixed size cap, so they cannot grow without bound.

## Diagnostic tracing

Tracing is **off by default**. It is switched on explicitly for a debugging session (the project reads the `COMPAT_TRACE` environment variable or a trace flag file), and you should turn it off afterwards — it is a debug tool, not a data collection feature.

When tracing is enabled:

- The trace log records request metadata: the model, the byte length and SHA-256 of the instructions block, which instruction markers were present, and short head/tail snippets (on the order of a hundred characters each) rather than the full text.
- The most recent full instructions text per model may be written to a separate file, subject to a size cap, so you can diff the exact template that was sent.
- Task bodies, model output, and authentication headers are still not written.
- Trace files roll over at a fixed size cap on the same principle as the normal logs.

Because the instructions block is part of the prompt your tooling sends, treat an enabled trace as diagnostic evidence: review and trim it before sharing it in a bug report, and delete the trace files when you are done.

## CC Switch state files

To tell you whether CC Switch is currently taking over Codex, the layer inspects local CC Switch state read-only (its settings file, its live state file, and — when the Node.js version supports it — its local SQLite database). Those files are only read on your machine, are never modified, and their contents are never sent anywhere. If the database cannot be read, the check silently falls back to the remaining sources.

## Configuration backups

Before changing a file, the installer stores a copy under `~/.codex-compat/backups/`. Those backups can contain your own Codex configuration (for example provider addresses and model settings), so treat the backups directory as private, and remove it when you no longer need the rollback ability. Files written by the tooling use restrictive permissions where the platform supports them.

## Diagnostic bundles

诊断包写入 `~/.codex-compat/diagnostics/<timestamp>/`，包含状态、体检、配置和近期日志，不会自动上传。状态、配置及 JSONL 先按敏感字段结构化遮盖，再序列化；文本兜底完整遮盖 Bearer、密钥、Fernet 和 CC Switch 摘要封装，URL 的 userinfo 与敏感查询参数也会遮盖。无法解析的 JSONL 行明确省略并报告数量，不能把它当作完整记录。脱敏不等于可公开：分享前仍须人工检查路径、内部地址、提示词及任何不在已知规则中的敏感信息。

## 主动在线回归的证据

`npm run test:regression` 是开发者主动执行的真实模型实验，不属于默认代理日志。它会将独立孩子的测试回答、完成回答、来源/模型信息、等待元数据及派发口令命中/任务指纹写到 git 忽略的 `artifacts/regression/`；摘要产物不保存派发正文或认证。身份会复制到本次临时 home 使用，每例结束清理自己的临时身份副本与原始会话，故不能保证以后重建完整旧会话。

测试只能使用已授权上游和合成任务。输出仍须人工检查，不能因目录被忽略或内容叫“测试证据”就公开真实业务回答、身份、内部地址或原生密文。线上回归不加入自动 CI；计数、HTTP 200、父代理口令和新一轮复核均不替代独立孩子证据。

## Data removal

`restore` 按安装清单还原 Codex 配置，`uninstall` 另外停止服务并移除自启/守护注册；默认都保留运行目录。`uninstall --purge` 才删除运行目录，但不会替你清理仓库外复制的诊断、追踪或仓库内主动生成的 `artifacts/`。在线驱动正常结束时清理本次临时身份和原始会话；额外复制的证据由使用者自己管理。兼容层没有远程回传副本，但不能据此宣称删除一个运行目录就删除了所有本地副本。

## Changes

If this policy changes, the change ships with the source and is described in [CHANGELOG.md](CHANGELOG.md).

For a suspected privacy or security issue, use the private reporting channel described in [SECURITY.md](SECURITY.md).
