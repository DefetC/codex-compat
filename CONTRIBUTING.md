# Contributing

Thanks for wanting to help. `codex-compat` is a small, deliberately narrow tool, and contributions that keep it narrow are the most valuable ones.

## What is useful

- **Bug reports with a reproduction.** A redacted `doctor` output plus what you were doing when it failed is worth more than a long description.
- **Rewrite-rule fixes.** If Codex changed a request shape, the rule and its offline test need to be updated together.
- **Platform verification.** Windows is verified on real hardware; macOS and Linux are implemented but experimental. Running install, `doctor`, the guard, and a delegation round trip on those systems and reporting the result is a real contribution.
- **Documentation fixes**, including translations and corrections where the docs no longer match the implementation.
- **Prompt-template evidence.** If you change the DeepSeek template, bring the source you are working from (see the provenance rules below).

## Ground rules

1. **No telemetry, ever.** The tool must not call home, report usage, or add analytics. See [PRIVACY.md](PRIVACY.md).
2. **默认日志不记录正文或认证。** 只记录计数、模型名、路由和安全事件元数据；不记录参数裸词或原始异常正文。显式追踪可能保存提示词，主动在线实验可能保存测试回答，两者须按 [PRIVACY.md](PRIVACY.md) 复核和清理，不能混入发布包。
3. **Keep the failure explicit.** If content cannot be delivered safely, the layer must fail loudly. Do not replace an explicit error with a silent fallback, an empty task, or a best-effort guess.
4. **Keep changes scoped.** One concern per pull request. Do not reformat untouched code, do not reorder imports, and do not add a dependency for something the standard library already does.
5. **Node.js 18 or newer.** New runtime dependencies need a prior discussion in an issue; the dependency list is intentionally tiny and every entry has to earn its place.

## Development setup

```bash
npm ci          # 按 lockfile 安装当前两项运行时依赖
npm start       # opens the interactive menu from this checkout
```

Run the CLI from source without linking it:

```bash
node bin/codex-compat.cjs status
node bin/codex-compat.cjs doctor
```

### Repository layout

| Path | Contents |
| --- | --- |
| `bin/` | CLI entry point and menu |
| `src/` | Proxy, rewrite rules, configuration, templates, platform adapters, guard |
| `scripts/` | Installer, repair, service control, uninstall, configuration sync |
| `config/` | Model templates, agent role templates, and the fused prompt templates |
| `install/` | Platform-specific install helpers |
| `docs/` | Architecture and compatibility notes |
| `tests/` | Offline test suite, plus opt-in live checks |

## Testing

默认套件不调用商业模型、不需要账户，但包含本机真实 HTTP 边界测试，不能解释为完全不使用网络。

```bash
npm test
npm run pack:check
npm run scan:privacy
```

本次新增的 `test:compat-policy`、`test:compat-proxy`、`test:child-proof` 和 `test:diagnostic` 已纳入默认套件。迭代时可按需执行这些聚焦脚本；真实 HTTP 用例须断言实际上游收到的字节、编码、长度、响应透传及拒绝时零上游请求，不能只检查纯函数统计。

### 严格的真实子代理验收（按需授权）

跨模型修复的在线验收使用 `test:regression`，不是父 stdout 口令或旧 smoke 的成功标记。以下为 Bash / Git Bash 示例：

```bash
# 指向要验证的原生 CLI；Windows 可使用 C:/path/to/codex.exe
export CODEX_BIN="/absolute/path/to/codex"
export CODEX_TEST_BASE_URL="http://127.0.0.1:15731/v1"
"$CODEX_BIN" --version
npm run test:regression -- FLASH-FLASH
```

`CODEX_TEST_AUTH_FILE`、`CODEX_TEST_CATALOG` 可指定既有身份和模型目录；`CODEX_TEST_MODELS` 是三个精确模型名称的 JSON 数组，默认九组合见 `tests/regression.cjs`。不指定组合 ID 时运行全部九种组合。驱动要求显式 `CODEX_BIN`，只连接本机代理，每例独立只读 home/workspace，禁止自动批准，强制输出回放和压缩，最后清理认证副本及原始会话。

成功必须包含独立孩子来源、父子实际模型、孩子自己的回答和完成记录、父派发回参、派发后的成功等待回参及父完成。口令命中和派发指纹仅辅助定位；失败记录及独立复核分开保留，不改变断言、不重试到成功后覆盖首次失败。原始会话清理后不能承诺恢复旧失败的完整原因。

旧 `test:live` / `test:smoke` 仍是可选辅助检查，不等同于上述严格验收。在线检查消耗真实额度，只在账户和上游获授权且变更需要时运行，不接入自动 CI。`artifacts/` 虽被 git 忽略，仍可能含测试回答和证据，不得提交或直接公开。

### CI 范围

push/PR 验证 Windows、Ubuntu × Node 18/20/22；只有手动 `workflow_dispatch` 才加入 macOS。打包检查在 Ubuntu / Node 22 执行；gitleaks 的实际扫描步骤仅在配置 `GITLEAKS_LICENSE` 时运行，跳过时不能声称扫描通过。CI 不自动发布 npm，也不替代真实安装或商业模型验收。

### Expectations for a rewrite-rule change

- Add or extend an offline test that feeds the old request shape in and asserts the rewritten shape out. A rule without a test will be reverted.
- Keep the request untouched when the rule does not apply. Pass-through is a feature.
- 保留未获当前路由或精确名单授权的不透明任务的显式阶段 C 拒绝，不静默丢任务。历史输出、推理及原生压缩密文应保留，不用模型名称猜测来源；精确名单不是解密能力证明。
- 按实际路由覆盖所有外部端点，包括同名 GPT；阶段 A 默认覆盖所有父模型。只精确过滤输出选择器，不通过 allowlist 删除未知选择器或扫描正文同名文本。
- 覆盖 `auto/strip/preserve`、`auto/decode/preserve`、精确名单、损坏摘要、非法 UTF-8、JSON/压缩及超限；明确 fzstd 预分配限制，不宣称完整 OOM 防护。
- 默认事件日志必须经过结构化脱敏，不记录参数裸词或原始解析异常正文；异常元数据和派发指纹只辅助定位，不能用计数替代子代理成功证据。

## Prompt and template changes

The DeepSeek templates ship with provenance, because the project credits its sources:

- Keep the attributions to the DeepSeek Codex integration guidance and to **程小帮** intact.
- Template text (original and translation) must come from the source you are working from. Do not invent, re-translate, or paraphrase wording and present it as sourced.
- If your change introduces a new source, add its credit and license text to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Reporting bugs

Include, at minimum:

- `codex-compat version` output and the status line from `codex-compat status`.
- Your operating system and Node.js version.
- The relevant configuration, with anything sensitive removed.
- `codex-compat doctor` output.
- If tracing was enabled, a trace excerpt that you have reviewed and trimmed.

For install/repair issues, a useful trick is to reproduce with `--dry-run`: it prints the change list without writing anything.

For anything that looks like a vulnerability, stop and read [SECURITY.md](SECURITY.md) instead — do not file it publicly.

## Pull requests

- Use Conventional Commit style subjects: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
- Describe the motivation, the behaviour before and after, and the evidence that the change works (commands you ran, and what they printed).
- Say which platform you tested on. If you touched a platform adapter, say which platforms you could not test.
- Keep the pull request focused; split unrelated work into separate pull requests.

By submitting a contribution, you agree that it is licensed under the MIT License used by this project.
