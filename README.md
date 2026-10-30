# codex-compat

`codex-compat` is a local compatibility layer that keeps **Codex Multi-Agent V2 subagent delivery** working when a task crosses a provider boundary — for example when an official model delegates to a gateway model such as DeepSeek, or when a gateway model delegates back to an official model.

It runs on your machine, between the Codex client and the upstream endpoint you already use (a local CC Switch proxy by default, or any custom OpenAI-compatible endpoint), and rewrites only the request shapes that break.

| Item | Value |
| --- | --- |
| Package name | `codex-compat` |
| CLI command | `codex-compat` |
| Version | 0.1.0 |
| License | MIT |
| Runtime | Node.js 18 or newer |
| Default listen address | `127.0.0.1:15731` |
| Default upstream | `127.0.0.1:15721` (CC Switch local proxy) |
| Chinese README | [README.zh-CN.md](README.zh-CN.md) |

**This is an unofficial community project, not affiliated with OpenAI, DeepSeek, or CC Switch.** It depends on undocumented Codex behaviour, so a future Codex upgrade can stop it from working. `codex-compat bypass` is the emergency escape hatch for exactly that situation.

Detailed notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) (currently written in Chinese).

## The problem it solves

Codex Multi-Agent V2 会使用 `encrypted_content` 委托容器；部分跨后端组合会出现以下故障，但不能据此断言所有第三方都不支持原生委托：

| Symptom | Root cause |
| --- | --- |
| The child agent starts normally but says it received no task (empty payload) | A third-party gateway does not understand the `encrypted_content` content block, so it drops the task body and the model only sees the message header |
| An official child stream disconnects: `Encrypted function output content could not be decrypted or decoded.` | The container holds plaintext that the official backend nevertheless insists on decrypting |
| The upstream rejects the request with HTTP 400 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` | A delegated conversation starts with an orphan `function_call_output` (a delegation block) that has no matching `function_call`; official endpoints tolerate it, chat-protocol gateways reject the whole request |

容器名不证明内容已经加密。历史故障中，部分网关忽略协作 schema 的加密标记并返回明文；另有同网关 GPT 支持自身的原生加密委托。不能把“第三方”或 `gpt-*` 名称直接等同于解密能力，更不能推断不同后端的密文互通。

## How it works

Traffic path:

```
Codex client
   │  base_url = http://127.0.0.1:15731/v1
   ▼
codex-compat  (listens on 127.0.0.1:15731, forwards + rewrites)
   │
   ▼
upstream  (default 127.0.0.1:15721, CC Switch local proxy;
           or any custom OpenAI-compatible endpoint)
   │
   ├── official models  -> official Codex backend
   └── gateway models   -> third-party OpenAI-compatible gateway
```

兼容层不接管上游路由或认证，认证头在内存中透传。HTTP 转发会执行既有 Host/hop-by-hop 规范化，并在正文表示改变时重算长度、移除失效压缩声明，不能把它描述为所有 header 字节不变。

### Three rewrite stages

| Stage | Applies to | What it does |
| --- | --- | --- |
| **A — strip the encryption marker** | 默认覆盖所有父模型；关闭 `stripAlways` 时保留历史混用检测 | 仅删除三个已知协作工具的 `message.encrypted` 标记，从源头请求明文委托，不修改普通工具或正文 |
| **B — project plaintext containers** | Every request | Moves plaintext out of `encrypted_content` containers into a standard `role: "user"` message. Needed for both downstream kinds: the official backend must not see plaintext in a container it will try to decrypt, and a gateway does not know the container block type at all |
| **C — ciphertext delivery guard** | 当前路由未允许不透明任务的请求 | 保留原载荷并明确返回 HTTP 400；已知官方通道或显式精确名单可透传，但兼容层不解密，也不保证跨后端密文互通 |

### One input normalization

Gateway upstreams validate the chat protocol, where a `role: "tool"` message must be the response to a preceding `tool_calls` message. The compatibility layer therefore normalizes orphan tool outputs (for example the delegation block created by "send from another task") into ordinary `user` messages, keeping the body text intact; empty orphan outputs are dropped. Paired tool outputs pass through untouched.

### Invalid tool arguments repair

Tool call `arguments` must be valid JSON, and a gateway model occasionally writes an enum value as a bare word. On 2026-10-14 and again on 2026-10-16 one emitted `"fork_turns": none`: Codex failed to parse the call locally yet still stored the raw string in the thread history, and every later request in that conversation replayed it — so the gateway rejected the whole request with `HTTP 400 … input[572].arguments … invalid character 'o' in literal null (expecting 'u')` and retrying could never recover the conversation. Prompt hardening in the model template was already in place (verified in all three copies) when the second one happened, so it reduces the odds but does not remove them.

Before forwarding, the layer therefore quotes bare words that sit in a value position. Only there: the scanner tracks string state, so the same text inside a message body is never touched. A repair is used only if the result parses as JSON, otherwise the body is forwarded unchanged — no half-fixed request is ever sent. 每次修复记录 `args_repaired` 事件与工具名、数量，不记录裸词或参数正文；健康端点累加 `argsRepaired`。

### Requirements

- Node.js 18 or newer.
- Codex installed and started at least once, with `~/.codex/config.toml` containing at least one `model_providers` entry. The installer attaches to that entry and rewrites its `base_url`; it does not invent a provider. If no provider is found, the preflight fails with an explanation instead of guessing.
- CC Switch is **optional**. Without it, pass `--upstream <host:port | url>` (or edit `upstream` in the configuration file) so the layer forwards to a custom OpenAI-compatible endpoint that serves the Responses API.

## Installation

From a local checkout of this project:

```bash
cd <project directory>
npm ci
node bin/codex-compat.cjs install
```

To get the short `codex-compat` command in your shell, link the checkout locally (this does not involve any registry):

```bash
npm link
codex-compat status
```

Guided install scripts also ship in `install/`: `install.ps1` for PowerShell and `install.sh` for POSIX shells. Both verify that Node.js 18 or newer is available and then run the global install plus `codex-compat install` for you — use their dry-run switch to print the exact commands first.

`install` is idempotent. It:

1. Verifies the prerequisites above.
2. Backs up and updates the Codex configuration so the client talks to the compatibility layer, and makes the Multi-Agent V2 setup explicit (`tool_namespace = "agents"` plus an explicit `multi_agent_v2` enable).
3. Chooses a free listen port: `15731` by default, scanning `15732`–`15831` when it is busy. If the port is already answered by another instance of this tool, that instance is reused instead of duplicated.
4. Synchronizes the DeepSeek model template and subagent roles (both can be switched off in settings).
5. Registers autostart and the guard process for your platform.
6. Records what it changed in `~/.codex-compat/install-manifest.json` — provider key, original `base_url`, listen and upstream addresses, the mapping change id and the role files it created — so `restore` and `uninstall` can roll back precisely.

`install` and `repair` accept `--dry-run`: they print the full change plan and write nothing. In a non-interactive shell, pass `--yes` as well. `doctor` is read-only unless you ask for `--fix`, which re-runs the install pipeline to repair configuration-class problems.

## Quick start

Not ready to touch your main configuration?

- **Zero-risk trial run:** `codex-compat instance create <name> --provider cc-switch --model <model>`, then `codex-compat instance run <name>` — an isolated `CODEX_HOME` and its own port; your main configuration is untouched.
- **Wire up the main configuration:** `codex-compat install`.
- **Changed your mind:** `codex-compat restore` (precise, manifest-driven rollback) or `codex-compat uninstall` (rolls back as well).

Full setup:

1. Run `codex-compat install` (or `node bin/codex-compat.cjs install`).
2. Restart Codex. Codex reads its configuration at startup, so a running session keeps the old settings.
3. Run `codex-compat status` for the one-screen overview, or `codex-compat doctor` for a full health check (add `--fix` to let it repair configuration-class problems).
4. Open the interactive menu with `codex-compat` (no arguments) and confirm the layer is running.
5. Ask Codex to spawn a subagent on a gateway model, and then check `codex-compat logs`: a working cross-provider delegation produces a `rewrite` event with a non-zero count.

## Commands

| Command | Purpose |
| --- | --- |
| `install` | First-time setup: preflight checks, seed the runtime config, point Codex at the layer, enable Multi-Agent V2 explicitly, sync templates and roles, register autostart and the guard, write the install manifest, then health-check. `--dry-run` prints the plan without writing |
| `repair` | The same pipeline, re-run. Use it to re-attach after `bypass`, or after CC Switch / a Codex upgrade overwrote something |
| `start` | Clear the hold flag, register the service and guard as configured, and wait for the health check to pass. Also resumes after `pause` or `stop` |
| `pause` | Stop the running processes and leave a hold flag so the guard does not bring them back. Autostart registration is kept — the next login starts it again. Resume with `start` |
| `stop` | `pause` plus removal of the autostart and guard registrations. Re-enable with `start` |
| `restart` | `stop` followed by `start` |
| `status` | Status overview: version, runtime home, listen address, health, upstream, the `base_url` Codex currently has, the drift check, service and guard state, reclaim policy, DeepSeek switches, CC Switch state, and the install manifest |
| `doctor` | Health report over preflight checks, the health endpoint, service and guard registration, recent error events in the logs, mapping and template sync state and legacy leftovers. `--fix` re-runs the install pipeline to repair configuration-class problems |
| `logs` | Show or follow the logs. `--lines N` (default 40) and `--follow`; `--file <name>` picks a specific file |
| `config` | `config list`, `config get <key>`, `config set <key> <value>` with dotted keys, for example `codex-compat config set service.reclaim auto` |
| `templates` | Refresh the packaged templates and prompts into the runtime home (hop 1). Only files that still match what the tool wrote are refreshed; files you edited are skipped unless `--force` is passed (which backs them up first). `--dry-run` only reports |
| `bypass` | Emergency bypass: writes the original upstream address recorded in the install manifest back into the Codex configuration. The layer keeps running but is out of the traffic path; re-attach with `repair` |
| `restore` | Restore the Codex configuration from the install manifest (original `base_url` plus rollback of the mapping changes) and mark the manifest as restored. The tool stays installed. `--force` overrides the "configuration was changed externally" guard |
| `uninstall` | `stop` plus `restore`, and with `--purge` also deletes the runtime home directory. Without `--purge`, the runtime directory is kept |
| `selftest` | Run the offline rewrite cases plus runtime checks: health endpoint, upstream reachability and a mapping dry-run. No model calls |
| `version` / `help` | Print the version, or the built-in usage text |
| `instance` / `lab` | Multi-instance (lab) management: `create`, `list`, `status`, `start`, `stop`, `env`, `run`, `refresh-catalog`, `update`, `remove`. See [Lab instances](#lab-instances-multi-instance) |

### Global flags

| Flag | Meaning |
| --- | --- |
| `--json` | Machine-readable JSON output, for scripts and dashboards |
| `--dry-run` | `install` / `repair` only: print the change plan and write nothing |
| `--check` | Alias of `--dry-run` for `install` / `repair` |
| `--yes` | Skip the interactive confirmation prompt. Required in a non-interactive shell, because the prompt cannot be answered there |
| `--verbose` | Print troubleshooting detail: resolved paths, port-scan attempts, raw CC Switch detection, mapping diagnostics, exception stack traces, and the recent system commands that were executed. Without this flag the output is unchanged. It can also be turned on permanently through `runtime.verbose` |
| `--no-verbose` | Turn `--verbose` off for a single run, even when `runtime.verbose` is `true` |
| `--port <n>` | Listen port for the layer; applied during `install` / `repair` |
| `--upstream <host:port \| url>` | Upstream endpoint: a CC Switch proxy address or a custom OpenAI-compatible base URL; applied during `install` / `repair` |
| `--reclaim <auto \| notify-only \| off>` | Reclaim policy to store during `install` / `repair` |
| `--allow-remote-upstream` | Suppress the warning about a non-loopback upstream address |
| `--home <dir>` | Runtime home for the layer (defaults to `~/.codex-compat`, or `CODEX_COMPAT_HOME`) |
| `--force-roles` | Allow overwriting a role file that this tool created when its content changed (used when upgrading across template changes) |
| `--refresh-config` | Re-copy the packaged templates and prompt assets into the runtime home (user-edited mappings are replaced) |
| `--refresh-templates` | During `install` / `repair`, also refresh templates and prompts under the managed rule (files you edited are not overwritten) |
| `--force` | With `templates` / `--refresh-templates`: also overwrite templates you edited (backed up first) |
| `--cleanup-legacy` | Also remove scheduled tasks left behind under the legacy `CodexCompatLayer` / `CodexCompatGuard` / `CodexCompatWatch` names |
| `--home <dir>` | Runtime home directory; defaults to `~/.codex-compat` and can also be set with `CODEX_COMPAT_HOME` |

Command-specific flags: `doctor --fix`, `logs --lines N --follow [--file <name>]`, `restore --force`, `uninstall [--purge] [--force]`, `install --no-service --no-deepseek-prompt --no-deepseek-roles` to switch off the corresponding pieces up front, and the `instance` subcommands listed under [Lab instances](#lab-instances-multi-instance).

## Interactive menu

Running `codex-compat` with no arguments opens the menu and prints the status overview as its header. Menu labels follow your system locale (English or Chinese); set `CODEX_COMPAT_LANG` to `en` or `zh` to force one. `0` goes back one level, and exits from the top level.

**Main menu (8 groups)**

| Entry | Meaning |
| --- | --- |
| Status & doctor | The report of `codex-compat status`; it can run `doctor`, and offers to auto-repair configuration-class problems |
| Start / pause / restart | Start or resume, pause temporarily (autostart registration is kept), restart, or stop completely (autostart registration is removed) |
| Install / repair main instance | Run the install pipeline interactively. Before the first install this entry reads "skip the trial and install the main config" |
| Lab instances | Create, list, start, stop, print the environment, launch a temporary Codex CLI, refresh the catalog, or remove a lab instance |
| Feature switches | One panel: DeepSeek prompt optimization, DeepSeek subagent roles, provider catalog hosting, official-only protection, the reclaim policy, the model bindings view, and the `verbose` default |
| Settings | Listen port, upstream, autostart & guard, menu language, and diagnostic trace |
| Tools | Logs, doctor, diagnostic bundle, offline selftest, version, help |
| Danger zone | Emergency bypass, restore from the manifest, uninstall (optional purge), and cleanup of legacy-named scheduled tasks |

When the tool is not installed yet, the menu says so and prepends a first-run wizard: **① create a lab instance and try it → ② attach the main config**. The wizard and the *Lab instances* panel create the same isolated instance that `codex-compat instance create` does, so a new user can validate against a temporary Codex CLI before touching the main configuration.

The feature-switch panel writes through the same `codex-compat config set <key> <value>` path the CLI uses, so the two surfaces cannot diverge. Changing the listen port is stored immediately but only takes effect after `codex-compat repair`, which rewrites the Codex `base_url` and restarts the service.

## Lab instances (multi-instance)

`codex-compat instance <subcommand>` (alias: `codex-compat lab <subcommand>`) manages isolated **lab** instances for experiments and side-by-side runs, without touching the main configuration.

| Subcommand | Purpose |
| --- | --- |
| `instance create <name> --model <id>` | Create an instance. Additional flags: `--provider cc-switch \| http(s)://… \| host:port`, `--models <a,b>`, `--key <plaintext>` or `--key-env <VAR>`, `--catalog-mode instructions\|catalog\|none\|auto` (default `instructions`: write the top-level `model_instructions_file`, the only path verified to deliver the prompt; `catalog` is experimental and needs a Codex that actually fetches a provider catalog — 0.160.1 does not, so it falls back to `none` with a warning; `auto` currently resolves to `instructions` for the same reason), `--autostart` |
| `instance list` | Table of instances: port, upstream, model, running state, masked key and autostart |
| `instance status <name>` | One instance: health probe, process count, upstream, model, catalog mode, masked key and paths |
| `instance start <name>` / `instance stop <name>` | Bring the instance's compatibility layer up or down on demand |
| `instance env <name>` | Print the environment variables and copy-paste commands, with the key masked |
| `instance run <name> [-- <codex args>]` | Launch `codex` with the instance's `CODEX_HOME` and key already injected; everything after `--` is passed through |
| `instance refresh-catalog <name>` | Re-fetch the upstream model list and regenerate the instance's catalog |
| `instance update [<name>]` | Copy the packaged prompt into the instance (`<name>` omitted means every instance). An instance takes its instructions from `model_instructions_file`, so it never picks up a package update on its own; the previous copy is backed up under the instance's `compat/backups/`, and `--dry-run` only reports |
| `instance remove <name>` | Stop the instance and delete its directory |

One instance is a self-contained directory under `~/.codex-compat/instances/<name>/`:

| Path | Contents |
| --- | --- |
| `instance.json` | Instance metadata: name, kind, listen port, upstream, model, catalog mode, key env, autostart |
| `secrets.env` | Written only when you pass `--key`, and masked in every output. With `--key-env <VAR>` nothing is written to disk at all |
| `codex/` | The instance's own `CODEX_HOME` (`config.toml` and session state) |
| `compat/` | The instance's own compatibility-layer runtime home |

Each instance has its own `CODEX_HOME`, its own compatibility home and its own listen port, allocated from `15900` upwards. Instances register **no scheduled task by default**: bring them up and down on demand with `instance start` / `instance stop`. Only an explicit `--autostart` registers the platform autostart and guard tasks (`CodexCompatService-<name>` / `CodexCompatServiceGuard-<name>`).

Typical use: create a lab instance, run `codex-compat instance run <name>` to try a temporary Codex CLI against a gateway model, and wire the main configuration only once you are satisfied — the first-run wizard in the menu is the same flow. `--key` keeps the plaintext key inside the instance directory only (and masks it everywhere else); `--key-env <VAR>` keeps nothing on disk at all.

## Configuration

Persistent settings live in `~/.codex-compat/config.json`. Set `CODEX_COMPAT_HOME` (or pass `--home`) to use a different runtime home.

Precedence: command-line flags > environment variables > configuration file > defaults.

```json
{
  "version": 1,
  "listen": { "host": "127.0.0.1", "port": 15731 },
  "upstream": { "mode": "cc-switch", "host": "127.0.0.1", "port": 15721, "baseUrl": null, "basePath": "/v1" },
  "compat": { "stripAlways": true, "thirdPartyPrefixes": ["ccs-", "ccs/"], "detection": "auto", "outputTokenReplay": "auto", "requestCompression": "auto", "opaqueTaskModels": [] },
  "features": { "deepseekPrompt": true, "deepseekRoles": true, "providerCatalog": false, "officialGuard": true },
  "service": { "autoStart": true, "guard": true, "reclaim": "auto" },
  "runtime": { "logLevel": "info", "trace": false, "lang": "auto", "verbose": false }
}
```

| Key | Meaning |
| --- | --- |
| `listen` | Where the layer listens. Loopback only by default |
| `upstream` | Where rewritten traffic is forwarded. Either `host`/`port`, or `baseUrl` for a custom endpoint. `basePath` (default `/v1`) is the path prefix used when composing the address that Codex points at |
| `compat.stripAlways` | `true` 默认对所有父模型剥离已知协作工具的加密标记；`false` 保留历史的官方父请求混用检测 |
| `compat.outputTokenReplay` | `auto / strip / preserve`；自动模式只在已知官方通道保留输出回放选择器，对外部路由仅过滤 `output.encrypted_content`，不删除历史密文 |
| `compat.requestCompression` | `auto / decode / preserve`；外部路由自动解压，正文已改写时 `preserve` 也不能保留旧编码声明 |
| `compat.opaqueTaskModels` | 默认 `[]`；仅给已验证上游列出精确模型名称，不支持通配符，也不证明历史密文来源兼容 |
| `compat.thirdPartyPrefixes` | Model id prefixes treated as third-party (`ccs-`, `ccs/` by default). Add your gateway's prefix scheme here |
| `compat.detection` | Third-party detection mode (`auto`, or an explicit list) |
| `features.deepseekPrompt` | Keep the fused DeepSeek prompt template in sync |
| `features.deepseekRoles` | Keep the DeepSeek subagent roles registered |
| `features.providerCatalog` | Host a provider-level model catalog when there is no global `model_catalog_json` (see [Provider model catalog hosting](#provider-model-catalog-hosting)). Off by default: verified as not effective on Codex 0.160.1 |
| `features.officialGuard` | Refuse to write prompt or catalog entries for official-looking model names (`gpt-*`, `codex-*`, `o<N>`) |
| `service.autoStart` | Register autostart for the current platform |
| `service.guard` | Keep the guard process that restarts the layer after a crash |
| `service.reclaim` | What to do when CC Switch stops taking over Codex: `auto` (take the traffic back automatically), `notify-only` (tell me), `off` (do nothing) |
| `service.templateRefresh` | What to do when the templates and prompts in the runtime home differ from the packaged ones: `auto` (refresh files you did not edit and notify), `notify-only` (only tell me; refresh by hand), `off` (do not check or act). Defaults to `auto` |
| `runtime.logLevel` | Log verbosity |
| `runtime.trace` | Diagnostic tracing flag; off by default. Trace output is only produced when tracing is switched on explicitly for a debugging session (see [PRIVACY.md](PRIVACY.md)) |
| `runtime.lang` | Menu language: `auto` (detect once at install time), `zh`, or `en`. Also overridable per run with `CODEX_COMPAT_LANG` |
| `runtime.verbose` | Persistent default for `--verbose` (default `false`); `--no-verbose` turns it off for a single run |

### 输出回放、摘要与配置边界

`output.encrypted_content` 是额外输出回放选择器，不是 `reasoning.encrypted_content`，也不是历史密文。自动策略只过滤前者；其他选择器、历史输出/推理/原生压缩密文和上游响应均保留。过滤不承诺保留原始输出 token 的精确回放收益，也不证明设备签发或跨后端密文可用。

外部路由默认解压 `zstd / gzip / deflate`；解压、UTF-8 或 JSON 根节点检查失败在本地返回 400，超限返回 413，不转发坏字节。经 CC Switch 的摘要保留；绕过它时仅严格还原 `ccswitch-compaction-v1:` 文本为普通 user 消息，损坏或未知版本拒绝。这不恢复原始 token、缓存或全部工具状态。

`compat.opaqueTaskModels` 和 `compat.thirdPartyPrefixes` 的配置 CLI 支持 JSON 字符串数组，例如 `codex-compat config set compat.opaqueTaskModels '["vendor/verified-model"]'`。名单只应包含已验证的精确模型。修改 `compat.*` 只保存兼容配置，不再同步模型目录；运行中的兼容进程仍需重新加载配置才会生效。`COMPAT_OUTPUT_TOKEN_REPLAY` 与 `COMPAT_REQUEST_COMPRESSION` 可临时覆盖文件中的对应策略。

Read and write these from the CLI with dotted keys:

```bash
codex-compat config list
codex-compat config get service.reclaim
codex-compat config set service.reclaim notify-only
```

Changing `listen.port` is stored immediately, but the Codex `base_url` is only rewritten (and the service restarted) by `codex-compat repair`.

Runtime home layout:

| Path | Contents |
| --- | --- |
| `~/.codex-compat/config.json` | Persistent settings |
| `~/.codex-compat/config/` | Model and role templates, plus the fused prompt templates |
| `~/.codex-compat/logs/` | Rewrite counters, guard events, trace output (when enabled) |
| `~/.codex-compat/backups/` | Backups taken before every write |
| `~/.codex-compat/run/` | Locks and runtime flags |
| `~/.codex-compat/state/` | Runtime state directory, allocated at install time |
| `~/.codex-compat/diagnostics/` | Diagnostic bundles, created only when you ask for one |
| `~/.codex-compat/install-manifest.json` | What the installer changed, used by `restore` and `uninstall` |

## DeepSeek prompt optimization

`config/prompts/deepseek-codex.md` keeps the fused prompt template used for DeepSeek subagents. It exists because DeepSeek subagents tend to stop early or run empty after a task arrives: the template keeps the DeepSeek Codex integration baseline and adds explicit instruction-priority, engineering-judgement and end-to-end execution-responsibility constraints.

Template provenance:

- The DeepSeek Codex integration guidance published by DeepSeek: <https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/>
- Constraints and role instructions authored by **程小帮** (credited by name, with thanks).

Both sources are credited in text; no third-party tooling, memory layer or runtime path from those sources is bundled. The switches for this feature live in the menu under *Feature switches*, and in `features` in the configuration file.

## Provider model catalog hosting

**Status: Codex does not support this path yet.** It ships implemented and **off by default**, kept only as a possible future route.

With no global `model_catalog_json`, prompt templates can only reach a model through a provider-level catalog. The compatibility layer serves one at `GET /__compat/catalog`, and writes `model_catalog_url` into the provider only when **both** of these hold:

- there is no global `model_catalog_json`, and
- the upstream `/models` response is **not** already a Codex-native catalog — that is, its entries carry no `model_messages` / `base_instructions` fields.

If the upstream is already native (for example a CC Switch that ships its own catalog) or the refresh fails, the layer keeps the existing value and reclaims a key it wrote earlier, instead of overwriting a richer catalog with neutral placeholder metadata. `features.providerCatalog` (default off) controls this, and `doctor` reports a `provider-catalog` check whenever there is no global catalog.

Why it is off, verified on Codex 0.160.1 (2026-10):

- **The key exists.** `model_catalog_url` is already a recognised provider key in 0.160.1 — it sits alongside `base_url`, `env_key`, `env_key_instructions` and `experimental_bearer_token`, and writing it raises no unrecognized-setting warning.
- **The CLI never fetches it.** With a valid `model_catalog_url` on a lab instance — the layer really serves a 36 KB `/__compat/catalog` — `codex debug models` (the official "Render the raw model catalog as JSON") returns `{"models":[]}` and the layer records zero requests to that endpoint. `codex features list` shows the switch states behind that: `api_key_model_discovery` is `under development` (false) and `remote_models` is `removed`, which is also why adding `[features] api_key_model_discovery = true` or `remote_models = true` does not trigger model discovery. So the blocker is a capability that is still under development, not a newer build on this machine and not something this layer has already fixed.
- **How the prompt is delivered instead.** In a lab instance it is `model_instructions_file`, which only takes effect as a **top-level** key (placed inside the `[model_providers.<id>]` table, Codex reports it as an unrecognized configuration setting and ignores it); with that form the instructions traced by the layer match the repository template character for character (23,498 vs 23,499 characters — only the trailing newline differs). In the CC Switch case the template is carried by a model catalog entry that already exists in the environment — in the catalog CC Switch maintains (for example `~/.codex/cc-switch-model-catalog.json`), the `ccs-deepseek/deepseek-v4.1-flash` and `ccs-deepseek/auto(free)` entries hold the repository template as `base_instructions` / `model_messages.instructions_template` (23,499 characters), and a real main-instance `codex exec` session confirmed the client request body matched the template character for character. Which configuration pointer hands that catalog to Codex is decided by the upstream tool and was not determined here; this layer only writes the template into the catalog entry. Note that `~/.codex/models_cache.json` is a stale cache (for example a 2026-09-24 file whose DeepSeek entry carries only a 68-character template), not the effective source.
- **When to re-verify.** Once Codex promotes provider-configured model discovery to stable — that is, `api_key_model_discovery` moving from under development to stable.

`model_providers.<id>.model_catalog_url` requires Codex ≥ 0.156. On older versions the layer does not write that key: a lab instance should use `model_instructions_file` as a top-level key instead, a mode that is verified to deliver the prompt in the lab (single-provider home); the main instance is still not a fit for it (shared, multi-provider home) and keeps using the model catalog already present in the environment, which the upstream tool decides how to hand to Codex.

### Model bindings and fuzzy matching

`config/mappings.toml` binds a model id to a prompt template and a subagent role. Besides the exact `model_id`, a binding can carry `model_id_like`, matched case-insensitively against the **last segment** of the model id: `like = "deepseek-v4.1-flash"` matches `ccs-deepseek/deepseek-v4.1-flash`, so the same binding keeps working when the vendor prefix changes. An exact `model_id` always wins; zero matches raise a `missing_model` warning, more than one match raises `ambiguous_model` and skips the binding, and each model is managed by exactly one binding. The shipped `config/mappings.toml` now writes both `model_id` and `model_id_like` for every binding.

### Official-only protection

`features.officialGuard` (default on) refuses to write prompt or catalog entries for models whose names look official — `gpt-*`, `codex-*` and `o<N>`. A pure-official setup (no third-party provider) fails `install` outright with **zero writes, zero processes and zero scheduled tasks**. `doctor` reports `official-untouched` (no official-looking model is managed) alongside `provider-catalog`.

Note that `[features.multi_agent_v2]` (`enabled = true`, `tool_namespace = "agents"`) is written globally and therefore also applies to official-model sessions: it is the prerequisite for cross-provider subagents and is unrelated to the prompt content. `model_provider` itself is set by CC Switch, not by this tool.

## Logs and privacy

- No telemetry and no call-home of any kind: the layer only talks to the upstream endpoint you configured, on your machine.
- Normal logs record counters, model names and event types only. Task bodies and authentication headers are never written to disk.
- Diagnostic tracing is off by default and only produces output when you switch it on explicitly. It writes request metadata and short head/tail snippets, plus at most the most recent instructions text per model, all size-capped; task bodies, model output and authentication headers are still not written.

Full details: [PRIVACY.md](PRIVACY.md).

## Troubleshooting

**A Codex upgrade broke cross-provider delivery.**

1. Run `codex-compat doctor` and read the failing checks.
2. Run `codex-compat logs` and look at the `rewrite` counters. If delegation used to produce non-zero `stripped` / `projected` counts and now produces zero, the request shape has most likely changed.
3. Run `codex-compat bypass` to unblock your work immediately, and `codex-compat repair` when you want the layer back in the path.
4. Run `codex-compat doctor --fix` (or `repair`) to re-apply the configuration that an upgrade may have overwritten.
5. If the request shape really changed, the rewrite rules need a code change, not a configuration change. Include the `doctor` output and (if enabled) a redacted trace when you report it.

**How do I bypass the layer?**

`codex-compat bypass` writes the original upstream address (recorded in the install manifest at install time) back into the Codex configuration, so Codex talks directly to your upstream again while the layer keeps running in the background. `codex-compat repair` re-attaches the layer.

**How do I uninstall and roll back?**

Three levels, depending on how much you want to undo:

```bash
codex-compat restore            # roll the Codex configuration back, keep the tool installed
codex-compat uninstall          # stop the service, restore the configuration, keep the runtime directory
codex-compat uninstall --purge  # the same, and also delete the runtime directory
```

`restore` and `uninstall` are not dry-run commands; they act on the install manifest, which lists exactly what the installer changed. If the Codex configuration was edited externally and the rollback refuses to overwrite it, review the change and use `--force` if you are sure. Backups taken before each write are in `~/.codex-compat/backups/`.

**Port 15731 is already in use.**

The installer scans `15732`–`15831` and stores the chosen port, and you can also pass `--port <n>`. If the port is answered by another instance of this tool, that instance is reused rather than duplicated.

To move the port afterwards, run `codex-compat config set listen.port <n>` followed by `codex-compat repair`, which rewrites the Codex `base_url` and restarts the service.

**The subagent still reports an empty task.**

Check that your model ids are recognized as third-party: the default prefixes are `ccs-` and `ccs/`. Inspect the current value with `codex-compat config get compat.thirdPartyPrefixes`; if your gateway uses a different id scheme, add its prefix in `~/.codex-compat/config.json` and run `codex-compat restart`. Also confirm that the request actually passes through the layer — `codex-compat status` shows the `base_url` Codex currently has and whether it matches the layer.

**CC Switch says it is in direct mode.**

The layer only sees traffic while CC Switch takes over Codex through its local proxy. Turn the local proxy on, or point `--upstream` at your own endpoint. The status line tells you which of the two states you are in.

**Is it a problem that the installer rewrites my Codex configuration?**

Every write is backed up, recorded in the install manifest, and reversible with `restore` / `uninstall`. Use `install --dry-run` (or `repair --dry-run`) whenever you want to see the change list first.

## Compatibility summary

| Dimension | Status |
| --- | --- |
| Windows | Verified on a real machine (install, restore, autostart, notifications, five delegation combinations) |
| macOS | Implemented, experimental; covered by CI, not yet verified on real hardware |
| Linux | Implemented, experimental; covered by CI, not yet verified on real hardware |
| Node.js | 18 or newer required |
| Codex | Multi-Agent V2 capable versions; depends on undocumented behaviour, so re-verify after upgrades |
| Upstream | CC Switch local proxy (default) and custom OpenAI-compatible endpoints |
| Lab instances (multi-instance) | Implemented, experimental; isolated `CODEX_HOME`, ports from `15900`, no scheduled task unless `--autostart` |
| Provider model catalog | Implemented but disabled by default; verified as not effective on Codex 0.160.1. When enabled, it is hosted only with no global catalog and a non-native upstream `/models`; `model_catalog_url` needs Codex ≥ 0.156 |

The full matrix, including per-combination results: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Verified baseline and rollback

Verified baseline: **`@openai/codex` 0.160.1**, on Windows real hardware — main-instance delegation, `codex exec` in a lab instance, and prompt delivery verified character by character. Node.js ≥ 18 is required. macOS and Linux are covered by CI only; they have not been verified on real hardware.

If a Codex upgrade breaks delegation, roll back in this order:

1. `codex-compat bypass` — points Codex's `base_url` back at the original upstream, so traffic flows again first.
2. `npm i -g @openai/codex@0.160.1` — falls the Codex CLI back to the verified baseline.
3. `codex-compat doctor` — re-checks the environment; the `codex-version` line reports whether you are back on the baseline.

`codex-compat doctor` adds a `codex-version` check that compares the detected CLI version against this baseline — `Codex 0.160.1 (verified baseline)` when they match, and `Codex <current> (verified baseline 0.160.1; roll back to this version if you hit problems)` when they differ (the baseline is appended when the version cannot be probed). The line follows the menu language and is display-only: it never fails the check, so you never have to guess which version this tool was verified against.

## Security

This tool sits in the path that carries your credentials, because it forwards requests to your upstream. It never stores credentials, never logs authentication headers, and never attempts to decrypt official ciphertext. Please report suspected vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Contributing

Bug reports, documentation fixes, platform verification and prompt-template evidence are all welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Non-affiliation

`codex-compat` is an independent, unofficial project. It is not affiliated with, endorsed by, or supported by OpenAI, DeepSeek, or CC Switch. Product names are used only to describe interoperability. The project relies on Codex behaviour that is not part of any public contract, so it can stop working without notice; `codex-compat bypass` and `codex-compat restore` are provided so that you can always get out of the way.

## Acknowledgements

- Cross-provider delivery design references **BigStrongSun/ccswitchmulti** and **farion1231/cc-switch** (both MIT, Copyright (c) 2025 Jason Young).
- The DeepSeek prompt template includes the official DeepSeek Codex integration guidance and constraints authored by **程小帮**.
- Full license texts and copyright lines: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT covers the source code of this project — see [LICENSE](LICENSE) and [CHANGELOG.md](CHANGELOG.md).

One file is excluded from that grant: `config/prompts/deepseek-codex.md` is a fused document that contains third-party text (Codex agent instructions, DeepSeek integration guidance, and constraint text credited to 程小帮). If you want to reuse that file, clear those sources yourself — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
