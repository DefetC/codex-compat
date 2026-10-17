# Privacy

## Summary

`codex-compat` has **no telemetry**. It does not contain analytics, usage reporting, crash reporting, advertising identifiers, or update pings, and it never contacts any server of its own — there is no server of its own. Everything it does happens on your machine.

The only network traffic it produces is the traffic you asked for:

1. Codex connects to the layer on the loopback interface (default `127.0.0.1:15731`).
2. The layer forwards those requests to the upstream you configured (a local CC Switch proxy by default, or your own OpenAI-compatible endpoint).

Nothing else is sent anywhere. `selftest` and `doctor` make no model calls: their runtime checks only talk to the local health endpoint and to the upstream address you configured.

## What is stored, and where

All runtime data stays inside the runtime home (`~/.codex-compat` by default, or `CODEX_COMPAT_HOME` / `--home` if you change it).

| Data | Location | Contents |
| --- | --- | --- |
| Settings | `~/.codex-compat/config.json` | Addresses, feature switches, service and reclaim policy. No credentials |
| Logs | `~/.codex-compat/logs/` | Event types, counters, model names, timestamps, and error text for failures |
| Diagnostic trace | `~/.codex-compat/logs/` | Off by default. See the section below |
| Backups | `~/.codex-compat/backups/` | Copies of the files taken immediately before a write, so changes can be rolled back |
| Install manifest | `~/.codex-compat/install-manifest.json` | Which files the installer changed, and content hashes used to detect external edits |
| Locks and flags | `~/.codex-compat/run/` | Single-instance lock and runtime flags |
| Diagnostic bundle | `~/.codex-compat/diagnostics/` | Created only on demand: status, doctor report, configuration, and recent logs, sanitized before writing |

## What is never stored

- Credentials: API keys, tokens, cookies, and authentication headers are forwarded in memory and are never written to disk, never logged, and never included in a diagnostic bundle.
- Task bodies and message content: the normal logging path records counts and model names only. It does not record what you asked a subagent to do, and it does not record model output.
- Ciphertext: the layer never decrypts official ciphertext and does not persist it beyond forwarding the request.

## Logging policy

Normal logs answer "did the rewrite happen, and how often", not "what was said":

- Counters per event: requests seen, requests rewritten, markers stripped, plaintext containers projected, orphan tool outputs normalized, requests rejected, errors.
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

The "generate a diagnostic bundle" menu entry writes a folder under `~/.codex-compat/diagnostics/<timestamp>/` containing the status report, the doctor report, the configuration (without the runtime home field), and the last few log files trimmed to their most recent lines. Before writing, the text passes through a sanitizer that redacts credential-shaped values (for example `authorization`, `api key`, `secret`, `password`, `token`), `sk-…`-style keys, and ciphertext blocks. The bundle is not uploaded anywhere by this tool. Treat it as a starting point rather than a guarantee: review it before attaching it to a report.

## Data removal

`codex-compat restore` rolls the Codex configuration back to what it was before installation, and `codex-compat uninstall` additionally stops the service and removes the autostart and guard registrations. Neither one deletes your runtime directory: add `--purge` to `uninstall` when you also want `~/.codex-compat` removed. Because the tool keeps no remote copy of anything, deleting the runtime home and any trace, backup, or diagnostic files you produced removes everything this tool has ever stored.

## Changes

If this policy changes, the change ships with the source and is described in [CHANGELOG.md](CHANGELOG.md).

For a suspected privacy or security issue, use the private reporting channel described in [SECURITY.md](SECURITY.md).
