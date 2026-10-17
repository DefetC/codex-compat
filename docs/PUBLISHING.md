# 发布与交接说明

本目录已经是「可直接发布」状态：不包含运行日志、备份、模型目录存档与任何内部地址。
按当前约定，**没有**初始化 git、**没有**创建 GitHub 仓库、**没有**执行 npm 发布，下面命令由仓库 owner 自行执行。

## 一、发布前检查（每次都要做）

```bash
npm install --no-audit --no-fund
npm test                      # 全部离线测试
npm run pack:check            # 打包内容白名单校验
```

再加两道人工检查：

```bash
# 1) 确认没有内网地址、个人路径与旧工具残留
npm run scan:privacy

# 2) 确认打包内容清单里没有日志/备份/模型目录存档
npm pack --dry-run

# 3) 补齐 npm 页面需要的仓库元数据（当前 package.json 里为空，发布前必改）
#    repository / homepage / bugs / author —— 不填的话 npm 页面没有源码入口，用户无法反馈问题
```

## 二、发布到 GitHub

```bash
cd <本目录>
git init
git add .
git commit -m "chore: initial release of codex-compat v0.1.0"
git branch -M main
git remote add origin <你的仓库地址>
git push -u origin main
```

推送后 CI（`.github/workflows/ci.yml`）会自动在 Windows / macOS / Linux × Node 18 / 20 / 22 上跑测试，
并执行打包内容校验；gitleaks 步骤需要在仓库 Secrets 里配置 `GITLEAKS_LICENSE` 才会启用。

## 三、发布到 npm

```bash
npm login
npm publish --access public
```

注意事项：

- 包名固定为 `codex-compat`，版本从 `0.1.0` 起；升级时先改 `package.json` 的 `version` 并补 `CHANGELOG.md`。
- `files` 字段已经做了白名单，`npm pack --dry-run` 里出现预期之外的文件时不要发布。
- 发布后用户即可：

```bash
npm install -g codex-compat
codex-compat install
```

## 四、本次交付中需要 owner 知悉的两个已接受风险

1. `config/prompts/deepseek-codex.md` 保留当前融合版本（用于缓解 DeepSeek 子代理提前停止），
   并在 `THIRD_PARTY_NOTICES.md` / `README` 中实名致谢程小帮。该内容与名称会随仓库公开。
2. 本工具依赖 Codex 未公开的行为（`encrypted` 标记与 `encrypted_content` 容器），
   Codex 升级后可能失效；已提供 `codex-compat bypass` 应急旁路与 `doctor` 诊断。
3. `config/prompts/deepseek-codex.md` 是一份**融合文本**：其标题结构与大量句子与 Codex 自身的系统提示词逐字一致，
   并包含 DeepSeek 官方文档的集成指导与 程小帮 贡献的约束文本。**署名不等于再分发许可**——本项目的 MIT
   只覆盖它自己的代码，无法替第三方文本授权。当前决策是**保留该文本**，并在 `LICENSE` 与
   `THIRD_PARTY_NOTICES.md` 里做了两件事：明确该文件**不在 MIT 授权范围内**，以及逐段标注三个来源（含"不主张许可"的声明）。
   发布前仍需完成两件确认（详见「发布前合规确认」）：程小帮 的再分发授权；以及 Codex 系统提示词部分的可再分发范围——后者是最大的暴露面。

## 五、仓库里没有的东西（按设计不发布）

- 旧版模型档案备份与覆盖机制（profiles/、profile 脚本）
- 模型目录存档（含第三方专有提示词）、运行日志、备份、抓包产物
- 依赖个人绝对路径的历史诊断工具

这些内容仍保留在迁移前的私有归档目录中，未做删除。

## 五之二、发布前合规确认（不要跳过）

`config/prompts/deepseek-codex.md` 随包分发前，逐条确认（当前状态：保留文本 + 已在 LICENSE/NOTICES 中划分授权范围与来源）：

1. 该文本中来自 Codex 系统提示词的部分是否可以再分发（不建议默认可行，这是主要风险）；若不可行，最小改动是把这些段落替换为自研等效表述，只保留行为靶点；
2. DeepSeek 官方集成文档的内容是否可以再分发（若否，改为只保留链接与自研表述）；
3. 程小帮 贡献的约束文本是否取得了再分发授权（署名不构成授权）；拿到授权后，把授权状态写进 `THIRD_PARTY_NOTICES.md` 的 3.4 节；
4. 若该文本来自雇主或内部工具，确认职务作品归属与对外开源许可（公司可能是权利人）。

任何时候都可以用「用户自备提示词」形态发布：lab 实例的 `model_instructions_file` 与主实例的模型目录补丁
都只是读写一个文件路径，仓库不带文本同样可以工作，只是需要使用者自行提供其有权使用的提示词。

## 六、发布前复查阶段新增的能力与已知局限

发布前复查阶段补入了多实例（lab）、`model_id_like` 模糊匹配、纯官方保护与菜单 v2，发布说明与 README 已同步。其中两点需要在发布公告里如实说明：

1. **provider 级模型目录托管默认关闭。** 该能力（`GET /__compat/catalog` + `model_providers.<id>.model_catalog_url`）已实现，但 2026-10 在 Codex 0.160.1 上实测：CLI 不会为 env_key provider 拉取 provider 级目录。这**不是**本机版本落后：`model_catalog_url` 在 0.160.1 的 provider TOML 结构里已存在（写入不触发 unrecognized setting 警告），只是 CLI 从不拉取——配好合法 `model_catalog_url` 后 `codex debug models` 返回 `{"models":[]}`、兼容层该端点请求数为 0；`codex features list` 显示 `api_key_model_discovery` 仍 under development、`remote_models` 已 removed，故该开关要等 Codex 把「按 provider 配置发现模型目录」的能力转正后再启用。提示词注入不受影响：lab 实例以顶层键 `model_instructions_file` 送达提示词，已实测逐字符一致（写进 `[model_providers.<id>]` 表内会被 Codex 忽略）；CC Switch 场景的模板由环境里已有的模型目录条目承载（即 CC Switch 维护的那份目录，如 `~/.codex/cc-switch-model-catalog.json`），具体指向方式由该上游工具决定，本工具只负责把模板写进目录条目——`~/.codex/models_cache.json` 是过期缓存，不是生效来源。
2. **实验实例是「先试跑」通道。** 多实例默认按需启停、不注册计划任务、端口从 15900 起，主力实例（15731）不受影响；新用户可以先建实验实例验证第三方供应商，再决定是否接入主力配置。

发布前建议顺带确认：本机 `~/.codex-compat/instances/` 下的实验实例与被手改过的密钥只存在于本机运行时目录，不随仓库分发（`npm run scan:privacy` 与 `npm pack --dry-run` 是这两道闸门）。
