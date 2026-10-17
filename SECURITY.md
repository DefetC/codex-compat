# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

Only the latest published source of this project is supported. Because `codex-compat` depends on undocumented Codex behaviour, a Codex upgrade can require a matching change here.

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

- Credentials, tokens, or authentication headers being written to disk, included in logs, exposed in status output, or leaked into a diagnostic bundle.
- Task bodies or message content being persisted by default, or a redaction/size cap in the tracing path failing to hold.
- Rewrite logic that delivers content to the wrong downstream — for example official ciphertext being forwarded to a third-party endpoint, or a task body being silently replaced by an empty task instead of failing explicitly.
- Escaping the intended scope of a rewrite, such as modifying a request that should pass through untouched, or a configuration/template file being able to influence files outside the tool's own runtime home.
- Local privilege issues in the installer, the guard, or the uninstall/restore path (unexpected file overwrite, following a link where it should not, weakening permissions on an existing file).
- Bypassing the explicit failure in stage C, or a way to make the layer report success while the subagent receives no task.

Out of scope: a hostile upstream endpoint, a compromised Codex installation, and questions that only apply to a modified or repackaged copy of this project.

## Security model and guarantees

**The tool sits in the credential path.** `codex-compat` is a local forwarding proxy: requests from Codex to your upstream pass through it, and so do the credentials those requests carry. It never decides how to authenticate you, and it never rewrites authentication headers.

**Credentials are never persisted.** Authentication headers are passed through in memory for the lifetime of a single request. They are not written to the configuration file, the logs, the trace files, or the install manifest. The configuration file only stores addresses, switches, and policies.

**Ciphertext is never decrypted.** The layer does not hold keys and does not attempt to decrypt official ciphertext. Stage C exists precisely so that ciphertext which cannot be delivered safely produces an explicit error instead of a silent empty task.

**Logs are counters only.** Normal logs record event types, counters, model names, and timestamps. Task content and credential material are not logged. Diagnostic tracing is off by default; when you enable it, it writes request metadata plus short head/tail snippets and, at most, the most recent instructions text per model, all under a size cap. See [PRIVACY.md](PRIVACY.md) for the exact contents.

**Local by default.** The layer listens on the loopback interface (`127.0.0.1`) unless you change it. If you point it at a routable interface, anyone who can reach that address can relay requests through your credentials — do not do that unless you fully understand and accept the consequences. A remote-friendly deployment is not a supported configuration.

**Writes are reviewable and reversible.** The installer backs up every file before changing it and records what it did in the install manifest. `--dry-run` shows the change list without writing anything, and `restore` / `uninstall` roll the changes back.

**This is not a security boundary.** The layer intentionally relays prompt content between providers; it does not classify, filter, or sandbox what you send. Use it only with upstream endpoints you already trust, and keep your normal provider-side data handling rules in mind.

## Testing etiquette

Only test against your own machine and your own upstream accounts. Do not probe third-party endpoints, other people's installations, or shared infrastructure while investigating an issue.
