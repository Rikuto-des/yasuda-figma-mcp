# yasuda-figma-mcp

**English** | [日本語](README.ja.md)

A self-hosted, **read-only Figma MCP server** for **GitHub Copilot** (agent mode) in **GitHub Codespaces**.
It renders screenshots **locally inside your running Figma app** — exactly like right-click → **Copy as PNG** —
and **never uploads anything to a public S3 URL**.

> **Why this exists.** The official Figma MCP / REST image endpoints return rendered images on a
> **public, unauthenticated S3 URL** (`figma-alpha-api.s3...`, valid up to 30 days). Anyone with the URL can
> view your design. For security-sensitive orgs that's a non-starter. This server avoids it entirely: image
> bytes are produced by the Figma client's local `exportAsync` and streamed straight to Copilot — no S3, no
> Figma REST, no API token, **no outbound HTTP at all**.

> **Verified on real hardware (2026-06-17):** real Codespace + real Figma desktop. Copilot discovered all
> 9 tools; `get_screenshot` rendered a 6576×3952 frame and a FigJam board locally (no S3); every tool returned
> real data over a **private `gh codespace ports forward` tunnel with no public port**.

## How it works

```
 your laptop                                    your Codespace
┌────────────────────┐   private gh tunnel     ┌──────────────────────────┐
│ Figma desktop app  │   (GitHub-authed,       │ bridge  (:3055)          │
│  └ plugin ─ ws://localhost:3055 ════════════► │   ▲                      │
│                    │   no public port)       │ MCP ─stdio─► Copilot      │
└────────────────────┘                         └──────────────────────────┘
   exportAsync() renders locally → bytes never leave this path
```

- **bridge** (`src/bridge.ts`) — a token-authenticated WebSocket relay that pairs the plugin with the MCP server. Forwards messages; persists nothing.
- **mcp** (`src/mcp.ts`) — the stdio MCP server Copilot launches. Exposes the read tools; talks only to the bridge over localhost.
- **plugin** (`plugin/`) — runs in your Figma app, executes each read op against the **currently open file**, and returns data/bytes.

The plugin reaches the Codespace bridge through `gh codespace ports forward` — a **private, GitHub-authenticated tunnel to your own `localhost`**. No port is ever made public.

> 📐 **Deep dive:** the full request lifecycle, wire protocol, target resolution, and exactly how each tool works (Figma APIs, inputs, outputs) are documented in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Tools (9, all read-only, all local)

| Tool | Returns | Figma API used (all local) |
|---|---|---|
| `yfigma_get_screenshot` | PNG/JPG of selection or a node (Copy-as-PNG, inline, no S3) | `node.exportAsync` |
| `yfigma_get_metadata` | compact node tree (id/name/type/geometry) | tree traversal |
| `yfigma_get_design_context` | layout, styles, typography, components, bound variables | node props + `getMainComponentAsync` |
| `yfigma_get_variable_defs` | design-token variables + collections (per-mode values) | `variables.*` |
| `yfigma_search_design_system` | local components / styles by name | `findAllWithCriteria`, `getLocal*StylesAsync` |
| `yfigma_get_libraries` | available team-library variable collections | `teamLibrary.*` |
| `yfigma_get_figjam` | FigJam board (sticky notes, shapes, connectors, text) | tree traversal |
| `yfigma_get_document_info` | file / pages / current page / selection summary | `figma.root`, `figma.currentPage` |
| `yfigma_whoami` | current Figma user + open file | `figma.currentUser` |

If you don't pass `url`/`nodeId`, the tool operates on your **current selection** in Figma.

## Setup ⭐ recommended (npx + Codespaces secret)

No clone, no build, no per-project config. Do the **one-time setup** once; after that each project costs only **tunnel + Connect**.

### One-time setup (per developer)

**1 — Generate a token** (any random secret string; this gates the bridge channel):

```bash
openssl rand -hex 24
# → copy the output, e.g. 7f3a9c4e…  (used in steps 2 and the plugin)
```

**2 — Register it as a Codespaces user secret** *(recommended — one value for all your Codespaces, nothing to manage per project)*:

- GitHub → **Settings → Codespaces → Secrets** → **New secret**
  - **Name:** `BRIDGE_TOKEN`
  - **Value:** the token from step 1
  - **Repository access:** the repos you'll use it in (or *All repositories*)
- …or via CLI: `gh secret set BRIDGE_TOKEN --user --app codespaces` (paste the value when prompted)

Every Codespace you open now has `$BRIDGE_TOKEN` injected automatically; the MCP and embedded bridge read it with **no prompt**.

**3 — Add the MCP server to your VS Code *user* config** (once; applies to every workspace and Codespace):

- Command Palette → **"MCP: Open User Configuration"**
- paste this and save:

```json
{
  "servers": {
    "yasuda-figma-mcp": {
      "command": "npx",
      "args": ["-y", "github:Rikuto-des/yasuda-figma-mcp", "mcp"],
      "env": {
        "BRIDGE_EMBED": "1",
        "BRIDGE_PORT": "3055",
        "BRIDGE_URL": "ws://127.0.0.1:3055",
        "BRIDGE_CHANNEL": "default"
      }
    }
  }
}
```

`BRIDGE_EMBED=1` makes the MCP **host the bridge in-process**, so there's no separate bridge to start. (Local VS Code, no Codespaces secret? Add `"BRIDGE_TOKEN": "<your-token>"` to this `env` block instead.)

**4 — Give the local `gh` CLI the `codespace` scope** (needed for the tunnel; once):

```bash
gh auth refresh -h github.com -s codespace
```

**5 — Get the Figma plugin** (once) — see [Getting the plugin](#getting-the-plugin). Recommended: publish it **org-internal** so it shows up in everyone's plugin list with no manifest import.

### Per session (each project, each time)

**1 — Open the project's Codespace.** Copilot auto-launches the MCP, and the embedded bridge starts with it. The first launch in a fresh Codespace builds the package once (~30–60 s, cached afterward).

**2 — Open the private tunnel on your local machine** and leave it running:

```bash
npx -y github:Rikuto-des/yasuda-figma-mcp tunnel
# or:  gh codespace ports forward 3055:3055 -c <codespace-name>
```

**3 — Run the Figma plugin** ("Yasuda Figma MCP") → paste your token → **Connect** (status turns **Ready**).

- To reveal the token inside the Codespace terminal: `echo "$BRIDGE_TOKEN"`.

**4 — Use Copilot** (agent mode), e.g. *"screenshot my current Figma selection"*. The 9 `yfigma_*` tools are available.

That's the whole per-project cost: **tunnel + plugin Connect**. Copilot already has the tools (user config), the token (user secret), and the bridge (embedded).

## Alternative: run from a clone of this repo

1. **Open a Codespace** on this repo (Code → Codespaces → Create). The devcontainer runs `npm install && npm run build && npm run setup`, which **auto-generates your personal token** and writes `.env`.
2. **Start the bridge** in the Codespace terminal:
   ```bash
   npm run bridge        # prints: [bridge] listening on 0.0.0.0:3055
   ```
3. **Open the tunnel** on your **local** machine (needs the `gh` CLI with the `codespace` scope — run `gh auth refresh -s codespace` once):
   ```bash
   gh codespace ports forward 3055:3055 -c <your-codespace-name>
   # (with a local clone you can just run:  npm run tunnel )
   ```
4. **Run the plugin** in the **Figma desktop app** (see install options below) → paste your token → **Connect** (the token is printed by `npm run setup`; re-run it or `grep BRIDGE_TOKEN .env` to see it again).
5. **Use Copilot** (agent mode). It auto-starts the MCP server and discovers the 9 tools — no token prompt. Try: *"screenshot my current Figma selection"*.

### 2nd time onward (resume)

Codespaces auto-stop when idle. To resume: reopen the Codespace → `npm run bridge` → tunnel → run the plugin → Connect. Your token persists in `.env`.

## Getting the plugin

**Recommended — publish it once as an org-internal plugin** (Figma Organization/Enterprise):

1. In Figma desktop: **Plugins → Development → Import plugin from manifest…** → select `plugin/manifest.json` (one admin does this).
2. **Plugins → Development → Manage plugins in development →** *Yasuda Figma MCP* → **Publish**.
3. Set visibility to **"Only available to your organization"**, add a name/description, and upload an icon (use `plugin/icon.svg`, exported to a 128×128 PNG). Publish.
4. Members now run it from **Plugins → (your org's plugins)** — no manifest import needed. To ship changes, re-publish.

**Fallback — manifest import (any Figma plan):** each developer imports `plugin/manifest.json` via *Plugins → Development → Import plugin from manifest…* (requires Figma desktop; the browser app can't import dev plugins).

## Token (per user)

The token is a random secret that gates **who can join the bridge channel** (defense in depth on top of the private tunnel). Neither method needs a Copilot prompt — the MCP reads `BRIDGE_TOKEN` from the environment.

- **Codespaces user secret — recommended ✅** — one value, set once, inherited by **every** Codespace across all repos; nothing to manage per project. GitHub → **Settings → Codespaces → Secrets → `BRIDGE_TOKEN`** (or `gh secret set BRIDGE_TOKEN --user --app codespaces`). Reveal it in a Codespace with `echo "$BRIDGE_TOKEN"`.
- **`.env` — per-Codespace alternative** — used by the clone-this-repo flow. `npm run setup` generates a token and writes `.env` (gitignored); `npm run bridge` and the MCP load it via `--env-file-if-exists`. Rotate: `rm .env && npm run setup`.

Paste the same value into the Figma plugin once. If both a secret **and** a matching `.env` exist, the secret (the process environment) wins.

## Security model

- **No public port.** The bridge is reachable only through the private, GitHub-authenticated `gh` tunnel to your own `localhost`. Nothing is exposed to the internet.
- **No S3, no Figma REST, no token, no outbound HTTP.** Images come from the local `exportAsync`; all other data from the Figma plugin API. (`grep` the repo: there is no `fetch`, no `api.figma.com`, no `/v1/images`.)
- **Defense in depth.** Private tunnel (who can reach the port) + per-user `BRIDGE_TOKEN` (who can join the channel) + plugin `networkAccess` restricted to `ws://localhost:3055`. The bridge persists nothing.
- Stop the tunnel (or the Codespace) and the path disappears.

## Limitations (honest)

- **Only the file you currently have open** in Figma — the plugin can't reach files you aren't viewing (the official MCP/REST can fetch any file by key).
- **`get_design_context` returns raw design data**, not Figma's opinionated code generation — your model writes the code.
- **`get_libraries`** sees only team-library *variable* collections (plugin-API limit), not full component-library enumeration.
- **Code Connect is out of scope** (not reachable from the plugin API).

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | Generate/reuse your token (`.env` or Codespaces secret), print it |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run bridge` | Start the bridge (loads `.env` automatically) |
| `npm run tunnel` | Open the private tunnel from your local machine (auto-detects the Codespace) |
| `npm run mcp` | Run the MCP manually (Copilot normally launches it) |

## Troubleshooting

- **"Figma plugin is not connected"** — run the plugin and Connect; check the token/URL/channel match. The bridge log should show `plugin joined`.
- **"Bridge is not connected"** — `npm run bridge` running in the Codespace? `BRIDGE_TOKEN` set (`npm run setup`)?
- **Plugin won't connect** — is `gh codespace ports forward 3055:3055` running locally? Plugin URL `ws://localhost:3055`? Tunnel dropped → restart it.
- **Plugin flapping (join/leave loop)** — you have two plugin instances open (e.g. two files). Keep only one running.
- **Image not shown in Copilot** — use a vision-capable model. `yfigma_get_screenshot` also accepts `saveToFile: true` to write the PNG into the Codespace (still no S3).

## Contributing

Issues and PRs welcome. The bridge/MCP are tiny TypeScript (`src/`), the plugin is plain JS (`plugin/`). `npm run build` must pass.

## License

[MIT](LICENSE) © 2026 Rikuto Yasuda
