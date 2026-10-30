# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

支持范围以最新已发布版本为准，源码候选不等同于 npm 发布。2026-10-30 核对时，npm 最新仍为 `0.1.0`，源码候选为 `0.1.1`；发布后应同步此状态。因为依赖未公开的 Codex 行为，Codex 升级后仍需重新验证，详见 [兼容性说明](docs/COMPATIBILITY.md)。

## Reporting a vulnerability privately

Please do **not** open a public issue, pull request, or discussion for a suspected vulnerability, and do not disclose it anywhere else before it is fixed.

Preferred channel: use the private vulnerability reporting feature of the platform that hosts this repository — on GitHub, the **Security** tab of the repository, then **Report a vulnerability**. Reports filed that way stay private between you and the maintainers until a fix is ready.

If private reporting is unavailable on the hosting platform, contact the maintainers privately through the public contact information published on the repository owner's profile page.

When you report, please include:

- The affected version of `codex-compat`, your operating system, and your Node.js version.
- The configuration in play: listen address, upstream kind (CC Switch or custom endpoint), and any non-default setting that matters.
- A clear description of the impact and the steps to reproduce it.
- Optional: the output of `codex-compat doctor` and, if tracing was enabled, a **redacted** trace excerpt.

Do not include real credentials, tokens, or task content in a report. If a secret may already have leaked, rotate it before reporting; the report itself should only describe the mechanism.

We will acknowledge your report as soon as possible, investigate it, and coordinate the fix and the disclosure timeline with you. Please give us a reasonable window to ship a fix before publishing details.

## What counts as a vulnerability here

Reports in any of these areas are in scope:

- 转发认证头或凭据在默认日志、状态输出、追踪及诊断副本中泄露，或未经用户授权被持久化。用户显式保存实例密钥、原始配置及其备份属于已说明的存储范围，但权限失守或意外公开仍应报告。
- Task bodies or message content being persisted by default, or a redaction/size cap in the tracing path failing to hold.
- 改写逻辑将任务投递到错误下游、绕过不透明任务路由守卫，或把无法恢复的任务正文静默替换成空任务。经过明确验证并授权的精确名单透传不等同于漏洞；保留历史输出、推理或原生压缩密文也不等同于阶段 C 失效。
- Escaping the intended scope of a rewrite, such as modifying a request that should pass through untouched, or a configuration/template file being able to influence files outside the tool's own runtime home.
- Local privilege issues in the installer, the guard, or the uninstall/restore path (unexpected file overwrite, following a link where it should not, weakening permissions on an existing file).
- Bypassing the explicit failure in stage C, or a way to make the layer report success while the subagent receives no task.

Out of scope: a hostile upstream endpoint, a compromised Codex installation, and questions that only apply to a modified or repackaged copy of this project.

## Security model and guarantees

**The tool sits in the credential path.** `codex-compat` is a local forwarding proxy: requests from Codex to your upstream pass through it, and so do the credentials those requests carry. It never decides how to authenticate you, and it never rewrites authentication headers.

**转发不记录认证，不等于所有文件无凭据。** 转发认证头只在内存中使用，不写默认日志或追踪。用户的原始 URL 配置、自定义敏感字段、配置备份，以及显式 `instance create --key` 的 `secrets.env` 仍可能含凭据；`--key-env` 不将实例密钥写到该文件。不能直接公开这些运行文件，也不能因诊断副本已脱敏而认定原文件安全。

**不解密原生密文，不自动认证上游。** 阶段 C 只对已识别的不透明任务按当前路由或精确模型名单决定透传/拒绝；名单不是密文来源证明，也不改变默认所有父模型的明文化策略。历史输出、推理和原生压缩密文保持原样，输出选择器过滤不删除它们。`ccswitch-compaction-v1:` 只是 Base64 文本摘要，绕行还原不等同于原生解密。不能保证所有未知密文格式都被识别，也不实现设备签发或跨后端密文互解。

**Logs are counters only.** Normal logs record event types, counters, model names, and timestamps. Task content and credential material are not logged. Diagnostic tracing is off by default; when you enable it, it writes request metadata plus short head/tail snippets and, at most, the most recent instructions text per model, all under a size cap. See [PRIVACY.md](PRIVACY.md) for the exact contents.

**Local by default.** The layer listens on the loopback interface (`127.0.0.1`) unless you change it. If you point it at a routable interface, anyone who can reach that address can relay requests through your credentials — do not do that unless you fully understand and accept the consequences. A remote-friendly deployment is not a supported configuration.

**Writes are reviewable and reversible.** The installer backs up every file before changing it and records what it did in the install manifest. `--dry-run` shows the change list without writing anything, and `restore` / `uninstall` roll the changes back.

**This is not a security boundary.** The layer intentionally relays prompt content between providers; it does not classify, filter, or sandbox what you send. Use it only with upstream endpoints you already trust, and keep your normal provider-side data handling rules in mind.

### 新兼容策略的安全边界

- 所有 Responses 压缩模式都先校验编码、UTF-8 和 JSON 对象根；错误在本地返回 400，接收正文或解压结果超限返回 413。fzstd 的结果检查仍发生在预分配之后，不是完整 OOM 或并发资源耗尽防护。
- 自定义上游的同名 GPT 不能自动获得官方扩展信任；CC Switch 官方分支仍依赖既有命名约定，配置者必须确保实际路由与之吻合。
- `bundle` / `diagnose` 按字段和文本规则脱敏，坏日志行明确省略并报告数量；未知敏感字段、地址、路径和提示词仍需人工检查。原始配置和旧日志不会因生成脱敏副本而被自动改写。
- 测试口令命中、计数及父代理复述不能证明任务成功；在线回归应核对独立孩子证据。`artifacts/` 中的测试回答属于主动实验产物，不是默认日志，也不能直接公开真实业务内容。
- 本项目不提供隔离不可信上游、内容审查、设备签发模拟或原生密文跨后端迁移的安全保证。详见 [兼容性说明](docs/COMPATIBILITY.md)。

## Testing etiquette

Only test against your own machine and your own upstream accounts. Do not probe third-party endpoints, other people's installations, or shared infrastructure while investigating an issue.
