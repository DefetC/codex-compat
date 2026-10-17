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
2. **Never log content or credentials.** Logs stay at counters, model names, event types, and timestamps. Task bodies, model output, and authentication headers must not reach disk.
3. **Keep the failure explicit.** If content cannot be delivered safely, the layer must fail loudly. Do not replace an explicit error with a silent fallback, an empty task, or a best-effort guess.
4. **Keep changes scoped.** One concern per pull request. Do not reformat untouched code, do not reorder imports, and do not add a dependency for something the standard library already does.
5. **Node.js 18 or newer.** New runtime dependencies need a prior discussion in an issue; the dependency list is intentionally tiny and every entry has to earn its place.

## Development setup

```bash
npm ci          # install the two runtime dependencies and the dev tooling
npm start       # opens the interactive menu from this checkout
```

Run the CLI from source without linking it:

```bash
node bin/codex-compat.cjs status
node bin/codex-compat.cjs doctor --dry-run
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

The default suite is offline: it must not contact a model or require an account.

```bash
npm test
```

`package.json` also exposes focused scripts for individual areas; run `npm run` to list them all. Use the focused script while iterating, then run the full check before opening a pull request.

Live checks are opt-in and are not part of the default suite:

```bash
npm run test:live     # requires a working upstream
npm run test:smoke    # cross-provider delegation smoke test
```

Live checks consume real quota on real providers, so run them only when your change deserves it, and never wire them into CI. Their outputs land in `artifacts/`, which is ignored by git — do not commit run output.

### Expectations for a rewrite-rule change

- Add or extend an offline test that feeds the old request shape in and asserts the rewritten shape out. A rule without a test will be reverted.
- Keep the request untouched when the rule does not apply. Pass-through is a feature.
- Preserve the explicit stage-C failure for ciphertext that cannot be delivered to a third-party child.
- Count the change in the existing rewrite counters so `logs` stays a usable signal.

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
