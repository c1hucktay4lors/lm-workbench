# Third-Party Licenses

LM Workbench includes code and content derived from the projects below. Their
original notices are reproduced or referenced here as their licenses require.
Everything else in this repository is MIT licensed (see `LICENSE`).

---

## qwen3_mcp

- Source: https://github.com/marduk191/qwen3_mcp
- Author: marduk191
- Used for: the core agent tooling (filesystem, shell, git, search, edit, web,
  tasks, scratchpad, skills, and tool-alias modules), trimmed and modified for
  LM Workbench. The `code-review` skill also comes from this project.
- License: MIT

MIT License

Copyright (c) 2025 marduk191

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


---

## Bundled skills

Skills in the `skills/` directory come from other projects and keep their
original licenses. Where a skill folder contains its own license file, that
file applies to that skill.

| Skill | Source | License |
| ----- | ------ | ------- |
| `frontend-design` | https://github.com/anthropics/skills | Apache-2.0 (`skills/frontend-design/LICENSE.txt`) |
| `mcp-builder` | https://github.com/anthropics/skills | Apache-2.0 (`skills/mcp-builder/LICENSE.txt`) |
| `shadcn-ui` | https://github.com/google-labs-code/stitch-skills | Apache-2.0 (`skills/shadcn-ui/LICENSE`) |
| `web-design-guidelines` | https://github.com/vercel-labs/agent-skills | MIT (as declared by the upstream README) |
| `react-best-practices` | https://github.com/vercel-labs/agent-skills | MIT (as declared by the upstream README and SKILL.md) |
| `code-review` | https://github.com/marduk191/qwen3_mcp | MIT (see qwen3_mcp above) |

Apache-2.0 components are used under the terms of that license; the license
text is included in each skill's folder.
