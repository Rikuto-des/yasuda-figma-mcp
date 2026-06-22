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

## Validation Repair Checklist

- Missing component: rerun `yfigma_list_component_sets` with a narrower query and replace the `componentId`.
- Invalid prop: use the exact prop name and allowed value shown by `yfigma_list_component_sets`.
- Missing variable: rerun `yfigma_get_variable_defs`; replace literal spacing/fill with a real variable id when possible.
- Root sizing error: replace root `"FILL"` with a number or `"HUG"` for `create`.
- Selection error: ask the user to select the target frame/node and rerun validation.
