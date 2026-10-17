# codex-compat

`codex-compat` 是一个本机兼容层，用于保证 **Codex Multi-Agent V2 的子代理投递**在跨 provider 场景下依然可用：例如官方模型把任务派给 DeepSeek 之类的网关模型，或者网关模型把任务派回官方模型。

它运行在你自己的机器上，位于 Codex 客户端与你已经在用的上游之间（默认是本地 CC Switch 代理，也可以是任意自定义 OpenAI 兼容端点），只改写真正会出问题的请求形态。

| 项目 | 值 |
| --- | --- |
| npm 包名 | `codex-compat` |
| CLI 命令 | `codex-compat` |
| 版本 | 0.1.0 |
| 许可 | MIT |
| 运行时 | Node.js 18 及以上 |
| 默认监听地址 | `127.0.0.1:15731` |
| 默认上游 | `127.0.0.1:15721`（CC Switch 本地代理） |
| 英文 README | [README.md](README.md) |

**本项目是非官方社区项目，与 OpenAI、DeepSeek、CC Switch 均无隶属关系。** 它依赖 Codex 的未公开行为，Codex 升级后可能失效。`codex-compat bypass` 就是为这种情况准备的应急出口。

深入文档：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 它解决什么问题

Codex Multi-Agent V2 会把子代理的**任务正文**装进 `encrypted_content` 容器。同 provider 内部一切正常，一旦任务跨 provider，问题就出现了：

| 现象 | 根因 |
| --- | --- |
| 子代理正常启动，但说没有收到任务（Payload 为空） | 第三方网关不认识 `encrypted_content` 这个内容块类型，整块丢弃，模型只看到消息头 |
| 官方子代理断流：`Encrypted function output content could not be decrypted or decoded.` | 容器里装的是明文，官方后端却一定要解密 |
| 上游返回 HTTP 400：`Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` | 委派创建的新会话以孤立的 `function_call_output`（委派块）开头，没有配对的 `function_call`；官方下游容忍，按 Chat 协议校验的网关会整单拒绝 |

容器名与内容是否真的加密**没有强绑定**：官方后端看到 `encrypted: true` 标记就加密，网关忽略这个标记、直接产出明文。两种结果都装进同一个 `encrypted_content` 容器，这正是这一整类故障的总根源。

## 工作原理

请求链路：

```
Codex 客户端
   │  base_url = http://127.0.0.1:15731/v1
   ▼
codex-compat  （监听 127.0.0.1:15731，按条件转发 + 改写）
   │
   ▼
上游  （默认 127.0.0.1:15721 的 CC Switch 本地代理；
       也可以是任意自定义 OpenAI 兼容端点）
   │
   ├── 官方模型  ->  官方 Codex 后端
   └── 网关模型  ->  第三方 OpenAI 兼容网关
```

兼容层是**透明转发 + 少量条件改写**：不持有任何凭据，不做路由决策，所有 header 原样透传。

### 三个阶段

| 阶段 | 作用范围 | 做的事 |
| --- | --- | --- |
| **阶段 A：剥离加密标记** | 官方主控且请求中引用了第三方模型（`compat.stripAlways` 为 true 时对所有官方主控请求生效，默认即如此） | 删除协作工具（`spawn_agent`、`send_message`、`followup_task`）`message` 字段上的 `encrypted: true` 标记，让官方后端返回明文参数而不是密文 |
| **阶段 B：投影明文容器** | 所有请求 | 把明文从 `encrypted_content` 容器搬进标准 `role: "user"` 消息。两类下游都需要：官方后端不能看到「待在需要解密的容器里的明文」，网关则完全不认识这个容器块类型 |
| **阶段 C：密文投递守卫** | 下游为第三方模型的请求 | 如果真密文（Fernet 形态，`gAAAAAB…` 前缀）将要投递给第三方子代理，显式返回 HTTP 400（`compat_layer_reject`），绝不静默投递空任务 |

### 一项输入归一化

网关上游按 Chat 协议校验，要求 `role: "tool"` 的消息必须紧跟带 `tool_calls` 的助手消息。兼容层因此会把孤立工具输出（例如「从其他任务发送」产生的委派块）改写为普通 `user` 消息并保留正文；空正文的孤立输出直接移除。配对正常的工具输出原样透传。

### 非法工具参数修复

工具调用的 `arguments` 必须是合法 JSON，而网关模型偶尔会把枚举值写成裸词。2026-10-14 与 2026-10-16 各出现一次 `"fork_turns": none`：Codex 本地解析失败却仍把原始字符串写进会话历史，之后每一轮请求都重放它，于是网关以 `HTTP 400 … input[572].arguments … invalid character 'o' in literal null (expecting 'u')` 拒掉整个请求，重试永远无法恢复该会话。第二次发生时模型模板里的加固（三份拷贝均已核对一致）已经在生效，说明加固能降低概率但不能清零。

因此兼容层在转发前把「值位置上的裸词」补成字符串。只处理值位置：扫描时跟踪字符串状态，消息正文里出现同样文字绝不改动。修完必须能通过 JSON.parse 才采用，否则原样转发 —— 绝不发出半成品请求。每次修复记一条 `args_repaired` 事件，只带工具名与那个裸词（不记参数正文），并在健康端点累加 `argsRepaired`。

### 前置条件

- Node.js 18 及以上。
- Codex 已安装且至少启动过一次，并且 `~/.codex/config.toml` 里至少有一个 `model_providers` 条目。安装器接入的是这个已有条目、改写它的 `base_url`，不会自己造一个 provider；找不到可接入条目时预检会直接报错并说明原因。
- CC Switch 是**可选项**。不装也可以，用 `--upstream <host:port | url>`（或改配置文件里的 `upstream`）把兼容层指向任意实现了 Responses API 的自定义 OpenAI 兼容端点。

## 安装

在本地源码目录中执行：

```bash
cd <项目目录>
npm ci
node bin/codex-compat.cjs install
```

如果希望直接使用 `codex-compat` 短命令，可以在本地建立链接（不涉及任何仓库发布）：

```bash
npm link
codex-compat status
```

仓库的 `install/` 目录还提供引导安装脚本：PowerShell 使用 `install.ps1`，POSIX shell 使用 `install.sh`。两者都会先校验 Node.js 18 及以上，再替你执行全局安装与 `codex-compat install`；想先看将要执行的命令，用它们的 dry-run 开关。

`install` 是幂等的，它会：

1. 校验上面的前置条件。
2. 备份并更新 Codex 配置，让客户端连到兼容层，并把 Multi-Agent V2 变成显式配置（写入 `tool_namespace = "agents"` 与显式的 Multi-Agent V2 开关）。
3. 选择合适的监听端口：默认 `15731`，被占用时在 `15732`–`15831` 范围内扫描。如果该端口已经由本工具的另一个实例应答，则复用该实例，不重复启动。
4. 同步 DeepSeek 模型模板与子代理角色（两项都可以在设置里关闭）。
5. 按当前平台注册登录自启与守护进程。
6. 把它改过的内容记入 `~/.codex-compat/install-manifest.json`（provider 键、原始 `base_url`、监听与上游地址、映射变更 ID、创建的角色文件），使 `restore` 与 `uninstall` 可以精确回退。

`install` 与 `repair` 支持 `--dry-run`：只打印完整的改动计划，不写入任何文件；非交互环境还需要加 `--yes`。`doctor` 默认只读，加 `--fix` 才会重跑安装流程修复配置类问题。

## 快速开始

不想动主配置？

- **零风险先试跑：** `codex-compat instance create <名称> --provider cc-switch --model <模型>`，再执行 `codex-compat instance run <名称>`——实例自带独立 `CODEX_HOME` 与独立端口，完全不动主配置。
- **想接入主配置：** `codex-compat install`。
- **想反悔：** `codex-compat restore`（按安装清单精确还原）或 `codex-compat uninstall`（卸载时一并还原）。

完整接入流程：

1. 执行 `codex-compat install`（或 `node bin/codex-compat.cjs install`）。
2. 重启 Codex。配置在启动时读取，已开着的会话仍然使用旧配置。
3. 执行 `codex-compat status` 看状态总览，或执行 `codex-compat doctor` 做一次完整体检（加 `--fix` 可以让它修复配置类问题）。
4. 直接执行 `codex-compat`（不带参数）打开菜单，确认兼容层正在运行。
5. 让 Codex 派一个网关模型的子代理，然后执行 `codex-compat logs`：一次成功的跨 provider 派发会产生带非零计数的 `rewrite` 事件。

## 命令

| 命令 | 作用 |
| --- | --- |
| `install` | 首次安装：预检、落位用户配置、把 Codex 指向兼容层、显式开启 Multi-Agent V2、同步模板与角色、注册自启与守护、写入安装清单，最后做健康检查；加 `--dry-run` 只打印计划 |
| `repair` | 重跑同一套安装流程：用于从 `bypass` 状态重新接入，或修复被 CC Switch / Codex 升级覆盖的配置 |
| `start` | 清除「有意停止」标记、按配置注册服务与守护，并等待健康检查通过；`pause` / `stop` 之后也用它恢复 |
| `pause` | 结束运行中的进程，并留下标记避免守护立即拉起；保留自启注册（下次登录仍会启动）。用 `start` 恢复 |
| `stop` | 在 `pause` 基础上再取消守护与自启注册（重新启用仍用 `start`） |
| `restart` | 等价于先 `stop` 再 `start` |
| `status` | 状态总览：版本、运行目录、监听地址、健康检查、上游、Codex 当前的 `base_url`、配置一致性（漂移检测）、服务与守护状态、抢回策略、DeepSeek 开关、CC Switch 状态、安装清单 |
| `doctor` | 体检报告：预检项、健康端点、服务与守护注册、日志中的异常事件、映射与模板同步状态、旧版残留；`--fix` 会重跑安装流程修复配置类问题 |
| `logs` | 查看或跟随日志：`--lines N`（默认 40）、`--follow`、`--file <文件名>` |
| `config` | `config list` / `config get <key>` / `config set <key> <value>`，键用点号分层，例如 `codex-compat config set service.reclaim auto` |
| `templates` | 把包内模板与提示词刷新到运行目录（第一跳）：只刷新未被本地改过的文件，本地改过的默认跳过，加 `--force` 才覆盖（覆盖前备份）；`--dry-run` 只报告 |
| `bypass` | 应急旁路：把安装清单里记录的原始上游地址写回 Codex 配置；兼容层仍在运行但不再参与流量。用 `repair` 重新接入 |
| `restore` | 按安装清单还原 Codex 配置（原始 `base_url` + 回滚映射变更），并把清单标记为已还原；工具本身保留。`--force` 可越过「配置被外部修改」的保护 |
| `uninstall` | 先 `stop` 再 `restore`；加 `--purge` 会一并删除运行目录，不加则保留运行目录 |
| `selftest` | 跑离线改写用例 + 运行态自检：健康端点、上游可达性、映射预演；不调用模型 |
| `version` / `help` | 查看版本，或查看内置用法说明 |
| `instance` / `lab` | 多实例（实验 / 多开）管理：`create`、`list`、`status`、`start`、`stop`、`env`、`run`、`refresh-catalog`、`update`、`remove`；详见下方「实验实例」一节 |

### 全局参数

| 参数 | 含义 |
| --- | --- |
| `--json` | 输出机器可读的 JSON，便于脚本与看板消费 |
| `--dry-run` | 仅对 `install` / `repair` 生效：只打印改动计划，不写入任何内容 |
| `--check` | `install` / `repair` 的 `--dry-run` 别名 |
| `--yes` | 跳过交互确认。非交互终端必须加，否则无法应答确认提示 |
| `--verbose` | 输出排查细节：解析出的路径、端口尝试明细、CC Switch 原始探测、映射诊断、异常堆栈与最近执行的系统命令；不加该参数时输出保持原样。也可通过 `runtime.verbose` 长期打开 |
| `--no-verbose` | 单次运行临时关闭 `--verbose`，即使 `runtime.verbose` 为 `true` |
| `--port <n>` | 兼容层监听端口；在 `install` / `repair` 时生效 |
| `--upstream <host:port \| url>` | 上游端点：CC Switch 代理地址，或自定义 OpenAI 兼容 base URL；在 `install` / `repair` 时生效 |
| `--reclaim <auto \| notify-only \| off>` | 在 `install` / `repair` 时写入的抢回档位 |
| `--allow-remote-upstream` | 抑制「上游不是本机地址」的告警 |
| `--home <dir>` | 运行态根目录，默认 `~/.codex-compat`，也可用 `CODEX_COMPAT_HOME` 指定 |
| `--force-roles` | 允许用当前模板覆盖「本工具创建过、但内容已变化」的角色文件（跨模板升级时使用） |
| `--refresh-config` | 把包内模板与提示词重新落位到运行目录（用户改过的 mappings 会被替换） |
| `--refresh-templates` | 在 `install` / `repair` 时顺带按受管语义刷新模板与提示词（不覆盖本地改过的文件） |
| `--force` | 与 `templates` / `--refresh-templates` 一起使用时，连本地改过的模板一并覆盖（覆盖前备份） |
| `--cleanup-legacy` | 同时清理旧命名的计划任务：`CodexCompatLayer` / `CodexCompatGuard` / `CodexCompatWatch` |

命令级参数：`doctor --fix`、`logs --lines N --follow [--file <名字>]`、`restore --force`、`uninstall [--purge] [--force]`、`install --no-service --no-deepseek-prompt --no-deepseek-roles`（安装时直接关掉对应部分），以及下方「实验实例」一节的 `instance` 子命令。

## 交互菜单

直接执行 `codex-compat`（不带参数）会打开菜单，并在每次循环的头部打印状态总览。菜单文案跟随系统区域自动切换中文 / 英文，也可用 `CODEX_COMPAT_LANG=zh`（或 `en`）强制指定。输入 `0` 返回上一级，在顶层输入 `0` 即退出。

**主菜单（8 组）**

| 菜单项 | 含义 |
| --- | --- |
| 状态与体检 | 等价于 `codex-compat status` 的报告；可执行 `doctor`，并询问是否自动修复配置类问题 |
| 启动 / 暂停 / 重启 | 启动或恢复、临时暂停（保留自启注册）、重启，或完全停止（取消自启注册） |
| 安装 / 修复主实例 | 以交互方式执行安装流程；首次安装前该项显示为「跳过试跑，直接安装主配置」 |
| 实验实例 | 新建、列出、启动、停止、打印环境变量、直接拉起临时 Codex CLI、刷新模型目录、删除实例 |
| 功能开关 | 集中控制：DeepSeek 提示词优化、DeepSeek 子代理角色、provider 目录托管、纯官方保护、抢回档位、模型绑定查看、verbose 默认值 |
| 设置 | 监听端口、上游地址、自启与守护、菜单语言、诊断追踪 |
| 工具 | 日志、体检、诊断包、离线自检、版本、帮助 |
| 危险操作 | 应急旁路、按清单还原、卸载（可选删除运行目录）、清理旧命名计划任务 |

尚未安装时，菜单会给出提示，并把首项置为首次接入向导：**① 先建实验实例试跑 → ② 验证 OK 再接入主配置**。向导与「实验实例」面板创建的是同一种隔离实例（等价于 `codex-compat instance create`），因此新用户可以先在临时 Codex CLI 上验证，再动主配置。

功能开关面板与命令行走同一条 `codex-compat config set <key> <value>` 写入路径，两个入口不会出现口径不一致。修改监听端口会立即写入配置，但要执行 `codex-compat repair` 才会改写 Codex 的 `base_url` 并重启服务。

## 实验实例（多开 / 临时 Codex）

`codex-compat instance <子命令>`（别名：`codex-compat lab <子命令>`）用于管理相互隔离的 **lab 实例**，适合实验与多开，不会动到主配置。

| 子命令 | 作用 |
| --- | --- |
| `instance create <名称> --model <模型>` | 新建实例。附加参数：`--provider cc-switch \| http(s)://… \| host:port`、`--models <a,b>`、`--key <明文>` 或 `--key-env <变量名>`、`--catalog-mode instructions\|catalog\|none\|auto`（默认 `instructions`：写顶层 `model_instructions_file`，也是目前唯一实测能送达提示词的路径；`catalog` 为实验性，需要 Codex 真的去拉 provider 目录——0.160.1 不会，托管不了时降级为 `none` 并告警；`auto` 因同一原因目前等价于 `instructions`）、`--autostart` |
| `instance list` | 实例列表：端口、上游、模型、运行状态、掩码后的密钥、是否自启 |
| `instance status <名称>` | 单个实例：健康探测、进程数、上游、模型、模型目录模式、掩码后的密钥与路径 |
| `instance start <名称>` / `instance stop <名称>` | 按需启停该实例的兼容层 |
| `instance env <名称>` | 打印环境变量与可复制命令，密钥只出现掩码 |
| `instance run <名称> [-- <codex 参数>]` | 注入实例的 `CODEX_HOME` 与密钥后拉起 `codex`；`--` 之后的参数原样透传 |
| `instance refresh-catalog <名称>` | 重新拉取上游模型列表并生成该实例的模型目录 |
| `instance update [<名称>]` | 把包内提示词刷到实例（省略名称 = 全部实例）。实例的提示词由 `model_instructions_file` 指向实例目录，不会自己跟上包内更新；覆盖前把旧版备份到实例的 `compat/backups/`，`--dry-run` 只报告 |
| `instance remove <名称>` | 停止实例并删除其目录 |

一个实例就是 `~/.codex-compat/instances/<名称>/` 下一个自包含目录：

| 路径 | 内容 |
| --- | --- |
| `instance.json` | 实例元数据：名称、类型、监听端口、上游、模型、模型目录模式、密钥环境变量名、是否自启 |
| `secrets.env` | 仅在传入 `--key` 时写入，且任何输出都只出现掩码；用 `--key-env <变量名>` 时完全不落盘 |
| `codex/` | 实例专属的 `CODEX_HOME`（自己的 `config.toml` 与会话状态） |
| `compat/` | 实例专属的兼容层运行目录 |

每个实例都有独立的 `CODEX_HOME`、独立的兼容层运行目录与独立端口（从 `15900` 起分配）。实例**默认不注册任何计划任务**：需要时用 `instance start` / `instance stop` 手动启停；只有显式加 `--autostart` 才会注册当前平台的自启与守护任务（`CodexCompatService-<名称>` / `CodexCompatServiceGuard-<名称>`）。

典型用法：先建一个实验实例，用 `codex-compat instance run <名称>` 拉起临时 Codex CLI 试跑网关模型，确认满意后再接入主配置——菜单里的首次接入向导就是这条路径。`--key` 只把明文密钥留在实例目录里（其他位置一律掩码），`--key-env <变量名>` 则完全不在磁盘上留密钥。

## 配置

持久化配置位于 `~/.codex-compat/config.json`。设置 `CODEX_COMPAT_HOME`（或传 `--home`）可以换一个运行态根目录。

生效优先级：命令行参数 > 环境变量 > 配置文件 > 默认值。

```json
{
  "version": 1,
  "listen": { "host": "127.0.0.1", "port": 15731 },
  "upstream": { "mode": "cc-switch", "host": "127.0.0.1", "port": 15721, "baseUrl": null, "basePath": "/v1" },
  "compat": { "stripAlways": true, "thirdPartyPrefixes": ["ccs-", "ccs/"], "detection": "auto" },
  "features": { "deepseekPrompt": true, "deepseekRoles": true, "providerCatalog": false, "officialGuard": true },
  "service": { "autoStart": true, "guard": true, "reclaim": "auto" },
  "runtime": { "logLevel": "info", "trace": false, "lang": "auto", "verbose": false }
}
```

| 配置项 | 含义 |
| --- | --- |
| `listen` | 监听地址，默认只监听回环地址 |
| `upstream` | 改写后转发的上游：用 `host`/`port`，或用 `baseUrl` 指向自定义端点；`basePath`（默认 `/v1`）是拼接 Codex 指向地址时使用的路径前缀 |
| `compat.stripAlways` | 为 `true` 时对所有官方主控请求剥离加密标记；为 `false` 时收窄为「请求中引用了第三方模型」的请求 |
| `compat.thirdPartyPrefixes` | 判定为第三方的模型 ID 前缀（默认 `ccs-`、`ccs/`）。自建网关的前缀请在此补充 |
| `compat.detection` | 第三方判定模式（`auto`，或显式列表） |
| `features.deepseekPrompt` | 是否持续同步融合版 DeepSeek 提示词模板 |
| `features.deepseekRoles` | 是否持续维护 DeepSeek 子代理角色注册 |
| `features.providerCatalog` | 无全局 `model_catalog_json` 时，是否托管 provider 级模型目录（详见「provider 模型目录托管」）。默认关闭：已实测在 Codex 0.160.1 不生效 |
| `features.officialGuard` | 是否拒绝为官方命名模型（`gpt-*`、`codex-*`、`o<N>`）写入提示词或目录条目 |
| `service.autoStart` | 是否注册当前平台的登录自启 |
| `service.guard` | 是否保留崩溃后自动重启的守护进程 |
| `service.reclaim` | CC Switch 不再接管 Codex 时的行为：`auto`（自动把流量抢回兼容层链路）、`notify-only`（仅提醒）、`off`（不处理） |
| `service.templateRefresh` | 运行目录里的模板/提示词与包内不一致时的行为：`auto`（自动刷新未被本地改过的文件并通知）、`notify-only`（仅提醒，手动刷新）、`off`（不检查不动作）。默认 `auto` |
| `runtime.logLevel` | 日志详细程度 |
| `runtime.trace` | 诊断追踪标记，默认关闭；只有为排障显式打开追踪时才会产生追踪输出（详见 [PRIVACY.md](PRIVACY.md)） |
| `runtime.lang` | 菜单语言：`auto`（安装时自动探测一次）、`zh` 或 `en`；也可用 `CODEX_COMPAT_LANG` 临时覆盖 |
| `runtime.verbose` | `--verbose` 的持久默认值（默认 `false`）；`--no-verbose` 可对单次运行临时关闭 |

也可以用命令行按点号键读写这些配置：

```bash
codex-compat config list
codex-compat config get service.reclaim
codex-compat config set service.reclaim notify-only
```

修改 `listen.port` 会立即写入配置，但要执行 `codex-compat repair` 才会改写 Codex 的 `base_url` 并重启服务。

运行态目录结构：

| 路径 | 内容 |
| --- | --- |
| `~/.codex-compat/config.json` | 持久化设置 |
| `~/.codex-compat/config/` | 模型与角色模板，以及融合版提示词模板（首次安装时从包内 `config/` 落位，已存在则不覆盖） |
| `~/.codex-compat/logs/` | 改写计数、守护事件、追踪输出（开启时） |
| `~/.codex-compat/backups/` | 每次写入前的备份 |
| `~/.codex-compat/run/` | 锁文件与运行态标记 |
| `~/.codex-compat/state/` | 运行态状态目录，安装时分配 |
| `~/.codex-compat/diagnostics/` | 诊断包目录，仅在你主动生成时创建 |
| `~/.codex-compat/install-manifest.json` | 安装器做过的改动，供 `restore` 与 `uninstall` 使用 |

## DeepSeek 提示词优化

`config/prompts/deepseek-codex.md` 保留当前的融合版提示词模板，用于解决 DeepSeek 子代理「提前停止 / 空跑（收到任务却不干活）」的问题：模板保留 DeepSeek 的 Codex 集成基线，并补充指令优先级、工程判断与端到端执行责任约束。

模板来源：

- DeepSeek 官方发布的 Codex 集成文档：<https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/>
- **程小帮** 提供的约束与角色指导（实名致谢）。

两个来源均已在文档与致谢中标注；没有移植这些来源中的专属工具、Memory 或运行时路径。该功能的开关位于菜单「功能开关」以及配置文件的 `features` 字段。

## provider 模型目录托管

**当前状态：Codex 尚不支持这条路径，本项目仅作为未来可能的技术路线保留（默认关闭）。**

没有全局 `model_catalog_json` 时，提示词模板只能通过 provider 级模型目录送达模型。兼容层在 `GET /__compat/catalog` 提供这份目录，并且只在**同时满足**以下两个条件时才给 provider 写 `model_catalog_url`：

- 没有全局 `model_catalog_json`；
- 上游 `/models` **不是** Codex 原生目录——即返回的条目里没有 `model_messages` / `base_instructions` 字段。

如果上游本来就是原生目录（例如自带目录的 CC Switch），或者刷新失败，兼容层会保持现状，并回收此前由自己写入的键，而不是用中性字段覆盖更完整的元数据。该行为由 `features.providerCatalog`（默认关闭）控制；没有全局目录时，`doctor` 会给出 `provider-catalog` 检查项。

为什么默认关闭（Codex 0.160.1，2026-10 实测）：

- **键已存在。** `model_catalog_url` 在 0.160.1 的 provider TOML 结构里就已经存在（与 `base_url` / `env_key` / `env_key_instructions` / `experimental_bearer_token` 并列），写入不会触发 unrecognized setting 警告。
- **CLI 从不拉取它。** 给 lab 实例配好合法的 `model_catalog_url`（兼容层确实在提供 36KB 的 `/__compat/catalog`）后，`codex debug models`（官方「Render the raw model catalog as JSON」）返回 `{"models":[]}`，兼容层日志里该端点请求数为 0。`codex features list` 给出了背后两个开关的状态：`api_key_model_discovery` 是 under development（false）、`remote_models` 已被 removed——这也解释了此前把 `remote_models` 打开却无效的原因。所以卡点是「Codex 还没把这项能力转正」，**既不是本机版本落后，也不是「我们已经修好了」**。
- **提示词实际怎么送达。** lab 实例走顶层键 `model_instructions_file`（写进 `[model_providers.<id>]` 表内会被 Codex 判为无法识别的配置并忽略），顶层写法下代理侧 trace 到的 instructions 与仓库模板逐字符一致（23,498 vs 23,499 字符，仅差末尾换行）。CC Switch 场景则由环境里已有的模型目录条目承载模板——即 CC Switch 维护的那份目录（例如 `~/.codex/cc-switch-model-catalog.json`），其中 `ccs-deepseek/deepseek-v4.1-flash` 与 `ccs-deepseek/auto(free)` 条目的 `base_instructions` / `model_messages.instructions_template` 就是仓库模板（23,499 字符），且主实例一次真实 `codex exec` 会话中兼容层落盘的客户端请求体与模板逐字符一致。至于具体是哪个配置指针把这份目录交给 Codex，由该上游工具决定，本工具没有查明；本工具只负责把模板写进目录条目。注意 `~/.codex/models_cache.json` 是过期缓存（例如 2026-09-24 的旧文件，其 DeepSeek 条目里的模板只有 68 字符），不是生效来源。
- **什么时候值得重新验证。** 等 Codex 把「按 provider 配置发现模型目录」转正，即 `api_key_model_discovery` 从 under development 变为 stable。

`model_providers.<id>.model_catalog_url` 需要 Codex ≥ 0.156：更低版本不写该键——lab 实例建议改用顶层键 `model_instructions_file`，该模式（单供应商 home）已实测可把提示词完整送达模型；主力实例仍不适用（共享 home、多供应商），仍使用环境里已有的模型目录，具体如何交给 Codex 由上游工具决定。

### 模型绑定与模糊匹配

`config/mappings.toml` 把一个模型 ID 绑定到提示词模板与子代理角色。除了精确的 `model_id`，绑定还可以带 `model_id_like`：它不区分大小写，且只匹配模型 ID 的**最后一段**——`like = "deepseek-v4.1-flash"` 可以命中 `ccs-deepseek/deepseek-v4.1-flash`，因此供应商前缀变化时同一条绑定依然有效。精确 `model_id` 优先；0 命中会告警 `missing_model`，多命中会告警 `ambiguous_model` 并跳过该绑定；同一个模型只由一个 binding 管理。仓库默认的 `config/mappings.toml` 现在为每条绑定同时写 `model_id` 与 `model_id_like`。

### 纯官方保护

`features.officialGuard`（默认开）在模型名看起来是官方模型时拒绝写入提示词与目录条目——命中 `gpt-*`、`codex-*`、`o<N>` 即拒绝并报错。纯官方配置（没有任何第三方 provider）执行 `install` 会直接失败，且**零写入、零进程、零计划任务**。`doctor` 会给出 `official-untouched`（没有管理到官方命名模型）与 `provider-catalog` 两项检查。

同时如实说明：`[features.multi_agent_v2]`（`enabled = true` 与 `tool_namespace = "agents"`）是全局写入，对官方模型会话同样生效——它是跨 provider 子代理的前提，与提示词内容无关；`model_provider` 由 CC Switch 设置，不是本工具所改。

## 日志与隐私

- 无遥测、无任何回传：兼容层只与本机配置的上游端点通信。
- 常规日志只记录计数、模型名与事件类型，不记录任务正文，也不记录认证头。
- 诊断追踪默认关闭，只有显式打开才会产生输出：写入请求元数据与首尾短片段，最多再按模型保留最近一次 instructions 正文，全部受大小上限保护；任务正文、模型输出与认证头依然不落盘。

完整说明见 [PRIVACY.md](PRIVACY.md)。

## 常见问题

**Codex 升级后跨 provider 派发失效了怎么办？**

1. 执行 `codex-compat doctor`，先看哪一项检查不通过。
2. 执行 `codex-compat logs`，看 `rewrite` 计数。如果以前派发会有非零的 `stripped` / `projected` 计数，现在恒为 0，说明请求形态很可能变了。
3. 执行 `codex-compat bypass` 先恢复工作，需要回到正常链路时执行 `codex-compat repair`。
4. 执行 `codex-compat doctor --fix`（或 `repair`），把升级可能覆盖掉的配置重新写回。
5. 如果请求形态确实变了，需要改的是代码里的改写规则，而不是配置。提缺陷时请附上 `doctor` 输出，以及（如已开启）脱敏后的追踪片段。

**如何旁路？**

`codex-compat bypass` 会把安装时记录在安装清单里的原始上游地址写回 Codex 配置，让 Codex 直接连回原上游；兼容层本身继续运行，只是不再参与流量。用 `codex-compat repair` 重新接入。

**如何卸载与还原？**

按要撤销的范围分三档：

```bash
codex-compat restore            # 只还原 Codex 配置，工具保持安装
codex-compat uninstall          # 停服务 + 还原配置，保留运行目录
codex-compat uninstall --purge  # 同上，并删除运行目录
```

`restore` 与 `uninstall` 没有预演模式，它们依据安装清单精确回退——清单里记录了安装器改过什么。如果 Codex 配置被外部修改、回退因此拒绝覆盖，请先核对改动，确认无误后再加 `--force`。每次写入前的备份都在 `~/.codex-compat/backups/`。

**端口 15731 被占用了。**

安装器会扫描 `15732`–`15831` 并保存选中的端口，你也可以直接传 `--port <n>`。如果该端口由本工具的另一个实例应答，会复用该实例，而不是重复启动。

安装后想换端口，先执行 `codex-compat config set listen.port <n>`，再执行 `codex-compat repair`，后者会改写 Codex 的 `base_url` 并重启服务。

**子代理还是说没有收到任务。**

先确认你用的模型 ID 能被判定为第三方：默认前缀是 `ccs-` 与 `ccs/`。用 `codex-compat config get compat.thirdPartyPrefixes` 查看当前值；如果自建网关用的是别的 ID 方案，请在 `~/.codex-compat/config.json` 里补充前缀，然后执行 `codex-compat restart`。同时确认请求确实经过了兼容层：`codex-compat status` 会显示 Codex 当前的 `base_url` 以及它与兼容层地址是否一致。

**CC Switch 显示直连模式。**

只有 CC Switch 通过本地代理接管 Codex 时，兼容层才看得到流量。请打开本地代理开关，或用 `--upstream` 指向你自己的端点；状态行会告诉你是哪一种情况。

**安装器会改写我的 Codex 配置，有风险吗？**

每次写入前都会备份，并记录在安装清单里，可用 `restore` / `uninstall` 回退。想先看改动清单时，用 `install --dry-run`（或 `repair --dry-run`）。

## 兼容性摘要

| 维度 | 状态 |
| --- | --- |
| Windows | 已实机验证（安装、还原、自启、通知、五种派发组合） |
| macOS | 代码已实现，标注 experimental；由 CI 覆盖，尚未实机验证 |
| Linux | 代码已实现，标注 experimental；由 CI 覆盖，尚未实机验证 |
| Node.js | 需要 18 及以上 |
| Codex | 支持 Multi-Agent V2 的版本；依赖未公开行为，升级后需要重新验证 |
| 上游 | CC Switch 本地代理（默认）与自定义 OpenAI 兼容端点 |
| 实验实例（多开） | 代码已实现，标注 experimental；独立 `CODEX_HOME`，端口从 `15900` 起，除 `--autostart` 外不注册计划任务 |
| provider 模型目录托管 | 已实现但默认关闭；已实测在 Codex 0.160.1 不生效。开启后仅在「无全局目录且上游 `/models` 非原生」时托管；`model_catalog_url` 需要 Codex ≥ 0.156 |

完整矩阵（含组合级结果）见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 已验证基线与回退

实测基线：**`@openai/codex` 0.160.1**，Windows 实机验证——主实例派发、lab 实例 `codex exec`、提示词逐字符送达；运行时要求 Node.js ≥ 18。macOS 与 Linux 目前只有 CI 覆盖，没有实机验证。

升级 Codex 后如果派发失效，按这个顺序回退：

1. `codex-compat bypass` —— 把 Codex 的 `base_url` 指回原上游，先把流量恢复。
2. `npm i -g @openai/codex@0.160.1` —— 把 Codex CLI 回退到实测基线版本。
3. `codex-compat doctor` —— 复检环境；`codex-version` 行会显示是否回到基线。

`codex-compat doctor` 会多出一项 `codex-version`，自动对比当前版本与基线：一致时显示 `Codex 0.160.1（本工具实测基线）`，不一致时显示 `Codex <当前版本>（本工具实测基线 0.160.1；如遇异常可回退该版本）`，探测不到版本时也会附上基线。该行跟随菜单语言，且只作展示、不判失败，不需要你自己猜本工具是按哪个版本验证的。

## 安全

本工具位于凭据链路上——它要代表你向上游转发请求。它不保存凭据、不记录认证头，也不会尝试解密官方密文。发现疑似漏洞请私下报告，方式见 [SECURITY.md](SECURITY.md)。

## 参与贡献

缺陷报告、文档修正、平台验证、提示词证据都可以提。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 非官方声明

`codex-compat` 是独立的非官方项目，与 OpenAI、DeepSeek、CC Switch 均无隶属、背书或支持关系；产品名称仅用于描述互操作性。本项目依赖不属于任何公开契约的 Codex 行为，可能随时失效，因此提供了 `codex-compat bypass` 与 `codex-compat restore` 两个出口。

## 致谢

- 跨 provider 投递设计参考了 **BigStrongSun/ccswitchmulti** 与 **farion1231/cc-switch**（均为 MIT，Copyright (c) 2025 Jason Young）。
- DeepSeek 提示词模板包含 DeepSeek 官方 Codex 集成文档内容，以及 **程小帮** 提供的约束。
- 完整许可原文与版权行见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可

MIT 覆盖本项目的源码，见 [LICENSE](LICENSE) 与 [CHANGELOG.md](CHANGELOG.md)。

有一个文件不在该授权范围内：`config/prompts/deepseek-codex.md` 是一份融合文档，包含第三方文本（Codex 的代理指令、DeepSeek 集成指导，以及署名程小帮 的约束文本）。要复用它请自行厘清这些来源的授权——见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
