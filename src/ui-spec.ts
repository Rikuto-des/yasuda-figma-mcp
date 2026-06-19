/**
 * UI spec — the declarative contract for the IDE -> Figma write path.
 *
 * The IDE agent plans a screen as DATA (this spec), never as code. The plugin
 * applies it deterministically with a fixed op vocabulary. This module is the
 * SINGLE SOURCE OF TRUTH for the spec's *structural* rules: the MCP server runs
 * `validateUiSpec` to reject malformed specs early, and the plugin mirrors the
 * same rules (re-implemented in plain JS) before touching the document.
 *
 * Two-layer validation:
 *   1. Structural (here)      — shape, enums, finite numbers, no unknown fields.
 *                               Pure, dependency-free, never throws, never reads Figma.
 *   2. Semantic (plugin only) — component ids resolve to LOCAL components, prop
 *                               keys/values match componentPropertyDefinitions,
 *                               token ids exist and types match, numbers clamped.
 *
 * Design decisions baked in (see docs/UI_SPEC.ja.md):
 *   - One root node, applied atomically (single `apply_ui_spec` op).
 *   - Local components only (no team-library key import in MVP).
 *   - Always create new (no in-place update / idempotency in MVP).
 *   - props use FRIENDLY names; the plugin resolves them to exact `name#id` keys.
 *   - Literals are allowed but color/spacing literals emit a warning (tokens preferred).
 *   - `instance` nodes carry no children; nested customization goes through props.
 */

export const SPEC_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A design-token reference. Resolution uses `var` (a Figma variable id) only;
 *  `name` is an optional human label for error messages and is ignored. */
export interface TokenRef {
  var: string;
  name?: string;
}

/** A spacing/length value: a literal number or a token reference. */
export type Dimension = number | TokenRef;

/** Padding: one value for all sides, a per-side map, or a token reference. */
export type PaddingValue =
  | number
  | TokenRef
  | { top?: Dimension; right?: Dimension; bottom?: Dimension; left?: Dimension };

/** A color value: a hex string ("#1A73E8"), a token reference, or "NONE"
 *  (explicitly no fill — removes a frame's default white fill). */
export type ColorValue = string | TokenRef | "NONE";

/** Auto-layout sizing for a frame axis. */
export type SizeValue = "HUG" | "FILL" | number;

export const LAYOUT_MODES = ["VERTICAL", "HORIZONTAL"] as const;
export const PRIMARY_ALIGNS = ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"] as const;
export const COUNTER_ALIGNS = ["MIN", "CENTER", "MAX", "STRETCH"] as const;

export type LayoutMode = (typeof LAYOUT_MODES)[number];
export type PrimaryAlign = (typeof PRIMARY_ALIGNS)[number];
export type CounterAlign = (typeof COUNTER_ALIGNS)[number];

/** An auto-layout container. The only node type that may have children. */
export interface FrameNode {
  type: "frame";
  name?: string;
  layout: LayoutMode;
  gap?: Dimension;
  padding?: PaddingValue;
  primaryAxisAlign?: PrimaryAlign;
  counterAxisAlign?: CounterAlign;
  width?: SizeValue;
  height?: SizeValue;
  fill?: ColorValue;
  children?: UiNode[];
}

/** An instance of an EXISTING local component or component set. Customized
 *  only through `props` (variant + boolean/text/instance-swap), never children. */
export interface InstanceNode {
  type: "instance";
  componentId: string;
  name?: string;
  props?: Record<string, string | number | boolean>;
}

/** Free text not covered by a component (e.g. a heading). */
export interface TextNode {
  type: "text";
  characters: string;
  name?: string;
  textStyleId?: string;
  fill?: ColorValue;
  fontSize?: number;
}

export type UiNode = FrameNode | InstanceNode | TextNode;

/** What `apply_ui_spec` receives. */
export interface UiSpec {
  version: number;
  validateOnly?: boolean;
  root: UiNode;
}

export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. "root.children[1].props.Variant". */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Allowed keys per object (anything else is rejected — defense against
// smuggling fields the plugin doesn't expect).
// ---------------------------------------------------------------------------

const SPEC_KEYS = ["version", "validateOnly", "root"];
const FRAME_KEYS = [
  "type",
  "name",
  "layout",
  "gap",
  "padding",
  "primaryAxisAlign",
  "counterAxisAlign",
  "width",
  "height",
  "fill",
  "children",
];
const INSTANCE_KEYS = ["type", "name", "componentId", "props"];
const TEXT_KEYS = ["type", "name", "characters", "textStyleId", "fill", "fontSize"];
const TOKEN_REF_KEYS = ["var", "name"];
const PADDING_SIDE_KEYS = ["top", "right", "bottom", "left"];

// ---------------------------------------------------------------------------
// Validator (pure, never throws)
// ---------------------------------------------------------------------------

interface Ctx {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Validate a UI spec's structure. Collects every issue rather than failing fast,
 *  so the agent can repair the whole spec in one pass. */
export function validateUiSpec(input: unknown): ValidationResult {
  const ctx: Ctx = { errors: [], warnings: [] };

  if (!isPlainObject(input)) {
    ctx.errors.push({ path: "", message: "spec must be a JSON object" });
    return finish(ctx);
  }

  if (input.version !== SPEC_VERSION) {
    ctx.errors.push({
      path: "version",
      message: `unsupported version ${stringify(input.version)} (expected ${SPEC_VERSION})`,
    });
  }
  if ("validateOnly" in input && typeof input.validateOnly !== "boolean") {
    ctx.errors.push({ path: "validateOnly", message: "validateOnly must be a boolean" });
  }
  rejectUnknownKeys(input, SPEC_KEYS, "", ctx);

  if (!("root" in input) || input.root === undefined) {
    ctx.errors.push({ path: "root", message: "spec must have a single root node" });
  } else {
    validateNode(input.root, "root", ctx);
  }

  return finish(ctx);
}

function validateNode(value: unknown, path: string, ctx: Ctx): void {
  if (!isPlainObject(value)) {
    ctx.errors.push({ path, message: "node must be an object" });
    return;
  }
  switch (value.type) {
    case "frame":
      validateFrame(value, path, ctx);
      return;
    case "instance":
      validateInstance(value, path, ctx);
      return;
    case "text":
      validateText(value, path, ctx);
      return;
    default:
      ctx.errors.push({
        path: `${path}.type`,
        message: `unknown node type ${stringify(value.type)} (expected "frame" | "instance" | "text")`,
      });
  }
}

function validateFrame(node: Record<string, unknown>, path: string, ctx: Ctx): void {
  rejectUnknownKeys(node, FRAME_KEYS, path, ctx);
  validateOptionalName(node, path, ctx);

  if (!includesValue(LAYOUT_MODES, node.layout)) {
    ctx.errors.push({
      path: `${path}.layout`,
      message: `layout must be one of ${LAYOUT_MODES.join(" | ")}`,
    });
  }

  if ("gap" in node && node.gap !== undefined) {
    validateDimension(node.gap, `${path}.gap`, ctx, { warnLiteral: true });
  }
  if ("padding" in node && node.padding !== undefined) {
    validatePadding(node.padding, `${path}.padding`, ctx);
  }
  if ("primaryAxisAlign" in node && node.primaryAxisAlign !== undefined &&
      !includesValue(PRIMARY_ALIGNS, node.primaryAxisAlign)) {
    ctx.errors.push({
      path: `${path}.primaryAxisAlign`,
      message: `primaryAxisAlign must be one of ${PRIMARY_ALIGNS.join(" | ")}`,
    });
  }
  if ("counterAxisAlign" in node && node.counterAxisAlign !== undefined &&
      !includesValue(COUNTER_ALIGNS, node.counterAxisAlign)) {
    ctx.errors.push({
      path: `${path}.counterAxisAlign`,
      message: `counterAxisAlign must be one of ${COUNTER_ALIGNS.join(" | ")}`,
    });
  }
  if ("width" in node && node.width !== undefined) validateSize(node.width, `${path}.width`, ctx);
  if ("height" in node && node.height !== undefined) validateSize(node.height, `${path}.height`, ctx);
  if ("fill" in node && node.fill !== undefined) validateColor(node.fill, `${path}.fill`, ctx);

  if ("children" in node && node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      ctx.errors.push({ path: `${path}.children`, message: "children must be an array" });
    } else {
      node.children.forEach((child, i) => validateNode(child, `${path}.children[${i}]`, ctx));
    }
  }
}

function validateInstance(node: Record<string, unknown>, path: string, ctx: Ctx): void {
  rejectUnknownKeys(node, INSTANCE_KEYS, path, ctx);
  validateOptionalName(node, path, ctx);

  if (typeof node.componentId !== "string" || node.componentId.length === 0) {
    ctx.errors.push({ path: `${path}.componentId`, message: "componentId must be a non-empty string" });
  }

  if ("props" in node && node.props !== undefined) {
    if (!isPlainObject(node.props)) {
      ctx.errors.push({ path: `${path}.props`, message: "props must be an object" });
    } else {
      for (const key of Object.keys(node.props)) {
        const v = node.props[key];
        const t = typeof v;
        if (t !== "string" && t !== "number" && t !== "boolean") {
          ctx.errors.push({
            path: `${path}.props.${key}`,
            message: "prop values must be a string, number, or boolean",
          });
        }
      }
    }
  }
}

function validateText(node: Record<string, unknown>, path: string, ctx: Ctx): void {
  rejectUnknownKeys(node, TEXT_KEYS, path, ctx);
  validateOptionalName(node, path, ctx);

  if (typeof node.characters !== "string") {
    ctx.errors.push({ path: `${path}.characters`, message: "characters must be a string" });
  }
  if ("textStyleId" in node && node.textStyleId !== undefined && typeof node.textStyleId !== "string") {
    ctx.errors.push({ path: `${path}.textStyleId`, message: "textStyleId must be a string" });
  }
  if ("fill" in node && node.fill !== undefined) validateColor(node.fill, `${path}.fill`, ctx);
  if ("fontSize" in node && node.fontSize !== undefined) {
    validateFiniteNumber(node.fontSize, `${path}.fontSize`, ctx);
  }
}

// ---------------------------------------------------------------------------
// Value validators
// ---------------------------------------------------------------------------

function validateDimension(value: unknown, path: string, ctx: Ctx, opts?: { warnLiteral?: boolean }): void {
  if (isTokenRefShape(value)) {
    validateTokenRef(value, path, ctx);
    return;
  }
  if (typeof value === "number") {
    validateFiniteNumber(value, path, ctx);
    if (opts?.warnLiteral) {
      ctx.warnings.push({ path, message: "literal spacing — prefer a token reference to follow the theme" });
    }
    return;
  }
  ctx.errors.push({ path, message: "must be a number or a token reference { var }" });
}

function validatePadding(value: unknown, path: string, ctx: Ctx): void {
  if (isTokenRefShape(value)) {
    validateTokenRef(value, path, ctx);
    return;
  }
  if (typeof value === "number") {
    validateFiniteNumber(value, path, ctx);
    ctx.warnings.push({ path, message: "literal spacing — prefer a token reference to follow the theme" });
    return;
  }
  if (isPlainObject(value)) {
    rejectUnknownKeys(value, PADDING_SIDE_KEYS, path, ctx);
    for (const side of PADDING_SIDE_KEYS) {
      if (side in value && value[side] !== undefined) {
        validateDimension(value[side], `${path}.${side}`, ctx, { warnLiteral: true });
      }
    }
    return;
  }
  ctx.errors.push({
    path,
    message: "padding must be a number, a token reference, or a { top, right, bottom, left } map",
  });
}

function validateColor(value: unknown, path: string, ctx: Ctx): void {
  if (value === "NONE") return; // explicit "no fill" — removes a frame's default white fill
  if (isTokenRefShape(value)) {
    validateTokenRef(value, path, ctx);
    return;
  }
  if (typeof value === "string") {
    if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) {
      ctx.errors.push({ path, message: `invalid color ${stringify(value)} (expected #RRGGBB, #RRGGBBAA, or "NONE")` });
    } else {
      ctx.warnings.push({ path, message: "literal color — prefer a token reference to follow the theme" });
    }
    return;
  }
  ctx.errors.push({ path, message: "color must be a hex string or a token reference { var }" });
}

function validateSize(value: unknown, path: string, ctx: Ctx): void {
  if (value === "HUG" || value === "FILL") return;
  if (typeof value === "number") {
    validateFiniteNumber(value, path, ctx);
    return;
  }
  ctx.errors.push({ path, message: 'size must be "HUG", "FILL", or a number' });
}

function validateTokenRef(value: Record<string, unknown>, path: string, ctx: Ctx): void {
  rejectUnknownKeys(value, TOKEN_REF_KEYS, path, ctx);
  if (typeof value.var !== "string" || value.var.length === 0) {
    ctx.errors.push({ path: `${path}.var`, message: "token reference must have a non-empty string `var` (variable id)" });
  }
  if ("name" in value && value.name !== undefined && typeof value.name !== "string") {
    ctx.errors.push({ path: `${path}.name`, message: "token reference `name` must be a string" });
  }
}

function validateFiniteNumber(value: unknown, path: string, ctx: Ctx): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    ctx.errors.push({ path, message: "must be a finite number" });
  } else if (value < 0) {
    ctx.errors.push({ path, message: "must be >= 0" });
  }
}

function validateOptionalName(node: Record<string, unknown>, path: string, ctx: Ctx): void {
  if ("name" in node && node.name !== undefined && typeof node.name !== "string") {
    ctx.errors.push({ path: `${path}.name`, message: "name must be a string" });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A value is a token reference if it's a plain object carrying a `var` key.
 *  This lets us tell `{ var }` apart from a per-side padding map or a literal. */
export function isTokenRefShape(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && "var" in value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includesValue<T extends readonly string[]>(allowed: T, value: unknown): value is T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], path: string, ctx: Ctx): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      ctx.errors.push({ path: path ? `${path}.${key}` : key, message: `unknown field "${key}"` });
    }
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

function finish(ctx: Ctx): ValidationResult {
  return { valid: ctx.errors.length === 0, errors: ctx.errors, warnings: ctx.warnings };
}
