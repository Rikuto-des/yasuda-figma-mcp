---
mode: agent
description: Implement or extract from a Figma design using the yasuda-figma-mcp (yfigma_*) tools — local render, no public S3.
---

Work from the Figma design I'm referring to, using the **read-only `yfigma_*` MCP tools**
(they read my currently-open Figma file locally). Don't guess spacing, colors, or typography.

**Target:** if I gave a figma.com URL or a `nodeId`, use it; otherwise use my **current
selection** in Figma. The node must be in the file I have open — if a tool returns
"Node not found", ask me to open that file or select the node. Never fabricate values.

**Do this:**
1. `yfigma_get_screenshot` — see the design (visual ground truth).
2. `yfigma_get_metadata` — understand the structure and get child node ids (`depth` to go deeper).
3. `yfigma_get_design_context` — the structured truth: auto-layout, padding/gap, fills,
   strokes, effects, corner radius, typography, component info, and bound variables.
   **This is raw data — you write the code.**
4. `yfigma_get_variable_defs` — design tokens (per-mode values). **Map fills and spacing to
   these token names; don't hardcode** hex/px.
5. `yfigma_search_design_system` / `yfigma_get_libraries` — find existing components, styles,
   and variables and **reuse** them instead of reinventing.
6. After implementing, call `yfigma_get_screenshot` again and compare to your output; iterate
   until it matches.

**Map `design_context` → code:** `layout HORIZONTAL/VERTICAL` → flex/stack; `itemSpacing` →
`gap`; `padding{…}` → padding; `fills` → a color **token** if `boundVariables` names one, else
the hex; `text` → font family / size / weight / line-height / letter-spacing / alignment;
`cornerRadius` / `effects` / `strokes` → border-radius / box-shadow / border; `component`
instances → the mapped code component (`componentProperties` → props). A `"mixed"` value means
the property varies across children — inspect them or ask me.

Follow our existing code conventions and design-system naming. These tools are **read-only** —
don't try to modify Figma.
