# 兼容性与验证状态

本文列出 `codex-compat` 在各平台、运行时、Codex 版本与上游端点上的验证状态。状态口径如下：

| 标记 | 含义 |
| --- | --- |
| 已实机验证 | 在真实机器上跑过安装、体检与跨 provider 派发，结论来自实际运行 |
| 实验性 | 代码已实现并由 CI 覆盖，但尚未在真实机器上完整验证 |
| 已实现 | 代码路径已完成并有离线用例覆盖，尚未做系统性实机验证 |
| 支持 | 设计上支持、路径已实现，未做系统化验证 |
| 要求 | 硬性前置条件，不满足时安装会明确报错 |

CI 在 `windows-latest`、`macos-latest`、`ubuntu-latest` 三个系统与 Node 18 / 20 / 22 三个主版本的组合上运行完整测试套件（`npm test`），因此「CI 覆盖」指的是跨平台分支会被真实执行，而不是实机功能验证。

## 已验证基线

本工具公开声明的实机结论集中在一组基线上：**Codex CLI 0.160.1**（Windows 实机验证——主实例跨 provider 派发、lab 实例 `codex exec`、提示词逐字符送达），运行时要求 Node.js ≥ 18。macOS 与 Linux 目前只有 CI 覆盖，没有实机验证。

升级 Codex 后如遇异常，回退顺序是：`codex-compat bypass` 先把 `base_url` 指回原上游恢复流量 → `npm i -g @openai/codex@0.160.1` 回退 CLI → `codex-compat doctor` 复检，`codex-version` 行会显示当前版本与基线 0.160.1 的对照（该行跟随菜单语言，只作展示、不判失败）。

关于 `0.156` 门槛：`model_providers.<id>.model_catalog_url` 的「Codex ≥ 0.156」是设计约定下的**最低版本假设，未做实机逐版本回归**，作用范围仅限 provider 级目录托管（当前默认关闭，详见「provider 模型目录托管」）。低于该门槛时 `install` 不写该键，lab 实例显式指定 `--catalog-mode catalog` 时会降级为 `none` 并告警。加之这条路径在 0.160.1 上实测本来就不会被 CLI 拉取，该门槛目前只是一层保守保护。

## 平台

| 平台 | 状态 | 验证内容与说明 |
| --- | --- | --- |
| Windows 11 | 已实机验证 | 源码安装、配置备份与还原、登录自启（计划任务）、崩溃重启守护、系统通知，以及五种主控 × 子代理组合的跨 provider 派发；计划任务经 `wscript` 隐藏启动器执行，`guard` 每分钟运行不产生控制台窗口或焦点抢占；任务命名为 `CodexCompatService` / `CodexCompatServiceGuard`，并提供 `--cleanup-legacy` 清理旧命名任务。同时被 CI 覆盖 |
| macOS | 实验性 | 服务托管使用 launchd agent，通知使用 `osascript`；由 CI（macos-latest，Node 18/20/22）覆盖，尚未实机验证 |
| Linux | 实验性 | 服务托管使用 systemd user unit，通知使用 `notify-send`，不可用时退回 `zenity`；由 CI（ubuntu-latest，Node 18/20/22）覆盖，尚未实机验证 |

三个平台共用同一套 Node.js 代码，差异集中在服务注册与系统通知两处适配层。

## 运行时

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Node.js 18 及以上 | 要求 | `package.json` 的 `engines` 字段；低于该版本安装会报错 |
| Node.js 18 / 20 / 22 | 已验证 | 三个主版本均在 CI 的完整测试矩阵中运行 |
| Node.js 22 及以上 | 支持（可选增强） | 只有该版本能用内置 SQLite 只读探测 CC Switch 的本地数据库；低版本自动降级到其余探测来源，不影响功能 |
| 压缩编码 | 支持 | 请求体支持 `zstd`、`gzip`、`deflate` 解码（Codex 使用 `zstd`）；改写后会移除失效的 `content-encoding` 并重算 `content-length` |
| 请求体大小 | 支持 | 单请求上限 64MB，超出返回 413 |

## Codex

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 支持 Multi-Agent V2 的 Codex 版本 | 已实机验证 | 需要使用支持 Multi-Agent V2 的版本，且至少启动过一次（`~/.codex/config.toml` 存在） |
| Codex 配置读取时机 | 已实机验证 | 配置与模型模板在 **会话创建/进程启动时**取用；安装后必须重启 Codex，且已有会话不会重取模板 |
| Codex 升级后 | 需要重新验证 | 本工具依赖「官方后端见 `encrypted` 标记即加密」这一未公开行为。升级后建议依次执行 `codex-compat doctor`、`codex-compat logs`（看 `rewrite` 计数）与一次跨 provider 派发 |

## 上游端点

| 上游 | 状态 | 说明 |
| --- | --- | --- |
| CC Switch 本地代理（默认 `127.0.0.1:15721`） | 已实机验证 | 兼容层的默认上游；仅在 CC Switch 通过本地代理**接管** Codex 时，流量才会经过兼容层 |
| CC Switch 直连模式 | 不适用 | 直连模式下流量不经过兼容层，改写不会发生；状态查询会明确提示 |
| base_url 被上游改回 | 已实机验证 | 守护进程每 30 秒检查一次漂移；`auto` 档会原子写回兼容层地址并通知（实机实测约 26 秒完成抢回，期间服务不重启），`notify-only` 只通知，未知地址一律不覆盖；抢回自带节流（30 秒间隔、每小时上限 20 次） |
| 自定义 OpenAI 兼容端点 | 支持 | 用 `--upstream` 或配置里的 `upstream.baseUrl` 指定；端点需要能处理 Codex 发出的 Responses 请求（兼容层按原路径透传） |
| 官方 Codex 后端（官方模型） | 已实机验证 | 经 CC Switch 转发；阶段 A 与阶段 B 都针对官方下游做过验证 |

## 端口与实例

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 默认监听端口 | 已实机验证 | `127.0.0.1:15731`，只绑回环地址 |
| 端口占用自动避让 | 已实机验证 | 默认端口被占用时在 `15732`–`15831` 范围内扫描并保存选中端口 |
| 重复实例判定 | 已实机验证 | 端口由本工具的另一个实例应答时复用该实例，不重复启动 |
| 指定端口优先级 | 已实机验证 | `--port` 指定的端口优先于安装清单里记录的历史端口；只有该端口被外部占用时，才按候选顺序回退 |
| 多实例并存 | 实验性 | 主实例保持「同一运行态目录同一时间只有一个可用实例」；实验实例（lab）走独立目录、独立端口，见下方「多实例（实验 / 多开）」 |

## 多实例（实验 / 多开）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 实验实例（lab） | 实验性 | `codex-compat instance create\|list\|status\|start\|stop\|env\|run\|refresh-catalog\|remove`（别名 `lab`）管理 `~/.codex-compat/instances/<名称>/` 下的自包含实例：独立 `CODEX_HOME`（实例目录 `codex/`）、独立兼容层运行目录（`compat/`）与独立端口（`15900`–`16000`，从 `15900` 起分配） |
| 计划任务 | 已实现 | 默认**不注册任何计划任务**，按需 `instance start` / `instance stop`；只有显式 `--autostart` 才注册 `CodexCompatService-<名称>` / `CodexCompatServiceGuard-<名称>` |
| 密钥处理 | 已实现 | `--key` 写入实例目录 `secrets.env`（输出全程掩码）；`--key-env <变量名>` 完全不在磁盘留密钥；`instance run` 注入 `CODEX_HOME` 与密钥后启动 `codex`，`instance env` 只打印掩码与可复制命令 |
| 用途 | 已实现 | 实验 / 多开；新用户可先建实例，用临时 Codex CLI 验证，再通过菜单首次接入向导接入主配置 |
| 真实机器验证 | 未验证 | 由离线自检（`tests/instances.cjs`）覆盖；尚未在真实机器上跑完整的 `codex` 会话验证 |

## provider 模型目录托管

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 目录端点 | 已实现 | 兼容层提供 `GET /__compat/catalog`；未生成时返回 `catalog_missing`，不会新建全局 `model_catalog_json` |
| 写入条件 | 已实现 | 仅当「没有全局 `model_catalog_json`」**且**「上游 `/models` 不是 Codex 原生目录」时，才给 provider 写 `model_catalog_url`；探测依据是上游条目是否带 `model_messages` / `base_instructions` |
| 原生目录 / 刷新失败 | 已实现 | 上游已是原生目录（例如自带目录的 CC Switch）或刷新失败时保持现状，并回收此前由本工具写入的 `model_catalog_url`，不用中性字段覆盖更完整的元数据 |
| 开关与体检 | 已实现 | 由 `features.providerCatalog`（默认 false）控制；无全局目录时 `doctor` 给出 `provider-catalog` 检查项 |
| 版本门槛 | 要求 | `model_providers.<id>.model_catalog_url` 需要 Codex ≥ 0.156；更低版本不写该键——lab 实例建议用 `model_instructions_file`（仅单供应商 home 安全），主力实例自配提示词目录 |
| 实机验证结论（Codex 0.160.1，2026-10） | 已实机验证 | Codex 0.160.1 不会为 env_key provider 拉取 provider 级 `model_catalog_url`（代理侧收不到任何 `/__compat/catalog` 请求，也没有任何模型缓存被刷新）；`model_catalog_url` 本身在该版本的 provider TOML 结构里就已存在（与 `base_url` / `env_key` / `env_key_instructions` / `experimental_bearer_token` 并列，写入不触发 unrecognized setting 警告），只是 CLI 从不拉取：配好合法 `model_catalog_url` 后 `codex debug models` 返回 `{"models":[]}`，兼容层日志中该端点请求数为 0；`codex features list` 显示 `api_key_model_discovery` 为 under development / false、`remote_models` 已 removed，因此追加 `[features] api_key_model_discovery = true` / `remote_models = true` 也不触发模型发现。结论：该能力默认关闭，要等 Codex 把「按 provider 配置发现模型目录」转正（`api_key_model_discovery` 从 under development 变为 stable），不是本机版本落后，也不是本工具已修复的那条路。lab 实例的提示词改由顶层键 `model_instructions_file` 送达（写进 `[model_providers.<id>]` 表内会被忽略，lab 实例生成器已修正为顶层写法），顶层写法下 trace 到的 instructions 与仓库模板逐字符一致（23,498 vs 23,499，仅差末尾换行）；CC Switch 场景的模板则由环境里已有的模型目录条目承载（即 CC Switch 维护的那份目录，如 `~/.codex/cc-switch-model-catalog.json`），具体由哪个配置指针交给 Codex 由该上游工具决定，本工具只负责把模板写进目录条目——`~/.codex/models_cache.json` 是过期缓存，不是生效来源 |

## 模型映射与模糊匹配

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| `model_id_like` 匹配 | 已实现 | 不区分大小写，只匹配模型 ID 的最后一段（如 `ccs-deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash`）；精确 `model_id` 优先 |
| 命中异常 | 已实现 | 0 命中告警 `missing_model`；多命中告警 `ambiguous_model` 并跳过该绑定；同一个模型只由一个 binding 管理 |
| 默认配置 | 已实现 | 仓库默认 `config/mappings.toml` 为每条绑定同时写 `model_id` 与 `model_id_like`；由 `tests/like-matching.cjs` 覆盖 |

## 纯官方保护

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 命中判定 | 已实现 | `features.officialGuard`（默认开）在模型名命中 `gpt-*` / `codex-*` / `o<N>` 时拒绝写入提示词与目录条目并报错 |
| 纯官方配置 | 已实现 | 没有任何第三方 provider 时执行 `install` 直接失败，且零写入、零进程、零计划任务 |
| 体检项 | 已实现 | `doctor` 提供 `official-untouched` 与 `provider-catalog` 两项检查 |
| 全局写入说明 | 已实现 | `[features.multi_agent_v2]`（`enabled = true`、`tool_namespace = "agents"`）是全局写入，对官方模型会话同样生效；这是跨 provider 子代理的前提，与提示词无关。`model_provider` 由 CC Switch 设置，不是本工具所改 |

## 还原与卸载

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 按清单还原 | 已实机验证 | `restore` 依据安装清单写回原始 `base_url` 并回滚映射变更；当前配置被外部改过时会拒绝覆盖，`--force` 才强制 |
| 重复执行 | 已实机验证 | 已经还原过时再次执行 `restore` / `uninstall` 不会误报冲突，保持幂等 |
| 完整卸载 | 已实机验证 | `uninstall` 停止守护与服务、还原配置；`--purge` 额外删除运行目录，端到端测试覆盖了「安装 → 真实转发 → 还原 → 卸载清理」全过程 |

## 跨 provider 派发矩阵

在 Windows 实机回归中验证的五种主控 × 子代理组合：

| 主控 | 子代理 | 阶段 A | 阶段 B | 结果 |
| --- | --- | --- | --- | --- |
| 官方模型 | 官方模型 | 触发（剥离） | 触发（无明文可投影） | 通过 |
| 官方模型 | 网关模型 | 触发 | 触发 | 通过 |
| 网关模型 | 官方模型 | 不触发 | 触发（关键路径） | 通过 |
| 网关模型 | 网关模型 | 不触发 | 触发 | 通过 |
| 网关模型 | `auto(free)` | 不触发 | 触发 | 通过 |

配套的输入归一化（孤立 `function_call_output` 改写为普通 user 消息）只在网关下游生效；官方下游容忍这类孤立输出，因此保持原样透传。

## 如何自行确认当前环境

1. `codex-compat status`：看是否已安装、是否在运行、监听地址与上游，以及 CC Switch 是否处于接管模式。
2. `codex-compat doctor`：逐项检查端口、上游可达性、配置项、服务注册与 Multi-Agent V2 开关，并给出修复建议。它默认只读；确认后可用 `codex-compat doctor --fix` 自动重跑安装流程修复配置类问题。
3. `codex-compat logs`：一次成功的跨 provider 派发应当产生带非零计数的 `rewrite` 事件；如果计数长期为零，说明请求没有经过兼容层，或请求形态已经变化。
4. 离线自检：`codex-compat selftest` 不访问网络、不调用模型，用来确认改写规则本身仍然按预期工作。
5. 端到端验证：`npm test` 跑离线套件；`npm run test:smoke` 与 `npm run test:live` 是可选的真机在线检查，会消耗真实额度，不要放进 CI。

## 未验证项

以下内容尚未验证，不应视为承诺：

- macOS 与 Linux 的真实机器安装、自启、通知与端到端派发（目前只有 CI 覆盖）。
- 实验实例（lab）已在 Windows 本机 + 真实第三方网关做过完整会话验证：`instance run <name> -- exec ...` 能正常返回，且代理侧 trace 到的 instructions 与仓库模板逐字符一致；macOS / Linux 上的真实 `codex` 会话仍未验证。离线自检覆盖创建、端口分配、密钥掩码、默认不自启、停止无残留、删除清理等。
- CC Switch 场景下提示词的实际载体是环境里已有的模型目录条目（本机为 `~/.codex/cc-switch-model-catalog.json`，其 `ccs-deepseek/auto(free)` 与 `ccs-deepseek/deepseek-v4.1-flash` 条目的 `base_instructions` / `model_messages.instructions_template` 为 23,499 字符＝仓库模板），但**究竟是哪个配置指针把这份目录交给 Codex 尚未查明**（`~/.codex/config.toml` 里没有 `model_catalog_json`）：本工具只确认自己把模板写进了目录条目。另经实测，`~/.codex/models_cache.json` 是过期缓存（旧文件，其 DeepSeek 条目里的模板只有 68 字符），不是生效来源。
- `model_catalog_url` 已实测在 Codex 0.160.1 不生效：该键已被 0.160.1 的 provider TOML 结构识别（写入不触发 unrecognized setting 警告），但 CLI 从不拉取它——配好合法 `model_catalog_url` 后 `codex debug models` 返回 `{"models":[]}`，兼容层 `/__compat/catalog` 请求数为 0；`codex features list` 显示 `api_key_model_discovery` 仍 under development、`remote_models` 已 removed，故需等 Codex 把「按 provider 配置发现模型目录」转正后重新回归，而不是等本机升级版本。提示词改由顶层键 `model_instructions_file` 送达（写进 `[model_providers.<id>]` 表内会被 Codex 忽略，lab 实例生成器已修正）。
- 自建网关使用非默认模型 ID 前缀时的判定：`model_id_like` 已按末段匹配放宽，但前缀与末段的组合仍需按自身网关验证。
- Codex CLI 0.156–0.159 的 provider 级目录门槛未做逐版本实机回归：该门槛来自设计约定（属保守假设），本工具唯一的实机基线是 0.160.1。
- 纯官方保护在真实官方账号上的验证（当前由离线用例覆盖「纯官方 install 零写入」）。
- 除 Codex 之外的其他客户端复用同一兼容层的场景。
- 官方后端未来版本的行为变化；本工具依赖的标记语义不在任何公开契约内。
