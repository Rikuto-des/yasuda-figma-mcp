# UI Spec Patterns for yasuda-figma-mcp

Use these patterns when planning `yfigma_apply_ui_spec` payloads.

## Minimal Envelope

```json
{
  "version": 1,
  "target": { "mode": "create" },
  "root": {
    "type": "frame",
    "name": "Screen Name",
    "layout": "VERTICAL",
    "gap": { "var": "VariableID:1:5", "name": "spacing/md" },
    "padding": { "var": "VariableID:1:9", "name": "spacing/xl" },
    "width": 390,
    "height": "HUG",
    "children": []
  }
}
```

For validation-only, add `"validateOnly": true` at the top level.

## Node Types

- `frame`: the only container type. Use `layout: "VERTICAL"` or `"HORIZONTAL"`, auto-layout spacing, padding, optional fill, and `children`.
- `instance`: an existing local component or component set. Required: `componentId`. Optional: `name`, `props`.
- `text`: raw text fallback. Required: `characters`. Prefer a text style when one exists.

## Frame Fields

Use these fields only:

- `type`: `"frame"`
- `name`: string
- `layout`: `"VERTICAL"` or `"HORIZONTAL"`
- `gap`: number or token reference
- `padding`: number, side map, or token reference
- `primaryAxisAlign`: `"MIN"`, `"CENTER"`, `"MAX"`, or `"SPACE_BETWEEN"`
- `counterAxisAlign`: `"MIN"`, `"CENTER"`, `"MAX"`, or `"BASELINE"`
- `width`, `height`: `"HUG"`, `"FILL"`, or number. Do not use `"FILL"` on a root created without a parent.
- `fill`: `"#RRGGBB"`, `"#RRGGBBAA"`, `"NONE"`, or token reference
- `children`: array of nodes

## Instance Fields

```json
{
  "type": "instance",
  "name": "Primary CTA",
  "componentId": "12:34",
  "props": {
    "Variant": "Primary",
    "Size": "Large",
    "Label": "Continue",
    "Disabled": false
  }
}
```

Rules:

- `componentId` must come from `yfigma_list_component_sets`.
- Friendly prop names are allowed. If validation reports ambiguity, use the exact key from `yfigma_list_component_sets`.
- `INSTANCE_SWAP` prop values must be a local component or component-set `componentId`.
- Instances cannot have `children`.

## Text Fields

```json
{
  "type": "text",
  "name": "Headline",
  "characters": "Create your workspace",
  "textStyleId": "S:heading",
  "fill": { "var": "VariableID:2:4", "name": "color/text/primary" }
}
```

Use `fontSize` only as a fallback when a text style is unavailable.

## Token References

Resolve tokens during planning by reading `yfigma_get_variable_defs`. The wire format must use the Figma variable id:

```json
{ "var": "VariableID:1:5", "name": "spacing/md" }
```

The `name` is only a label for humans and error messages; resolution uses `var`.

## Target Modes

- `create`: default. Creates a new root at the viewport center.
- `into-selection`: appends the root into the selected auto-layout frame. Confirm the user selected the intended parent first.
- `update-selection`: updates the selected node. Types must match the spec root. For frames, omitting `children` preserves existing children; passing `children` performs a name-or-position based child diff.

## Mobile Dashboard Pattern

For prompts like "make a mobile dashboard", plan the screen as a product surface, not a static report:

- Root: 375-430 px wide, vertical, white or token background, safe-area top/bottom padding, section gap 20-28.
- Header: page title, date/context, profile/settings action. Do not use a random letter in a colored square unless the user explicitly asked for an initial avatar.
- Primary summary: one card or component group with the main value, target/progress, and a clear visual indicator. Prefer a real progress component, ring, or labeled bar if available; otherwise use restrained auto-layout text and bars.
- Secondary metrics: 2-4 compact metric chips/cards. Keep labels and values aligned; avoid isolated decorative color panels.
- Insight/action row: include one practical action such as "食事を追加", "水分を記録", "今日の提案", or a plus button when the app would need it.
- Detailed section: recent records, history, or chart preview. Rows should have stable height, left content, right value, and optional status/icon.
- Bottom navigation: use actual nav/tab components when available. Keep labels short, selected state obvious, and icons semantically matched.

For a calorie dashboard, a stronger information architecture is usually:

1. Header with "カロリー管理", date, profile/settings.
2. Hero summary with consumed kcal, goal, remaining kcal, and progress percentage.
3. Macro balance with protein/carbs/fat bars or chips.
4. Quick action to add a meal.
5. Meal log cards for breakfast/lunch/dinner.
6. Bottom nav: Home, Add, History, Settings.

Quality checks before applying:

- The screen should look like an app a user can operate, not only a spreadsheet of numbers.
- Accent colors should encode meaning: blue for primary/selected, warm for carbs/attention, red only for over/critical/fat if that convention is intentional.
- Card backgrounds should be subtle and consistent; avoid a pale outer slab containing a white inner slab unless the design system uses that pattern.
- Text should fit Japanese labels without clipping and should not collide with right-aligned values.
- Empty space below content should be intentional; add content density or reduce frame height if the screenshot feels unfinished.

## Validation Repair Checklist

- Missing component: rerun `yfigma_list_component_sets` with a narrower query and replace the `componentId`.
- Invalid prop: use the exact prop name and allowed value shown by `yfigma_list_component_sets`.
- Missing variable: rerun `yfigma_get_variable_defs`; replace literal spacing/fill with a real variable id when possible.
- Root sizing error: replace root `"FILL"` with a number or `"HUG"` for `create`.
- Selection error: ask the user to select the target frame/node and rerun validation.
