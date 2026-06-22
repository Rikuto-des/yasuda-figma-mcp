---
mode: agent
description: Design a UI screen and output it into the open Figma file with yasuda-figma-mcp yfigma tools.
---

Use the `yasuda-figma-mcp` `yfigma_*` MCP tools to design and write UI into my open Figma file.

Goal:
- Design a polished, usable UI for the request I give you.
- Build it from the file's existing local components, variants, styles, and variables.
- Output it to Figma with `yfigma_apply_ui_spec`.

Rules:
- Work in Figma Design mode. If Figma is in Dev Mode or the plugin is not connected, tell me exactly what to fix.
- Never invent `componentId`, variable IDs, prop keys, or variant values.
- Never send executable code to the plugin. Send only declarative UI spec JSON.
- Never use raw rectangles or absolute coordinates for product UI. Compose auto-layout frames and existing component instances.
- Prefer token references from `yfigma_get_variable_defs` for gap, padding, and fill.
- Use `yfigma_apply_ui_spec` as the only write operation.
- For mobile UI, include a safe-area-aware header, primary metric, secondary metrics, one clear next action, detailed content, and bottom navigation when appropriate.
- Avoid placeholder-looking artifacts: single-letter avatar boxes, meaningless color slabs, unlabeled progress blocks, and generic square primitives.
- Before applying, self-review visual hierarchy, spacing rhythm, tap affordances, selected states, text fit, and semantic color.

Loop:
1. Observe: call `yfigma_get_document_info`, `yfigma_list_component_sets`, and `yfigma_get_variable_defs`. If component results are truncated, query more narrowly.
2. Plan: choose real components and variables, then draft a `version: 1` UI spec with one `root`.
3. Self-review: make sure the UI feels like an operable app screen, not a static data sheet or placeholder mock.
4. Validate: call `yfigma_apply_ui_spec` with `validateOnly: true`.
5. Repair: fix every validation error and replace avoidable literal spacing/color warnings with variables.
6. Apply: call `yfigma_apply_ui_spec` without `validateOnly`.
7. Confirm: call `yfigma_get_screenshot` for the returned root id and iterate if the visual result is incomplete or wrong.

Target mode:
- Use `target.mode: "create"` unless I ask you to add into or update my current selection.
- Use `"into-selection"` only when I have selected an auto-layout parent frame.
- Use `"update-selection"` only when I have selected the node to update and the root type matches it.

When done, report the Figma root name/id, what you created, and any remaining warnings.
