---
name: yfigma-design-to-figma
description: Design polished UI screens and output them into an open Figma file through yasuda-figma-mcp yfigma tools. Use when the user asks Codex to create, generate, design, update, or write an app screen, modal, panel, dashboard, form, landing section, or composed UI into Figma using this plugin MCP, especially when the task mentions Figma output, UI spec, design system components, variables, or yfigma_apply_ui_spec.
---

# YFigma Design to Figma

## Overview

Use this skill to turn a product/UI request into a declarative UI spec and apply it to the user's open Figma file with `yasuda-figma-mcp`. The plugin must receive data, not executable code: observe real local components and variables, plan from those IDs, validate with `validateOnly`, apply only after validation passes, then inspect the screenshot.

## Required Constraints

- Use `yfigma_apply_ui_spec` as the only write tool.
- Use Figma Design mode. If the tool reports Dev Mode or read-only access, ask the user to switch to Design mode.
- Use existing local components and component sets from `yfigma_list_component_sets`; never invent `componentId` values.
- Use variable IDs from `yfigma_get_variable_defs`; prefer `{ "var": "VariableID:...", "name": "..." }` for spacing, padding, and fills.
- Build with auto-layout frames. Do not use raw rectangles, absolute positioning, arbitrary drawing ops, or generated JavaScript.
- Run `yfigma_apply_ui_spec` with `validateOnly: true` before any write. Fix every error before applying.
- After applying, call `yfigma_get_screenshot` on the returned root id and compare the result against the intended UI.
- Keep design data local. Do not route Figma data through public URLs, external APIs, or remote image hosting.

## Workflow

1. Clarify the target only if required:
   - `create`: make a new screen at the viewport center.
   - `into-selection`: append into the selected auto-layout frame.
   - `update-selection`: update the selected frame, instance, or text node.
2. Observe the open file:
   - Call `yfigma_get_document_info` to confirm file, page, selection, and editor context.
   - Call `yfigma_list_component_sets` with focused `query` terms if the result is truncated.
   - Call `yfigma_get_variable_defs` for token IDs.
   - Use `yfigma_get_screenshot` when visual context or selection state matters.
3. Design the UI:
   - Choose components whose names, props, and variants fit the user request.
   - Use text nodes only for content that the design system cannot express as a component prop.
   - Compose layouts as nested `frame` nodes with `layout`, `gap`, `padding`, `width`, and `height`.
   - Favor dense, usable product UI over decorative marketing layouts unless the user explicitly asks for a landing/brand page.
4. Build a UI spec:
   - Use `version: 1`.
   - Include one `root` node.
   - Set `target.mode` explicitly when not creating a new screen.
   - For instances, pass `componentId` and friendly `props` names from `yfigma_list_component_sets`.
5. Validate and repair:
   - Call `yfigma_apply_ui_spec` with `validateOnly: true`.
   - Treat warnings about literal color/spacing as design debt; replace with variables when possible.
   - Repeat until `valid: true`.
6. Apply and confirm:
   - Call `yfigma_apply_ui_spec` without `validateOnly`.
   - Screenshot the returned root id.
   - If the screenshot reveals missing content, broken hierarchy, bad sizing, or wrong variants, update the spec and re-apply.

## Spec Help

Read `references/ui-spec-patterns.md` before writing a non-trivial screen, when validation fails, or when using `into-selection`, `update-selection`, `INSTANCE_SWAP`, token binding, or nested frames.

If working inside the `yasuda-figma-mcp` repository, `docs/UI_SPEC.ja.md` is the canonical schema reference and `docs/IDE_TO_FIGMA.ja.md` explains the security model. Prefer those docs when exact behavior matters.

## Response Style

Tell the user what was created or updated in Figma, mention the root node name/id returned by the tool, and summarize any validation warnings that remain. If you cannot apply the spec, state the exact blocker and the Figma-side action needed.
