# codex-compat 技术架构

> 本文是公开版本的架构说明。文中不包含任何私有网关地址、内部产品名或内部平台信息；所有结论以本仓库代码为准。
>
> 历史故障分析仅适用于当时实测的 Codex 版本与链路，不代表所有 Codex 版本都存在同样行为。

## 一、背景

在 Codex 中使用低成本网关模型（例如 DeepSeek、GLM 等）承担子代理工作，主控使用官方模型或网关模型，目标是在尽量少消耗官方额度的前提下，让子代理真正收到任务、干完活、把结果交回来。

实测发现：Codex Multi-Agent V2 的跨 provider 派发完全不可用。子代理要么收到空任务，要么直接断流。本文记录根因分析、兼容层的设计原理与实现边界。

## 二、现象与根因

### 2.1 四个可观测现象

**现象 A：子代理收到空任务。**

子代理能正常初始化，读到 AGENTS.md 和环境上下文，但说「没有具体任务内容」。原始请求里任务消息长这样：

```json
{"type":"agent_message","author":"/root","recipient":"/root/child",
 "content":[
   {"type":"input_text","text":"Message Type: NEW_TASK\nTask name: ...\nPayload:\n"},
   {"type":"encrypted_content","encrypted_content":"只回答一行：PONG-123"}
 ]}
```

任务正文装在一个叫 `encrypted_content` 的 content 块里。第三方网关的 Responses API 不认识这个块类型，整块丢弃，模型只看到空 header。

**现象 B：官方子代理断流。**

```
stream disconnected before completion:
Encrypted function output content could not be decrypted or decoded.
```

网关主控放进容器的是明文（网关不认识加密标记，不会加密），但官方后端看到 `encrypted_content` 就一定要解密，遇到明文直接失败。

**现象 C：官方后端 400。**

```
Invalid Value: 'tools'. Function 'collaboration.spawn_agent'
is reserved for use by this model and must match the configured schema.
```

`collaboration.*` 是官方保留命名空间，对它的 schema 做任何改动都会被拒绝。

**现象 D：委派创建的新会话被网关 400 拒绝。**

用「从其他任务发送」创建会话时，新会话历史的第一条是 `create_thread` 的 `function_call_output`（委派块正文），它既没有 `call_id`，也没有配对的 `function_call`。按 Chat 协议校验的网关上游会拒绝：

```
Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
```

官方下游容忍这种孤立输出，网关下游不容忍；手动在界面新建的会话不带委派块，所以此前表现为「工具创建对话失败、手动创建正常」。

### 2.2 根因

`spawn_agent` 的工具 schema 里，`message` 字段带一个 `encrypted: true` 标记：

```json
{"name":"spawn_agent","parameters":{"properties":{
  "message":{"type":"string","description":"...","encrypted":true}
}}}
```

**真正执行加密的是官方后端**，这个标记只是「请求对方加密」的声明：

- 官方主控 → 请求发到官方后端 → 官方后端按标记加密 → 产出 `gAAAAAB...` 形态的 Fernet 密文
- 网关主控 → 请求发到第三方网关 → 网关把 `encrypted` 当普通字段忽略 → 模型直接输出明文

Codex 客户端会把这段内容（无论密文还是明文）都存进 `encrypted_content` 容器。容器名与实际内容是否加密**没有强绑定**，这正是跨 provider 失败的总根源。

## 三、设计原则

| 原则 | 说明 |
| --- | --- |
| 保留命名空间不可改 | `collaboration.*` 的 schema 必须原样透传，改动会被官方 400 拒绝 |
| 命名空间迁移 | 通过 Codex 官方配置 `tool_namespace = "agents"` 把协作工具挪到非保留命名空间 |
| 按需改写 | 只在必要条件下改写，官方对官方的加密流量维持原样 |
| 显式失败 | 无法安全投递时返回明确错误，绝不静默投递空任务 |
| 不碰密钥 | 兼容层从不尝试解密官方密文，只做形态搬运 |
| 不记正文 | 日志只记录计数、模型名、事件类型，不落任务正文 |

## 四、架构

### 4.1 请求链路

```
Codex 客户端
    │  base_url = http://127.0.0.1:15731/v1
    ▼
┌─────────────────────────────┐
│  codex-compat               │   ← 本工具（默认 127.0.0.1:15731）
└─────────────────────────────┘
    │  透传到上游（默认 127.0.0.1:15721）
    ▼
上游端点：CC Switch 本地代理，或自定义 OpenAI 兼容端点
    │
    ├─ 官方模型 → 官方 Codex 后端
    └─ 网关模型 → 第三方 OpenAI 兼容网关
```

兼容层是**纯转发 + 条件改写**，不持有任何凭据，不做鉴权决策，所有 header 原样透传。监听地址默认只绑回环地址，上游地址与监听端口都可在配置里更换。

### 4.2 四个改写阶段

**阶段 A：剥离加密标记（仅官方父请求）**

目的：让官方后端返回明文参数，而不是密文。

```
if (模型是官方) and (请求中含网关模型引用 or 配置为总是剥离):
    遍历请求体，找到 spawn_agent / send_message / followup_task
    删除 parameters.properties.message.encrypted
```

副作用：官方后端会因为非保留命名空间而接受改写后的 schema（前提是 `tool_namespace = "agents"`）。

**阶段 B：投影明文容器（所有请求）**

目的：把明文从 `encrypted_content` 容器搬到标准 user 消息里，两类下游都能读。

```
if (input[].type == 'agent_message'):
    收集 content[] 里的 text 与「非密文形态的 encrypted_content」（多段用换行拼接）
    遇到 gAAAAAB 开头的真密文 → 标记为 opaque，保留原容器
    否则 → 替换为 {type:'message', role:'user', content:[{type:'input_text', text}]}
```

这一步对官方和网关下游都必需：官方要的是「别让明文待在需要解密的容器里」，网关要的是「别用我不认识的内容块类型」。

**阶段 C：真密文投递守卫**

```
if (遇到 opaque 密文) and (下游不是官方子代理):
    判定失败 → 代理层返回 400（code = compat_layer_reject），附带原因与修复提示
```

宁可失败得明显，也不要让子代理拿到空任务却装作正常。这是从实际踩坑经验中提炼的：静默失败会让人以为是模型能力问题，浪费大量排查时间。

**阶段 D：孤立工具输出归一化（仅网关下游）**

目的：网关上游按 Chat 协议要求 `role=tool` 的消息必须紧跟带 `tool_calls` 的助手消息，委派块等孤立输出会让整个请求 400。

```
if (下游是网关模型):
    收集请求内所有 function_call.call_id
    对每个 call_id 不在集合中的 function_call_output：
        有正文 → 改写为 {type:'message', role:'user', content:[{type:'input_text', text}]}
        空正文 → 直接移除
```

只搬形态、不丢正文；配对正常的工具输出原样透传。实现见 `src/compat-input.cjs`，离线自检见 `tests/compat-input.cjs`。

### 4.3 内容形态判定

| 形态 | 特征 | 处理 |
| --- | --- | --- |
| 官方 Fernet 密文 | `gAAAAAB` 前缀 | 保留在容器里，只允许发给官方子代理 |
| 明文（网关产出） | 其他任意文本 | 投影成 user 消息 |
| 非加密 agent_message | 无 `encrypted_content` | 原样透传 |

### 4.4 条件判定

模型身份判定：

```js
isOfficialModel   = /^gpt-|^codex-|^o[0-9]/     // 官方后端托管
isThirdPartyModel = 前缀匹配，默认 ['ccs-', 'ccs/']  // 网关模型，前缀可在配置中扩展
```

阶段 A 的触发条件还要求「请求中含网关模型引用」，可通过配置项 `compat.stripAlways` 放宽为总是剥离（默认即为总是剥离）；把它设为 `false` 即可让纯官方路由的流量保持全加密。第三方前缀来自配置项 `compat.thirdPartyPrefixes`，自建网关使用别的模型 ID 方案时需要在此补充。

## 五、为什么必须在代理层做

这条路走不通的原因值得记录，避免重复探索：

**改客户端配置不够。** Codex 自身能配的就三项：`multi_agent_version`（选面）、`tool_namespace`（换命名空间）、`features.multi_agent_v2.enabled`（全局开关）。它们能让 v2 面正常启用，但**没有任何一项能改变「任务正文被装进 encrypted_content 容器」这个行为**——那是 Codex 客户端代码写死的。

**改模型目录不够。** 目录只决定走哪个面。改 v1 面确实能让正文以普通 user 消息投递，但代价是失去 v2 的全部编排能力（不能指定子代理模型和思考强度、没有 `fork_turns` 控制、没有主动委派）。这是降级而非解决。

**只能改请求体。** 请求体经过本地代理时是可以干预的最后一站。社区同类实现同样选择在代理层做两阶段改写，工程实践相互印证。

## 六、稳定性设计

### 6.1 进程监督

```
登录自启项（按平台：计划任务 / launchd / systemd user unit）
    └─ watchdog（守护进程）
         └─ compat-proxy（兼容层本体）
```

看门狗职责：

- 子进程退出后自动重启
- 指数退避（2 秒起步，上限 60 秒），避免崩溃循环打爆 CPU
- 运行超过 30 秒视为健康，重置退避计数
- 连续 10 次快速失败则放弃并写日志，不无限重启
- 主动暂停（`pause`）/停止（`stop`）会留下「有意停止」标记；独立守护脚本每次执行都先检查该标记，命中则直接退出，避免被高频拉起
- 守护脚本是幂等的：端口健康时无动作；服务未注册则注册，已注册未运行则请求启动，最后仍不通才改用后台进程兜底

### 6.2 请求体保护

| 保护 | 值 |
| --- | --- |
| 请求体上限 | 64MB，超出返回 413 |
| 解压 | 支持 zstd / gzip / deflate（Codex 用 zstd） |
| 压缩头处理 | 改写后移除 `content-encoding`，因为原压缩已失效 |
| 长度头处理 | 按改写后的实际长度重算 `content-length` |

### 6.3 日志

单文件 16MB 上限，超限自动滚动新文件。记录的事件类型：

```
started / rewrite / reject / upstream_error / parse_error
decode_error / listen_error / uncaught / unhandled_rejection
```

只记计数、模型名、事件类型、时间戳。**不记任务正文**。

诊断追踪是独立链路，默认关闭，通过 `COMPAT_TRACE` 环境变量或追踪开关文件显式打开（两者的状态都做短时缓存，避免每个流分片都访问磁盘）。开启后使用异步写流记录 `/responses` 请求元数据，包含 instructions 长度、SHA-256、模板标记和首尾片段；完整 instructions 仅按模型保存最近一次，并受大小上限保护。诊断追踪同样按固定大小滚动，不使用同步写入阻塞请求线程。

### 6.4 健康端点

```
GET http://127.0.0.1:15731/__compat/health
→ {"name":"codex-compat","version":"0.1.0",
   "port":15731,"upstreamHost":"127.0.0.1","upstreamPort":15721,
   "mode":"cc-switch","uptimeMs":N,
   "stats":{"requests":N,"rewritten":N,"stripped":N,"projected":N,
            "orphanOutputs":N,"rejected":N,"errors":N}}
```

安装器与状态查询用它区分「端口空闲」「本工具旧实例」「被其他程序占用」，因此重复安装不会重复启动实例。

### 6.5 配置漂移与自动抢回

看门狗每 30 秒检查一次 Codex 配置里的 `base_url` 是否仍指向兼容层。上游工具（例如 CC Switch）切换接管模式时可能把它改回原地址，从而导致「兼容层活着但流量不过来了」这种最难排查的状态，所以这里做了显式处理：

| 当前值 | 策略 | 动作 |
| --- | --- | --- |
| 等于兼容层地址 | 任意 | 无动作（healthy） |
| 等于安装清单里记录的原始上游地址 | `auto` | 抢回：原子写回 base_url、记 `reclaim` 事件、发系统通知 |
| 等于安装清单里记录的原始上游地址 | `notify-only` | 只通知一次，不改配置 |
| 未知地址（被改成第三方值） | 任意 | 只通知一次，绝不覆盖未知来源的改动 |
| 任意 | `off` | 完全不处理 |

抢回带节流：两次尝试之间至少间隔 30 秒，每小时最多 20 次；超过上限后只通知，避免与上游工具互相改写形成死循环。节流与通知状态保存在守护进程内，重启守护后重置。

## 七、配置依赖

兼容层生效需要三项配置同时成立：

| 配置 | 位置 | 必需性 |
| --- | --- | --- |
| `base_url` 指向兼容层监听地址（默认 15731） | `~/.codex/config.toml` | 必需，否则兼容层看不到流量 |
| `tool_namespace = "agents"` | `~/.codex/config.toml` | 官方模型作主控时必需 |
| `multi_agent_version = "v2"` | 模型目录文件 | 必需，否则无法指定子代理模型 |

### 7.1 multi_agent_version 的三层解析

这里有个容易踩的坑。Codex 解析子代理面是三层优先级：

```
1. 请求级覆盖（override）
2. 模型目录的 multi_agent_version 字段
3. 全局 features.multi_agent_v2.enabled
```

关键细节：**`[features.multi_agent_v2]` 段一旦存在，第 3 层的兜底就会从默认 v2 变成配置值**。如果只写了 `tool_namespace` 而没写 `enabled = true`，兜底会变成 false（v1）。

实测验证：

| 模型目录字段 | 是否有 `[features.multi_agent_v2]` 段 | 实际走向 |
| --- | --- | --- |
| `"v2"` | 有 | v2（字段优先） |
| `"v1"` | 有 | v1 |
| 缺失 | 有，`enabled` 未写 | **v1**（兜底被关） |
| 缺失 | 完全没有该段 | v2（原生默认） |

所以安装流程同时写入 `tool_namespace` 和显式启用项，把这层隐式行为变成显式配置。

### 7.2 配置优先级与运行目录

生效优先级为：命令行参数 > 环境变量 > 配置文件 > 默认值。配置文件是 `~/.codex-compat/config.json`（可用 `CODEX_COMPAT_HOME` 或 `--home` 改运行态根目录），只保存地址、开关与策略，不保存任何凭据。运行态目录分工：

| 路径 | 用途 |
| --- | --- |
| `config.json` | 持久化设置（监听、上游、改写开关、功能开关、服务与抢回策略、日志级别） |
| `config/` | 用户级模型模板、角色模板与提示词模板；首次安装时从包内 `config/` 落位，之后由第一跳按 `service.templateRefresh` 策略与包内保持一致（未被本地改过的自动刷新，改过的只报告） |
| `logs/` | 兼容层事件日志、守护脚本日志、按需开启的追踪 |
| `backups/` | 每次写入前的备份（含 `backups/templates/<changeId>/` 的模板刷新备份） |
| `run/` | 单实例锁与「有意停止」标记 |
| `state/` | 运行态状态目录（含模板所有权记录 `templates.json`） |
| `instances/` | 实验实例（多开）目录，每实例含独立 `instance.json`、密钥、`codex/`（独立 CODEX_HOME）与 `compat/` 运行目录 |
| `diagnostics/` | 菜单「生成诊断包」输出的脱敏诊断目录 |
| `install-manifest.json` | 安装器改过的内容与原始 `base_url`，供还原与卸载使用 |

历史环境变量（`COMPAT_*`）仍然被识别，便于旧脚本平滑过渡；它们不写入配置文件。

模型模板要经过两跳才生效：**第一跳**把包内 `config/{prompts,templates}` 落到运行目录 `config/`，**第二跳**由 `mappings.apply` 把运行目录那份写进模型目录条目。两跳各有归属，互不替代：菜单开关改的是运行目录的 `mappings.toml`，所以它不在第一跳的受管集合内；第一跳只写包内存在的同名文件，绝不删除运行目录里包内没有的文件。

两类漂移由守护进程每 30 秒用无副作用的预演检查一次，策略与节流语义共用、状态独立：

| 策略键 | 管的漂移 | 触发面 |
| --- | --- | --- |
| `service.reclaim` | 目录条目里的注入被外部重生成抹掉（第二跳的输出） | `auto` 按映射重写并通知 |
| `service.templateRefresh` | 包内模板没落到运行目录那份拷贝（第一跳） | `auto` 刷新未被本地改过的文件并通知 |

被本地改过的模板文件永不自动覆盖（`auto` 的「静默」只对没被改过的文件成立），需要显式 `codex-compat templates --force`；每次刷新都在 `backups/templates/<changeId>/` 留备份与事务日志。所有权记录落在 `state/templates.json`：没有记录的文件先与包内逐字节比对，一致就补记账、不一致就按「本地改过」处理，迁移过程不静默覆盖任何内容。

### 7.3 多实例（实验 / 多开）

主实例之外，工具可以在 `~/.codex-compat/instances/<name>/` 下创建彼此隔离的实验实例，用于「先试跑、再接入主力配置」：

| 路径 | 用途 |
| --- | --- |
| `instance.json` | 实例元数据（端口、上游、模型、目录模式、密钥环境变量名、自启开关） |
| `secrets.env` | 仅本实例使用的密钥；用 `--key-env` 创建时不落盘 |
| `codex/` | 该实例专属的 `CODEX_HOME`，与主力 `~/.codex` 完全隔离 |
| `compat/` | 该实例的运行目录（`config.json`、日志、运行态、目录缓存） |

实例端口从 15900 起扫描，与主实例的 15731 区间分开；健康端点返回 `home` / `instance` 字段，端口复用只在同 `home` 时成立，避免新实例误复用主实例端口。实例默认按需启停、不注册任何计划任务，只有显式 `--autostart` 才注册 `CodexCompatService-<name>` / `CodexCompatServiceGuard-<name>`。`instance run <name>` 会注入 `CODEX_HOME` 与密钥环境变量后启动 `codex`，并打印等价手工命令。

实例的 `codex/config.toml` 由工具生成：`model`、`model_provider`、`[model_providers.<id>]`（`base_url` 指向本实例、`env_key`、`wire_api = "responses"`）、按目录模式决定的 `model_catalog_url` 或 `model_instructions_file`，以及显式的 `[features.multi_agent_v2]`。

## 八、模型模板与子代理角色

`config/mappings.toml` 是模型模板与角色映射的唯一来源：只管理明确列出的模型，不按厂商前缀扫描。每条绑定至少提供 `model_id`（全量 ID）或 `model_id_like`（模糊匹配）之一，并关联一份模型模板（`config/templates/models/`）和一份角色模板（`config/templates/agents/`），角色指导正文来自 `config/prompts/` 下的模板文件。

`model_id_like` 不区分大小写，且只比较模型 ID 的最后一段——供应商前缀变化时（例如从 CC Switch 的 `ccs-deepseek/deepseek-v4.1-flash` 换成网关直出的 `deepseek-v4.1-flash`）同一条绑定依然命中。解析顺序是「全量 ID 优先 → 模糊兜底」：0 命中记 `missing_model`，多命中记 `ambiguous_model` 并跳过该绑定，同一个模型只允许由一个绑定管理。写入还受「纯官方保护」约束：命中 `gpt-*`、`codex-*`、`o<N>` 这类官方命名时直接拒绝写入，官方模型条目与提示词逐字节不动。

同步过程是幂等的：只覆盖明确绑定的属性，其他模型能力保持目录里的现值；同名角色冲突会报告而不是覆盖；每次写入前备份，可回退到上一状态。当前内置的绑定是 `auto(free)` 与 `deepseek-v4.1-flash`（两条都同时写了 `model_id` 与 `model_id_like`），复用同一份 DeepSeek 模板与角色指导；其他网关模型不作改动，避免引入未经验证的影响。

没有全局模型目录时，兼容层还可以托管 provider 级目录（`GET /__compat/catalog` 配合 `model_providers.<id>.model_catalog_url`）。该能力已实现但默认关闭：2026-10 在 Codex 0.160.1 上实测 CLI 完全不拉取 provider 级目录——注意 `model_catalog_url` 在该版本的 provider TOML 结构里就已存在（写入不触发 unrecognized setting 警告），CLI 只是从不拉取：配好合法 `model_catalog_url` 后 `codex debug models` 返回 `{"models":[]}`，兼容层日志中该端点请求数为 0；`codex features list` 显示 `api_key_model_discovery` 仍 under development、`remote_models` 已 removed，因此这条路径要等 Codex 把「按 provider 配置发现模型目录」的能力转正，而不是等本机升级版本。提示词改由 `model_instructions_file` 送达；该键必须写成顶层键——写进 `[model_providers.<id>]` 表内会被 Codex 忽略（lab 实例生成器已修正为顶层写法）。CC Switch 场景下模板的实际载体是环境里已有的模型目录条目（即 CC Switch 维护的那份目录，如 `~/.codex/cc-switch-model-catalog.json`），具体由哪个配置指针交给 Codex 由该上游工具决定，本工具只负责把模板写进目录条目；`~/.codex/models_cache.json` 是过期缓存，不是生效来源。

## 九、验证矩阵

五种主控 × 子代理组合的实测结果：

| 组合 | 阶段 A | 阶段 B | 结果 |
| --- | --- | --- | --- |
| 官方 → 官方 | 触发（剥离） | 触发（无明文可投影） | 通过 |
| 官方 → 网关 | 触发 | 触发 | 通过 |
| 网关 → 官方 | 不触发 | 触发（关键） | 通过 |
| 网关 → 网关 | 不触发 | 触发 | 通过 |
| 网关 → `auto(free)` | 不触发 | 触发 | 通过 |

其中「网关 → 官方」是最难的一例：初版只对网关下游做投影，官方下游遇到明文容器会断流。修正为「投影与下游无关」后通过。

### 9.1 DeepSeek 提示词与新进程验证

`auto(free)` 与 `deepseek-v4.1-flash` 共用同一份约 2.3 万字符的模型模板。模板由 DeepSeek 官方 Codex 集成文档的正文与 **程小帮** 提供的通用约束（指令优先级、工程判断、端到端执行责任）组成；来源方专属的工具、Memory、运行时路径没有移植。

模板更新后，新的 Codex CLI 进程实际发出的 `instructions` 已核对到与模板逐字一致，并包含三处关键标记（指令优先级段、工程判断段、结束前确认最终状态段）。已有会话需要重启才能读取更新。

### 9.2 桌面应用与委派创建会话验证

| 场景 | 主控 base 提示词 | 子代理 | 结果 |
| --- | --- | --- | --- |
| 重启后新建的会话（DeepSeek 主控） | 与模板逐字一致 | 专用角色 + 逐字开发者指导 | 通过 |
| 委派创建的新会话（DeepSeek 主控） | 同上 | 专用角色，口令与算术正确 | 通过（修复现象 D 后） |
| 修复前委派创建的新会话 | 模板一致 | — | 失败：上游 400（现象 D） |
| 重启前已存在、仅切换主控的旧会话 | 创建时的原始提示词，不含模板 | 专用角色，模型/指导正确 | 旧会话不重取模板 |

结论：模型模板在**会话创建时**取用，切换已有会话的主控模型不会重取；要让 DeepSeek 模板生效需要新建会话。

## 十、已知边界与风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 依赖未公开行为 | 依赖「官方后端见标记即加密」这个行为 | 版本升级后重新回归验证 |
| 上游重写目录 | 模型目录的 `multi_agent_version` 可能被上游工具改回或清空 | `codex-compat doctor` 体检与修复 |
| schema 结构变更 | Codex 若改工具 schema 或容器字段名，判定会失效 | 观察 `rewrite` 日志计数 |
| 纯本地工具 | 不是官方功能，无上游支持 | 有源码可自行维护 |
| 提示词缓存 | 已启动的 Codex 会话不会热加载模型目录；实测切换主控模型也不会重取模板 | 重启 Codex 或新建会话 |
| 跨平台服务 | macOS/Linux 分支已实现，但当前只在 Windows 实机验证 | 分别在目标系统运行安装、`doctor` 与守护回归 |

## 十一、参考实现与致谢

本方案参考了开源项目 **BigStrongSun/ccswitchmulti** 与 **farion1231/cc-switch**（均为 MIT，Copyright (c) 2025 Jason Young）的跨 provider 子代理投递设计：它们在代理层实现路由与凭据管理，本项目沿用其中「在代理层做形态改写」的思路。

本工具是**轻量替代**：只做投递兼容这一件事，不接管路由、不管理凭据、不改动上游工具本体。适用于已经使用上游本地代理且不想更换工具链的场景。

DeepSeek 提示词模板包含 DeepSeek 官方发布的 Codex 集成文档内容：

- <https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/>

同时实名致谢 **程小帮**：模板中的指令优先级、工程判断与端到端执行责任约束来自其提供的通用约束。

完整许可原文与版权行见 [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 十二、非官方声明

本项目是非官方社区项目，与 OpenAI、DeepSeek、CC Switch 均无隶属、背书或支持关系；产品名称仅用于描述互操作性。它依赖不属于任何公开契约的 Codex 行为，可能随 Codex 升级失效，因此提供 `codex-compat bypass`（应急旁路）与 `codex-compat restore`（还原配置）两个出口。
