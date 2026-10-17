# Third-Party Notices

`codex-compat` is distributed under the MIT License (see [LICENSE](LICENSE)).

This file lists the third-party projects and runtime dependencies that the project references, depends on, or derives content from, together with their license texts and copyright lines.

## 1. Design references

The cross-provider subagent delivery design used by this project references the following open-source projects. Only their published design ideas were used as a reference; no source code was copied into this repository.

### 1.1 BigStrongSun/ccswitchmulti

- License: MIT
- Copyright (c) 2025 Jason Young

```text
MIT License

Copyright (c) 2025 Jason Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.2 farion1231/cc-switch

- License: MIT
- Copyright (c) 2025 Jason Young

```text
MIT License

Copyright (c) 2025 Jason Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. Runtime dependencies

`codex-compat` ships with the dependencies below. Both are used unchanged at runtime, and neither is modified by this project.

### 2.1 @iarna/toml

- Version: 2.2.5
- License: ISC
- Copyright (c) 2016, Rebecca Turner <me@re-becca.org>

```text
Copyright (c) 2016, Rebecca Turner <me@re-becca.org>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### 2.2 fzstd

- Version: 0.1.1
- License: MIT
- Copyright (c) 2020 Arjun Barrett

```text
MIT License

Copyright (c) 2020 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. Content and documentation attribution

### 3.1 Codex system / developer instructions

`config/prompts/deepseek-codex.md` reproduces a substantial amount of the agent instructions shipped with the Codex CLI: its section structure (`Personality`, `Working with the user`, `Formatting rules`, `Destructive Actions`, `Using skills`, `Operating constraints`, …) corresponds one-to-one to that text, and many sentences are verbatim. Those parts were **not** authored by this project and this project claims no rights over them; they are included so that a third-party model acting as a Codex subagent follows the same behaviour contract as a first-party agent. The rightsholder for that material is OpenAI.

### 3.2 DeepSeek Codex integration guidance

The fused DeepSeek prompt template in `config/prompts/deepseek-codex.md` is derived in part from the Codex integration guidance published by DeepSeek:

- <https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/>

### 3.3 程小帮

The same template includes constraint and role instructions authored by **程小帮**: the sections on instruction priority, execution responsibility (staying with a multi-step task to the end, not stopping at a plan or a promise of work) and engineering judgment. The project thanks 程小帮 by name for these contributions. No tooling, memory layer, or runtime path from that work is bundled with this project.

### 3.4 What this attribution does and does not mean

- It is a credit statement for the sources listed above. **It is not a license.** Crediting an author does not by itself grant the right to redistribute their text.
- **No permission claim is made for any of the three sources above.** If a rightsholder grants a license or asks for specific conditions, that will be recorded in this section before any further release.
- The project's own MIT grant (see [LICENSE](LICENSE)) covers the code in this repository. It **cannot** and does not extend to the third-party text inside `config/prompts/deepseek-codex.md`.

### 3.5 License scope of `config/prompts/deepseek-codex.md`

`config/prompts/deepseek-codex.md` is a **fused document**, not original work of this project. It is therefore excluded from the MIT grant offered for this project as a whole. Anyone redistributing or reusing that file (in whole or in part) is responsible for clearing the three sources above themselves; keeping this notice is good practice but **does not substitute** for your own clearance.

If a rightsholder objects to its material being included, the maintainers will replace or remove the affected parts (for example by switching to a prompt supplied by the user at runtime) as soon as they are notified through the repository's issue tracker.

### 3.6 Product names

OpenAI, Codex, DeepSeek, and CC Switch are names of their respective owners. They are used in this project only to describe interoperability. `codex-compat` is an unofficial project and is not affiliated with, endorsed by, or supported by any of them.
