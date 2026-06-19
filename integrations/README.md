# Agent integrations — teach your AI to use yasuda-figma-mcp well

Drop-in prompt so **GitHub Copilot** uses the `yfigma_*` tools effectively — both the
**design→code** workflow (read) and the **code→design** workflow (generate UI into Figma from
your existing components, write), reusing design tokens and components with correct node targeting.

| Agent | File here | Copy it to |
|---|---|---|
| **GitHub Copilot** | [`copilot/yfigma.prompt.md`](copilot/yfigma.prompt.md) | `.github/prompts/yfigma.prompt.md` — then run **`/yfigma`** in Copilot Chat (agent mode) |

**Prerequisite:** the `yasuda-figma-mcp` MCP server is configured in that agent and the
Figma plugin is connected — see the main [README](../README.md). These files only teach the
agent *how to use* the tools; they don't set up the connection.
