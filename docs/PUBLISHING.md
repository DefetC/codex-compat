# 发布与交接说明

## 一、背景与当前状态

本轮目标是修复 Codex 跨模型委托、Responses 输出回放选择器和请求压缩的兼容问题，并强化诊断隐私及真实子代理验收。实现主要位于 `src/compat-policy.cjs`、`src/rewrite.cjs`、`src/compat-proxy.cjs`、`src/redact.cjs` 和 `src/commands/`；配置用法见 [README](../README.zh-CN.md)，模型及版本证据见 [兼容性说明](COMPATIBILITY.md)，变更清单见 [CHANGELOG](../CHANGELOG.md)。

截至 2026-10-30 核对：

| 项目 | 状态 |
| --- | --- |
| GitHub 仓库 | 已存在：[DefetC/codex-compat](https://github.com/DefetC/codex-compat)，主分支为 `main`；不再执行首次建仓流程 |
| npm 包 | 已发布 `codex-compat@0.1.0`，当时 `latest` 为 `0.1.0` |
| 当前源码 | `0.1.1` 候选版本；package、lockfile 根版本和变更说明已同步，尚未发布 npm |
| 仓库元数据 | package 的 `repository`、`homepage`、`bugs`、`author` 已填写，发布前复核即可 |
| 自动发布 | 当前只有 CI，没有自动 npm 发布流程；推分支或标签不等于发布 npm |

发布状态会变化，每次发布前应重新查询，不能用这张快照判断某个版本仍未发布。更新文档、提交、推送、创建 PR、合并、打标签与 npm 发布是不同动作；授权其中一项不自动授权其余动作。以下发布命令只供 owner 在明确授权后执行，本次文档更新不会执行它们。

## 二、0.1.1 交接内容

| 功能点 | 当前行为 | 不能推导的结论 |
| --- | --- | --- |
| 输出回放 | `outputTokenReplay=auto` 对外部路由仅过滤顶层 `include` 的 `output.encrypted_content`；支持显式 `strip` / `preserve` | 不删除历史输出、推理或原生压缩密文，不承诺精确 token 回放或设备签发收益 |
| 请求压缩 | `requestCompression=auto` 对外部路由转发无压缩正文；支持 `decode` / `preserve`；改写后修正编码和长度 | `preserve` 不跳过 JSON、UTF-8 或解压校验，也不能保留已经失效的压缩声明 |
| 委托与守卫 | `stripAlways=true` 默认覆盖所有父模型；`opaqueTaskModels=[]` 默认不给外部模型授权不透明任务透传 | 名单只精确匹配当前接收模型，不关闭明文化策略，不证明跨后端密文互解 |
| CC Switch 摘要 | 经 CC Switch 保留封装；绕行时仅严格还原 `ccswitch-compaction-v1:` 文本摘要为普通 user 消息 | 原生密文不解密，不恢复原始 token、缓存和全部工具状态 |
| 配置边界 | `config set compat.*` 只保存兼容设置，不同步模型目录，也不自动重启代理 | 运行中的代理不会因保存配置而立即采用新策略；完整 `restart` 仍有既有服务注册和启动同步流程 |
| 日志与诊断 | 新增选择器、解压和摘要计数；默认事件日志只记录安全元数据，诊断包结构化脱敏并明确省略损坏行 | 非零改写计数不证明子代理成功，脱敏包也不能未经人工检查直接公开 |
| 严格回归 | 独立孩子来源、精确模型、真实回答、双方完成、父派发及成功等待；增加派发口令命中与指纹诊断 | HTTP 200、父 stdout 口令、退出 0 或独立重试通过都不能代替首轮成功证据 |

### 验证结果与保留风险

- 本地 `npm test` 的 26 组测试、打包检查和隐私扫描已通过；实现提交 `287f915` 的 Windows/Ubuntu × Node 18/20/22 CI 及打包检查已通过。后续发布必须检查实际待发布提交，不能沿用旧提交的绿色结果。
- Windows + Node 22.14.0 + Codex CLI `0.163.0-alpha.10.2` 已完成三类模型九种父子组合、多轮、工具、压缩后子代理、同孩子续聊及明确名单下的不透明委托。历史安装和回退基线仍为 `0.160.1`，不把 alpha 验收泛化为全部版本支持。
- 两次 Flash 首轮分别缺少成功等待或预期孩子回答，保留为失败；独立复核及额外有限三次隔离测试通过。最初原始会话已清理，不能反推完整根因，更不能写成“偶发问题已修复”。
- 64MB 接收正文及解压结果限额不代表完整内存防护；fzstd 当前接口仍有结果检查前的预分配风险。
- macOS 本次未运行 CI，也未实机验证；Linux 的 CI 不替代实机安装、自启、通知和端到端模型派发。

## 三、发布前检查（每次都做）

在实际待发布提交的独立、干净检出中验证。不要为让工作区变干净而丢弃用户改动、提交无关忽略规则或删除锁文件。

以下命令使用 Bash / Git Bash 语法：

```bash
node --version
npm ci --no-audit --no-fund
npm test
npm run pack:check
npm run scan:privacy
npm pack --dry-run
```

`npm test` 不调用商业模型，但包括本机真实 HTTP 边界测试，并非完全不使用网络。`selftest` 另包含健康端点、上游可达性和映射预演，也不能称为纯离线。

发布前人工复核：

1. package 与 lockfile 的项目根版本一致；不要把依赖 fzstd 自身的 `0.1.1` 当作项目版本修改。
2. 发布包文件清单只含运行所需代码、模板和公开文档，没有日志、备份、实验产物、认证、实例密钥、模型目录存档或个人路径。
3. 检查原始配置、追踪、诊断包与测试证据没有被暂存。隐私扫描通过不是任意文本都安全的证明。
4. 确认实际发布提交的 CI 已通过。gitleaks 步骤被跳过时如实说明，不把作业绿色当作已完成密钥扫描。
5. 完成下文第三方文本再分发确认。已有 npm 发布或技术测试通过，都不能替代授权。

### 按需真实模型验收

只有变更需要并且账户、上游及额度获得授权时才运行在线回归；不要接入自动 CI。

```bash
# 换成要验证的原生 CLI；Windows Git Bash 可用 C:/path/to/codex.exe
export CODEX_BIN="/absolute/path/to/codex"
export CODEX_TEST_BASE_URL="http://127.0.0.1:15731/v1"
"$CODEX_BIN" --version
npm run test:regression -- FLASH-FLASH
```

可用 `CODEX_TEST_AUTH_FILE` 指定已有身份、`CODEX_TEST_CATALOG` 指定目录、`CODEX_TEST_MODELS` 指定三个精确模型名称的 JSON 数组。默认组合 ID 为 `OFF`、`GW`、`FLASH` 的九种父子组合，默认模型名是本次验收所用命名，不保证每个上游都有这些模型。驱动只允许本机代理，每例新建只读 home/workspace、禁止自动批准、强制输出回放及请求压缩，最终清理认证副本与原始会话；摘要证据写入 git 忽略的 `artifacts/regression/`，不随包公开。失败和后续复核分别保留，不通过无限重试覆盖失败。

## 四、既有仓库的增量集成与 CI

不执行 `git init`、重新添加 `origin` 或首次推送 `main`。按既有工作流在修复分支上只暂存相关文件，检查 diff，提交后推送；是否创建 PR、合并或打标签由 owner 明确决定。不要使用 `git add .` 混入用户改动、实验和认证，也不要强推。

CI 的事实来源是 [ci.yml](../.github/workflows/ci.yml)：

- push/PR：Windows、Ubuntu × Node 18/20/22，运行完整 `npm test`。
- 手动 `workflow_dispatch`：同一矩阵加入 macOS；配置了矩阵不等于该次已执行。
- 打包校验：Ubuntu / Node 22。
- gitleaks：仅配置 `GITLEAKS_LICENSE` 时启用实际扫描步骤；未配置则跳过。
- 不执行商业模型回归，不自动发布 npm。

## 五、npm 增量发布（仅明确授权后）

`0.1.0` 已发布，不能覆盖同一个版本。本次是兼容修复，使用 patch `0.1.1`；后续版本按实际变更决定。版本修改需同步 package、lockfile 根条目和 CHANGELOG，修改版本本身不应顺带提交、打标签或发布。

owner 应在已确认的发布提交上核对包名、版本、registry 和 npm 身份。若当前身份未授权，不自动切账号或创建凭据；由 owner 完成登录。

```bash
npm view codex-compat version dist-tags --json --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
# 仅在检查、合规确认与发布授权都完成之后执行
npm publish --access public --registry=https://registry.npmjs.org
```

不要把 token 写进仓库或提交 `.npmrc`。如果 `0.1.1` 已由他人发布，停止并核对来源，不删除或尝试覆盖它，也不擅自再升一个版本。

发布完成后再核对：

```bash
npm view codex-compat@0.1.1 version --registry=https://registry.npmjs.org
npm view codex-compat dist-tags --json --registry=https://registry.npmjs.org
```

确认成功后，将 CHANGELOG 的“待发布”换成真实发布日期，同步 README 和本页的发布状态。创建版本标签或 GitHub Release 是另外的可追溯动作，不是 npm 发布的必然副作用；只有获得相应授权才执行，并确保对应同一提交。

以下安装命令仅在 `0.1.1` 实际发布后适用：

```bash
npm install -g codex-compat@0.1.1
codex-compat version
codex-compat status
codex-compat doctor
```

包升级和主配置重新接入不是同一件事；只有实际需要变更接入配置时才执行 `install` / `repair`。兼容策略在代理启动时读取，标准 `restart` 会重新注册服务并进入既有看门狗同步流程；须保留计划任务注册或避免启动映射时，不应把完整重启描述为只重载代理。不要自动重启 Codex、CC Switch 或改写它们的认证与真实会话。异常时可用 `bypass` 恢复原路由，后续按 [兼容性说明](COMPATIBILITY.md) 回退和复检。

## 六、运行与第三方文本风险

1. `config/prompts/deepseek-codex.md` 保留当前融合版本（用于缓解 DeepSeek 子代理提前停止），
   并在 `THIRD_PARTY_NOTICES.md` / `README` 中实名致谢程小帮。该内容与名称会随仓库公开。
2. 本工具依赖 Codex 未公开的行为（`encrypted` 标记与 `encrypted_content` 容器），
   Codex 升级后可能失效；已提供 `codex-compat bypass` 应急旁路与 `doctor` 诊断。
3. `config/prompts/deepseek-codex.md` 是一份**融合文本**：其标题结构与大量句子与 Codex 自身的系统提示词逐字一致，
   并包含 DeepSeek 官方文档的集成指导与 程小帮 贡献的约束文本。**署名不等于再分发许可**——本项目的 MIT
   只覆盖它自己的代码，无法替第三方文本授权。当前决策是**保留该文本**，并在 `LICENSE` 与
   `THIRD_PARTY_NOTICES.md` 里做了两件事：明确该文件**不在 MIT 授权范围内**，以及逐段标注三个来源（含“不主张许可”的声明）。
   发布前仍需完成两件确认（详见下一节）：程小帮的再分发授权；以及 Codex 系统提示词部分的可再分发范围——后者是最大的暴露面。

### 发布前合规确认（不要跳过）

`config/prompts/deepseek-codex.md` 随包分发前，逐条确认（当前状态：保留文本 + 已在 LICENSE/NOTICES 中划分授权范围与来源）：

1. 该文本中来自 Codex 系统提示词的部分是否可以再分发（不建议默认可行，这是主要风险）；若不可行，最小改动是把这些段落替换为自研等效表述，只保留行为靶点；
2. DeepSeek 官方集成文档的内容是否可以再分发（若否，改为只保留链接与自研表述）；
3. 程小帮贡献的约束文本是否取得了再分发授权（署名不构成授权）；拿到授权后，把授权状态写进 `THIRD_PARTY_NOTICES.md` 的 3.4 节；
4. 若该文本来自雇主或内部工具，确认职务作品归属与对外开源许可（公司可能是权利人）。

“用户自备提示词”可作为替代发布方案：lab 的 `model_instructions_file` 与主实例模型目录补丁可以指向使用者有权使用的文本。但这不是当前包已有的“移除随包提示词”开关；当前打包检查要求该提示词文件存在，若调整发布形态，需要同步模板、安装逻辑和验收，不能只删文件后宣称现有测试仍通过。

## 七、不公开的本地数据与其他已知限制

按设计不打包或提交：旧模型档案、模型目录存档、日志、备份、抓包、在线回归原始会话和身份副本、实例 `secrets.env`、依赖个人路径的历史诊断工具。私有归档是否存在或何时清理由 owner 管理，不从公开文档推断其当前状态。

provider 级目录托管仍默认关闭；Codex `0.160.1` 已验证不会拉取该目录，最低 `0.156` 门槛未逐版本实机回归。lab 顶层 `model_instructions_file` 与既有 CC Switch 目录送达的区别、跨平台未验证项及纯官方保护见 [兼容性说明](COMPATIBILITY.md)。

原始配置、备份、追踪及主动实验的摘要回答可能包含敏感信息。`bundle` / `diagnose` 只生成本地脱敏副本，不上传；未知字段、地址、路径和提示词仍需人工检查。不能用“默认转发不记录认证”推断所有运行文件都能公开，详见 [隐私说明](../PRIVACY.md) 与 [安全报告](../SECURITY.md)。
