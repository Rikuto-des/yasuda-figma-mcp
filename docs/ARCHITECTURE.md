# Architecture & how each tool works

[English](ARCHITECTURE.md) | [日本語](ARCHITECTURE.ja.md)

This document explains the end-to-end data flow, the wire protocol, and the exact
behaviour of each of the 9 tools (which Figma API it calls, its inputs, and what
it returns).

## Components

| Process | File | Role | Network |
|---|---|---|---|
| **MCP server** | `src/mcp.ts` | stdio server Copilot launches; exposes the 9 tools; correlates requests/responses | connects to the bridge over `ws://127.0.0.1:3055` |
| **Bridge** | `src/bridge-core.ts` (`bridge.ts` / embedded in `mcp.ts`) | token-authenticated WebSocket relay; pairs one `mcp` + one `plugin` per channel | WS server on `:3055` |
| **Plugin — UI iframe** | `plugin/ui.html` | holds the WebSocket; base64; relays to/from the main thread | WebSocket (Figma main thread has **no** network) |
| **Plugin — main thread** | `plugin/code.js` | runs the read ops against the **open document** via the Figma plugin API | none |

## Request lifecycle

Every tool call is one round trip along the same path:

```
Copilot ──tools/call──► MCP (src/mcp.ts)
                          │  resolve target + defaults
                          ▼
                        bridge.request({op, params})           ws://127.0.0.1:3055
                          │  {type:"request", requestId, op, params}
                          ▼
                        BRIDGE (relay)  ──same channel──►  PLUGIN UI (ui.html)
                                                              │ postMessage
                                                              ▼
                                                            PLUGIN MAIN (code.js)
                                                              │ handleRequest(op, params)
                                                              │ → Figma plugin API on the open doc
                                                              ▼
                                                            {type:"response", requestId, ok, result}
                          ◄───────────────── relay ──────────┘
                        BridgeClient matches requestId → resolves the promise
                          │  format: image → inline image block; else → pretty JSON
                          ▼
Copilot ◄──CallToolResult──
```

1. Copilot sends `tools/call` (JSON-RPC over stdio) to the MCP server.
2. The tool handler resolves the **target** (see below) and fills defaults, then calls `bridge.request(op, params)`.
3. `BridgeClient` sends `{type:"request", requestId, op, params}` to the bridge.
4. The bridge relays it verbatim to the plugin in the same channel. **No plugin connected → it replies immediately** with `{ok:false, error:"Figma plugin is not connected…"}`.
5. The plugin **UI iframe** receives it and `postMessage`s it to the **main thread**.
6. `code.js` `handleRequest(op, params)` dispatches to the op handler, which calls the Figma plugin API against the currently open document.
7. The handler's result is posted back to the UI, which sends `{type:"response", requestId, ok, result}` over the WebSocket.
8. The bridge relays it to the MCP; `BridgeClient` matches `requestId`, resolves the pending promise.
9. The MCP formats the result — **screenshot → inline `image` content block(s)**; everything else → pretty-printed JSON text — and returns it to Copilot.

### Why the plugin is split into two threads

Figma's plugin **main thread** (`code.js`) can read the document but has **no network access**. The **UI iframe** (`ui.html`) has WebSocket/`fetch`/`btoa` but no document API. So the WebSocket lives in the UI, the Figma API calls live in the main thread, and they exchange messages via `postMessage`. Image bytes are base64-encoded with `figma.base64Encode` in the main thread, then sent over the socket by the UI.

## Wire protocol (over the bridge)

Plain JSON text frames. The bridge authenticates with the shared token, pairs an `mcp` and a `plugin` in the same channel, and forwards everything else verbatim (it never inspects payloads).

| Message | Direction | Shape |
|---|---|---|
| `join` | client → bridge | `{type:"join", role:"mcp"\|"plugin", channel, token}` |
| `request` | mcp → plugin | `{type:"request", requestId, op, params}` |
| `response` | plugin → mcp | `{type:"response", requestId, ok, result?, error?}` |
| `system` | bridge → client | `{type:"system", event:"joined"\|"peer_connected"\|"peer_disconnected"\|"error", message?}` |

The MCP **tool name** (`yfigma_*`) is client-facing; the **op** (`screenshot`, `metadata`, …) is the internal verb the plugin dispatches on. They are intentionally decoupled.

## Target resolution

Most tools act on a node or the current selection. The MCP builds a `target` from the args:

- `nodeId` given, or parsed from a Figma `url` (`?node-id=1-23` → `1:23`) → `{kind:"node", nodeId}` → plugin uses `figma.getNodeByIdAsync(nodeId)`.
- Otherwise → `{kind:"selection"}` → plugin uses `figma.currentPage.selection` (errors if nothing is selected).

The plugin can only see the **currently open file** — that's the core trade-off vs the REST-based official MCP.

## The 9 tools

> Inputs `url?` / `nodeId?` are the target shorthand above. Output is JSON unless noted.

### `yfigma_get_screenshot` — op `screenshot`
- **Inputs:** `url?`, `nodeId?`, `scale` (1–4, default 2), `format` (`PNG`|`JPG`, default PNG), `saveToFile?`.
- **Does:** for each target node that supports it, `node.exportAsync({ format, constraint: { type: "SCALE", value: scale } })` → `Uint8Array` → `figma.base64Encode`. This is the exact engine behind right-click → **Copy as PNG**.
- **Returns:** one **inline `image` content block** per node (+ a text line `name (id) — WxH`). With `saveToFile:true`, also writes the PNG into `FIGMA_EXPORT_DIR` (default `.figma-exports/`, gitignored) and reports the path.
- **Notes:** no S3, no URL — raw bytes only. Multiple selected nodes → multiple images.

### `yfigma_get_metadata` — op `metadata`
- **Inputs:** `url?`, `nodeId?`, `depth?` (0–20, default 6).
- **Does:** recursive lightweight walk (`metaNode`): `id, name, type, visible, x, y, width, height`, and `children[]` down to `depth` (deeper than that → `childCount`).
- **Returns:** `{ count, nodes:[…] }`.
- **Use first** to discover node ids cheaply before requesting heavier context.

### `yfigma_get_design_context` — op `design_context`
- **Inputs:** `url?`, `nodeId?`, `depth?` (0–12, default 4).
- **Does:** deep serialization (`ctxNode`): bounds/size, opacity, rotation, constraints, **auto-layout** (`layoutMode`, alignment, sizing mode, wrap, `itemSpacing`, padding), `layoutSizing`, **fills** (hex), **strokes** (+weight/align), **effects** (shadows/blur), corner radius, **text** (characters, font, size, line-height, alignment, case, decoration), **component** (instance → main component key/name + `componentProperties`; component/-set → key + description), **bound variables** (resolved to names), and children.
- **Returns:** `{ count, nodes:[…] }`.
- **Notes:** raw design data for the model to turn into code — **not** Figma's own code output. `figma.mixed` values are reported as `"mixed"`.

### `yfigma_get_variable_defs` — op `variable_defs`
- **Inputs:** `url?`, `nodeId?`, `scope` (`target`|`all`, default `target`).
- **Does:** `all` → `figma.variables.getLocalVariablesAsync()` (every local variable) + their collections. `target` → walk the node subtree collecting `boundVariables` ids, resolve each via `getVariableByIdAsync`. Each variable: `{ id, name, key, resolvedType, collectionId, valuesByMode, description }`. Collections: `{ id, name, modes, defaultModeId }`.
- **Returns:** `{ scope, count, variables, collections }`.

### `yfigma_search_design_system` — op `search_design_system`
- **Inputs:** `query` (substring), `kinds?` (`["component","style"]`), `allPages?` (default false), `limit?` (1–200, default 50).
- **Does:** components via `root.findAllWithCriteria({types:["COMPONENT","COMPONENT_SET"]})` filtered by name; styles via `getLocalPaintStylesAsync` / `getLocalTextStylesAsync` / `getLocalEffectStylesAsync` filtered by name. Each hit: `{ kind, type|styleType, id, name, key }`.
- **Returns:** `{ query, count, results }`.
- **Notes:** **local** components/styles in the open file only — not remote published-library components.

### `yfigma_get_libraries` — op `libraries`
- **Inputs:** none.
- **Does:** `figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()` → `{ key, name, libraryName }`.
- **Returns:** `{ note, libraryVariableCollections }`.
- **Notes:** requires manifest `permissions: ["teamlibrary"]`. The plugin API only exposes team-library **variable** collections (not full component-library enumeration).

### `yfigma_get_figjam` — op `figjam`
- **Inputs:** `url?`, `nodeId?`.
- **Does:** target node → that; else the current selection; else the whole current page. `figjamNode`: `{ id, name, type, text }` for `STICKY` / `SHAPE_WITH_TEXT` / `TEXT`, plus geometry, `connectorStart`/`connectorEnd` for `CONNECTOR`, and `children` recursively.
- **Returns:** `{ page, count, nodes }`.

### `yfigma_get_document_info` — op `document_info`
- **Inputs:** none.
- **Does:** reads `figma.root` / `figma.currentPage`.
- **Returns:** `{ fileName, editorType, currentPage:{id,name}, pages:[{id,name,childCount}], selection:[{id,name,type}] }`.

### `yfigma_whoami` — op `whoami`
- **Inputs:** none.
- **Does:** reads `figma.currentUser`.
- **Returns:** `{ user:{id,name,photoUrl,color}, editorType, fileName, currentPage }`.
- **Notes:** requires manifest `permissions: ["currentuser"]`.

## Error handling & timeouts

- A plugin handler that throws → `{ok:false, error}` → the MCP returns an `isError` text result (e.g. "Nothing is selected…", "Node not found…").
- **No plugin connected** → the bridge fast-fails the request (no waiting).
- **Timeout** → if the plugin doesn't answer within `REQUEST_TIMEOUT_MS` (default 30 000 ms) the MCP rejects with a timeout error.
- The `BridgeClient` auto-reconnects to the bridge; the plugin UI auto-reconnects every 2 s if the socket drops.

## Embedded vs standalone bridge

- **Standalone** (`npm run bridge`): the bridge is its own process; survives MCP restarts. Used by the clone-this-repo flow.
- **Embedded** (`BRIDGE_EMBED=1`): `mcp.ts` calls `startBridgeServer()` in-process, so Copilot launching the MCP also starts the bridge — no separate step. Used by the npx multi-project flow. The MCP's own client then connects to the in-process bridge over localhost, and the plugin reaches it through the tunnel exactly the same way.
