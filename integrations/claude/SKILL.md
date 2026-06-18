---
name: yfigma
description: Use when implementing, matching, or extracting anything from a Figma design — e.g. the user shares a figma.com URL, says "implement this frame / screen / component", or asks for exact spacing, colors, typography, or design tokens. Reads the user's currently-open Figma file via the yasuda-figma-mcp read-only tools (yfigma_*).
---

# Figma → code with yasuda-figma-mcp

The `yfigma_*` tools are **read-only** and read the user's **currently open Figma file
locally** (no cloud upload). Use them instead of guessing pixel values or colors.

## When to use
- The user shares a Figma URL, references "this frame/screen/component", or asks to
  implement / match / reproduce a design.
- You need real spacing, colors, typography, component structure, or design tokens.

## Targeting a node
- Pass `url` (a figma.com link containing `?node-id=…`) **or** `nodeId` (e.g. `"12:345"`).
- Pass **neither** to act on the user's **current selection** in Figma.
- The target must be in the file the user **currently has open** — the plugin only sees the
  open document. If a tool returns "Node not found", ask the user to open that file or select
  the node; don't fabricate values.

## Recommended workflow (design → code)
1. **`yfigma_get_screenshot`** — see the design (visual ground truth). Pass the url/nodeId, or use the selection.
2. **`yfigma_get_metadata`** — cheap node tree to understand structure and collect child node ids (`depth` to go deeper).
3. **`yfigma_get_design_context`** — the structured truth to implement from: auto-layout, padding/gap, fills/strokes/effects, corner radius, typography, component info, and **bound variables**. This is **raw data — you write the code.**
4. **`yfigma_get_variable_defs`** — design tokens with per-mode values. **Map fills/spacing to these token names, don't hardcode** hex/px.
5. **`yfigma_search_design_system`** / **`yfigma_get_libraries`** — find existing components/styles/variables to **reuse** instead of reinventing.
6. After implementing, call **`yfigma_get_screenshot`** again and compare against your output.

## Translate design_context → code
- `layout.mode HORIZONTAL/VERTICAL` → flexbox / stack; `itemSpacing` → `gap`; `padding{…}` → padding.
- `fills` (SOLID hex) → color **token** if one is bound (`boundVariables`), else the hex.
- `text` → font family/size/weight/line-height/letter-spacing/alignment.
- `cornerRadius`, `effects` (shadows/blur), `strokes` → border-radius / box-shadow / border.
- `component` (instance) → reuse the mapped code component; `componentProperties` → props.
- `figma.mixed` values appear as `"mixed"` — inspect children or ask which variant is intended.

## Do
- **Search the design system first** and reuse components/variables/tokens.
- Verify your result with a screenshot.
- Ask the user to open/select the right node when a target isn't found.

## Don't
- Don't expect finished code from Figma — `design_context` is raw data.
- Don't hardcode a value when a variable/token exists.
- Don't try to read a file the user doesn't have open (only the open file is visible).
- These tools are read-only — you can't modify Figma.

## The 9 tools (read-only)
| Tool | Returns | Key args |
|---|---|---|
| `yfigma_get_screenshot` | PNG/JPG of node/selection (inline) | `url`/`nodeId`, `scale`, `format`, `saveToFile` |
| `yfigma_get_metadata` | compact node tree (id/type/geometry) | `url`/`nodeId`, `depth` |
| `yfigma_get_design_context` | layout/styles/typography/variables | `url`/`nodeId`, `depth` |
| `yfigma_get_variable_defs` | variables + collections (per mode) | `url`/`nodeId`, `scope: target\|all` |
| `yfigma_search_design_system` | components/styles by name | `query`, `kinds`, `allPages`, `limit` |
| `yfigma_get_libraries` | team-library variable collections | — |
| `yfigma_get_figjam` | FigJam board content | `url`/`nodeId` |
| `yfigma_get_document_info` | file / pages / selection | — |
| `yfigma_whoami` | current user + open file | — |
