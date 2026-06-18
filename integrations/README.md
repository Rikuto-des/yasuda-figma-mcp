# Agent integrations — teach your AI to use yasuda-figma-mcp well

Drop-in instruction/skill files so **Claude Code**, **Codex CLI**, and **GitHub Copilot**
use the `yfigma_*` tools effectively — the design→code workflow, reusing design tokens
and components, and correct node targeting.

| Agent | File here | Copy it to |
|---|---|---|
| **Claude Code** | [`claude/SKILL.md`](claude/SKILL.md) | `.claude/skills/yfigma/SKILL.md` (project) — or `~/.claude/skills/yfigma/SKILL.md` (personal, all projects) |
| **Codex CLI** | [`codex/AGENTS.md`](codex/AGENTS.md) | `AGENTS.md` at your repo root (or merge the section into an existing one) |
| **GitHub Copilot** | [`copilot/yfigma.prompt.md`](copilot/yfigma.prompt.md) | `.github/prompts/yfigma.prompt.md` — then run **`/yfigma`** in Copilot Chat (agent mode) |

All three carry the **same core guidance**, formatted per agent.

**Prerequisite:** the `yasuda-figma-mcp` MCP server is configured in that agent and the
Figma plugin is connected — see the main [README](../README.md). These files only teach the
agent *how to use* the tools; they don't set up the connection.
