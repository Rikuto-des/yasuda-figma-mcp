/**
 * Yasuda Figma MCP — Figma plugin (main thread).
 *
 * This sandbox has the Figma document APIs but NO network access. It receives
 * read-only operations from ui.html (which holds the WebSocket to the bridge),
 * executes them against the LOCAL document, and posts the result back to the UI
 * to be relayed to the MCP server. Screenshots use exportAsync — the exact same
 * local renderer as right-click -> "Copy as PNG" — so nothing is uploaded to S3
 * or any external service.
 */

figma.showUI(__html__, { width: 360, height: 460, themeColors: true });

// Restore saved connection settings into the UI.
(async () => {
  let settings = null;
  try {
    settings = await figma.clientStorage.getAsync("bridgeSettings");
  } catch (e) {
    // ignore
  }
  figma.ui.postMessage({ type: "settings", settings: settings || null });
})();

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "save-settings") {
    try {
      await figma.clientStorage.setAsync("bridgeSettings", msg.settings);
    } catch (e) {
      // ignore
    }
    return;
  }

  if (msg.type === "request") {
    let response;
    try {
      const result = await handleRequest(msg.op, msg.params || {});
      response = { type: "response", requestId: msg.requestId, ok: true, result };
    } catch (e) {
      response = { type: "response", requestId: msg.requestId, ok: false, error: errMsg(e) };
    }
    figma.ui.postMessage(response);
  }
};

// ---------------------------------------------------------------------------
// Operation dispatch
// ---------------------------------------------------------------------------

async function handleRequest(op, params) {
  switch (op) {
    case "screenshot":
      return handleScreenshot(params);
    case "metadata":
      return handleMetadata(params);
    case "design_context":
      return handleDesignContext(params);
    case "variable_defs":
      return handleVariableDefs(params);
    case "search_design_system":
      return handleSearch(params);
    case "list_component_sets":
      return handleListComponentSets(params);
    case "libraries":
      return handleLibraries();
    case "figjam":
      return handleFigjam(params);
    case "document_info":
      return handleDocumentInfo();
    case "whoami":
      return handleWhoami();
    default:
      throw new Error("Unknown op: " + op);
  }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

async function resolveTargetNodes(target) {
  if (target && target.kind === "node") {
    const node = await figma.getNodeByIdAsync(target.nodeId);
    if (!node) throw new Error("Node not found: " + target.nodeId + ". Is this file/page open?");
    return [node];
  }
  const sel = figma.currentPage.selection.slice();
  if (!sel.length) {
    throw new Error("Nothing is selected in Figma. Select a layer/frame, or pass a nodeId/url.");
  }
  return sel;
}

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

async function handleScreenshot(params) {
  const nodes = await resolveTargetNodes(params.target);
  const scale = clampNum(params.scale, 1, 4, 2);
  const format = params.format === "JPG" ? "JPG" : "PNG";
  const images = [];
  for (const node of nodes) {
    if (!("exportAsync" in node)) continue;
    const bytes = await node.exportAsync({ format, constraint: { type: "SCALE", value: scale } });
    images.push({
      nodeId: node.id,
      name: node.name,
      data: figma.base64Encode(bytes),
      mimeType: format === "JPG" ? "image/jpeg" : "image/png",
      width: Math.round(node.width),
      height: Math.round(node.height),
    });
  }
  if (!images.length) throw new Error("No exportable node found (selection empty or node not exportable).");
  return { images };
}

// ---------------------------------------------------------------------------
// metadata (compact tree)
// ---------------------------------------------------------------------------

async function handleMetadata(params) {
  const nodes = await resolveTargetNodes(params.target);
  const depth = typeof params.depth === "number" ? params.depth : 6;
  return { count: nodes.length, nodes: nodes.map((n) => metaNode(n, 0, depth)) };
}

function metaNode(node, depth, maxDepth) {
  const o = { id: node.id, name: node.name, type: node.type, visible: node.visible !== false };
  if ("width" in node) {
    o.x = round(node.x);
    o.y = round(node.y);
    o.width = round(node.width);
    o.height = round(node.height);
  }
  if ("children" in node && node.children.length) {
    if (depth < maxDepth) {
      o.children = node.children.map((c) => metaNode(c, depth + 1, maxDepth));
    } else {
      o.childCount = node.children.length;
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// design_context (deep serialization for codegen)
// ---------------------------------------------------------------------------

async function handleDesignContext(params) {
  const nodes = await resolveTargetNodes(params.target);
  const depth = typeof params.depth === "number" ? params.depth : 4;
  const out = [];
  for (const n of nodes) out.push(await ctxNode(n, 0, depth));
  return { count: out.length, nodes: out };
}

async function ctxNode(node, depth, maxDepth) {
  const o = { id: node.id, name: node.name, type: node.type, visible: node.visible !== false };

  if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
    const b = node.absoluteBoundingBox;
    o.bounds = { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
  } else if ("width" in node) {
    o.size = { width: round(node.width), height: round(node.height) };
  }
  if ("opacity" in node && node.opacity !== 1) o.opacity = round(node.opacity);
  if ("rotation" in node && node.rotation) o.rotation = round(node.rotation);
  if ("constraints" in node) o.constraints = node.constraints;

  const layout = layoutObj(node);
  if (layout) o.layout = layout;
  if ("layoutSizingHorizontal" in node) {
    o.layoutSizing = { horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical };
  }

  if ("fills" in node) {
    const f = paintsToArr(node.fills);
    if (f) o.fills = f;
  }
  if ("strokes" in node && node.strokes && node.strokes.length) {
    o.strokes = paintsToArr(node.strokes);
    o.strokeWeight = node.strokeWeight === figma.mixed ? "mixed" : node.strokeWeight;
    o.strokeAlign = node.strokeAlign;
  }
  if ("effects" in node && node.effects && node.effects.length) o.effects = effectsToArr(node.effects);
  const cr = cornerRadius(node);
  if (cr !== undefined) o.cornerRadius = cr;

  if (node.type === "TEXT") o.text = textObj(node);

  const comp = await componentObj(node);
  if (comp) o.component = comp;

  const bv = await boundVarsObj(node);
  if (bv) o.boundVariables = bv;

  if ("children" in node && node.children.length) {
    if (depth < maxDepth) {
      o.children = [];
      for (const c of node.children) o.children.push(await ctxNode(c, depth + 1, maxDepth));
    } else {
      o.childCount = node.children.length;
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// variable_defs
// ---------------------------------------------------------------------------

async function handleVariableDefs(params) {
  const collections = {};
  async function addCollection(id) {
    if (!id || collections[id]) return;
    try {
      const c = await figma.variables.getVariableCollectionByIdAsync(id);
      if (c) collections[id] = { id: c.id, name: c.name, modes: c.modes, defaultModeId: c.defaultModeId };
    } catch (e) {
      // ignore
    }
  }
  function varInfo(v) {
    return {
      id: v.id,
      name: v.name,
      key: v.key,
      resolvedType: v.resolvedType,
      collectionId: v.variableCollectionId,
      valuesByMode: v.valuesByMode,
      description: v.description || undefined,
    };
  }

  if (params.scope === "all") {
    const vars = await figma.variables.getLocalVariablesAsync();
    for (const v of vars) await addCollection(v.variableCollectionId);
    return { scope: "all", count: vars.length, variables: vars.map(varInfo), collections: values(collections) };
  }

  const nodes = await resolveTargetNodes(params.target);
  const ids = {};
  collectBoundVariableIds(nodes, ids);
  const variables = [];
  for (const id of Object.keys(ids)) {
    try {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (v) {
        variables.push(varInfo(v));
        await addCollection(v.variableCollectionId);
      }
    } catch (e) {
      // ignore
    }
  }
  return { scope: "target", count: variables.length, variables, collections: values(collections) };
}

function collectBoundVariableIds(nodes, acc) {
  for (const node of nodes) {
    const bv = node.boundVariables;
    if (bv && typeof bv === "object") {
      for (const prop of Object.keys(bv)) {
        const entry = bv[prop];
        const arr = Array.isArray(entry) ? entry : [entry];
        for (const a of arr) if (a && a.id) acc[a.id] = true;
      }
    }
    if ("children" in node && node.children.length) collectBoundVariableIds(node.children, acc);
  }
}

// ---------------------------------------------------------------------------
// search_design_system
// ---------------------------------------------------------------------------

async function handleSearch(params) {
  const q = String(params.query || "").toLowerCase();
  const kinds = params.kinds || ["component", "style"];
  const limit = clampNum(params.limit, 1, 200, 50);
  const results = [];

  if (kinds.indexOf("component") !== -1) {
    // dynamic-page docs throw on figma.root traversal until all pages are loaded.
    // Without this, allPages would silently return an empty list.
    if (params.allPages) {
      try {
        await figma.loadAllPagesAsync();
      } catch (e) {
        // ignore — fall back to whatever is already loaded
      }
    }
    const root = params.allPages ? figma.root : figma.currentPage;
    let comps = [];
    try {
      comps = root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
    } catch (e) {
      // ignore
    }
    for (const c of comps) {
      if (!q || c.name.toLowerCase().indexOf(q) !== -1) {
        results.push({ kind: "component", type: c.type, id: c.id, name: c.name, key: c.key || undefined });
        if (results.length >= limit) return finishSearch(params.query, results, true);
      }
    }
  }

  if (kinds.indexOf("style") !== -1) {
    const styleSets = [
      ["PAINT", await safeStyles(figma.getLocalPaintStylesAsync)],
      ["TEXT", await safeStyles(figma.getLocalTextStylesAsync)],
      ["EFFECT", await safeStyles(figma.getLocalEffectStylesAsync)],
    ];
    for (const pair of styleSets) {
      for (const s of pair[1]) {
        if (!q || s.name.toLowerCase().indexOf(q) !== -1) {
          results.push({ kind: "style", styleType: pair[0], id: s.id, name: s.name, key: s.key || undefined });
          if (results.length >= limit) return finishSearch(params.query, results, true);
        }
      }
    }
  }
  return finishSearch(params.query, results);
}

function finishSearch(query, results, truncated) {
  const out = { query, count: results.length, results };
  if (truncated) out.truncated = true;
  return out;
}

async function safeStyles(getter) {
  try {
    return await getter();
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// list_component_sets (variant defs + exact property keys for planning writes)
// ---------------------------------------------------------------------------

async function handleListComponentSets(params) {
  const q = String(params.query || "").toLowerCase();
  const limit = clampNum(params.limit, 1, 200, 50);

  // dynamic-page docs throw on figma.root traversal until all pages are loaded.
  // Without this, allPages would silently return an empty list.
  if (params.allPages) {
    try {
      await figma.loadAllPagesAsync();
    } catch (e) {
      // ignore — fall back to whatever is already loaded
    }
  }
  const root = params.allPages ? figma.root : figma.currentPage;

  let nodes = [];
  try {
    nodes = root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] });
  } catch (e) {
    // ignore
  }

  const componentSets = [];
  const components = [];
  let truncated = false;
  for (const n of nodes) {
    if (q && n.name.toLowerCase().indexOf(q) === -1) continue;
    if (componentSets.length + components.length >= limit) {
      truncated = true;
      break;
    }
    if (n.type === "COMPONENT_SET") {
      componentSets.push({
        id: n.id,
        name: n.name,
        key: n.key || undefined,
        variantCount: "children" in n ? n.children.length : 0,
        properties: propDefs(n),
      });
    } else if (n.type === "COMPONENT") {
      // Skip variants that live inside a set — the set already represents them.
      if (n.parent && n.parent.type === "COMPONENT_SET") continue;
      components.push({ id: n.id, name: n.name, key: n.key || undefined, properties: propDefs(n) });
    }
  }
  const out = { count: componentSets.length + components.length, componentSets, components };
  if (truncated) out.truncated = true;
  return out;
}

// Summarize componentPropertyDefinitions. Keys are the EXACT Figma keys: a plain
// name for VARIANT, "name#id" for TEXT/BOOLEAN/INSTANCE_SWAP. We also expose the
// friendly name so the agent can author specs by name and still see the exact key.
function propDefs(node) {
  let defs = null;
  try {
    defs = node.componentPropertyDefinitions;
  } catch (e) {
    return undefined;
  }
  if (!defs) return undefined;
  const out = {};
  for (const key of Object.keys(defs)) {
    const d = defs[key];
    const o = { type: d.type, name: friendlyPropName(key) };
    if (d.defaultValue !== undefined) o.default = d.defaultValue;
    if (d.variantOptions) o.options = d.variantOptions;
    if (d.type === "INSTANCE_SWAP" && d.preferredValues) o.preferredValues = d.preferredValues;
    out[key] = o;
  }
  return out;
}

function friendlyPropName(key) {
  const i = key.indexOf("#");
  return i === -1 ? key : key.slice(0, i);
}

// ---------------------------------------------------------------------------
// libraries
// ---------------------------------------------------------------------------

async function handleLibraries() {
  const note =
    "Figma's plugin API only exposes team-library VARIABLE collections. Full component-library enumeration is not available to plugins; use the official MCP or REST API for that.";
  try {
    const cols = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    return {
      note,
      libraryVariableCollections: cols.map((c) => ({ key: c.key, name: c.name, libraryName: c.libraryName })),
    };
  } catch (e) {
    return { note, error: errMsg(e), libraryVariableCollections: [] };
  }
}

// ---------------------------------------------------------------------------
// figjam
// ---------------------------------------------------------------------------

async function handleFigjam(params) {
  let nodes;
  if (params.target && params.target.kind === "node") {
    nodes = await resolveTargetNodes(params.target);
  } else if (figma.currentPage.selection.length) {
    nodes = figma.currentPage.selection.slice();
  } else {
    nodes = figma.currentPage.children.slice();
  }
  return { page: figma.currentPage.name, count: nodes.length, nodes: nodes.map(figjamNode) };
}

function figjamNode(node) {
  const o = { id: node.id, name: node.name, type: node.type };
  if (node.type === "TEXT" && "characters" in node) {
    o.text = node.characters;
  } else if ("text" in node && node.text && "characters" in node.text) {
    o.text = node.text.characters;
  }
  if ("x" in node) {
    o.x = round(node.x);
    o.y = round(node.y);
  }
  if ("width" in node) {
    o.width = round(node.width);
    o.height = round(node.height);
  }
  if (node.type === "CONNECTOR") {
    o.connectorStart = endpointId(node.connectorStart);
    o.connectorEnd = endpointId(node.connectorEnd);
  }
  if ("children" in node && node.children.length) o.children = node.children.map(figjamNode);
  return o;
}

function endpointId(ep) {
  if (ep && ep.endpointNodeId) return ep.endpointNodeId;
  return undefined;
}

// ---------------------------------------------------------------------------
// document_info / whoami
// ---------------------------------------------------------------------------

async function handleDocumentInfo() {
  const pages = figma.root.children.map((p) => ({
    id: p.id,
    name: p.name,
    childCount: "children" in p ? p.children.length : 0,
  }));
  return {
    fileName: figma.root.name,
    editorType: figma.editorType,
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    pages,
    selection: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type })),
  };
}

async function handleWhoami() {
  const u = figma.currentUser;
  return {
    user: u ? { id: u.id, name: u.name, photoUrl: u.photoUrl, color: u.color } : null,
    note: u
      ? undefined
      : "figma.currentUser is null (the plugin may lack permission or run in a context without a user).",
    editorType: figma.editorType,
    fileName: figma.root.name,
    currentPage: figma.currentPage.name,
  };
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function round(n) {
  return typeof n === "number" ? Math.round(n * 100) / 100 : n;
}

function clampNum(v, min, max, fallback) {
  const n = typeof v === "number" ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Write ops require Figma Design mode. Dev Mode runs plugins read-only and
 * FigJam/Slides have no design surface, so reject writes there with a clear
 * message instead of failing deep inside the Figma API. Reads work in any mode.
 * Wired into the write ops added in the apply_ui_spec milestone.
 */
function requireDesignMode() {
  if (figma.editorType !== "figma") {
    throw new Error(
      "Write operations require Figma Design mode (current editor: " +
        figma.editorType +
        "). Dev Mode runs plugins read-only — switch to Design mode and retry.",
    );
  }
}

function values(obj) {
  return Object.keys(obj).map((k) => obj[k]);
}

function errMsg(e) {
  return e && e.message ? String(e.message) : String(e);
}

function rgbToHex(c) {
  const h = (x) => {
    const v = Math.round((x || 0) * 255);
    return (v < 16 ? "0" : "") + v.toString(16);
  };
  return "#" + h(c.r) + h(c.g) + h(c.b);
}

function paintToObj(p) {
  if (!p) return null;
  const o = { type: p.type, visible: p.visible !== false, opacity: typeof p.opacity === "number" ? p.opacity : 1 };
  if (p.type === "SOLID") {
    o.color = rgbToHex(p.color);
  } else if (typeof p.type === "string" && p.type.indexOf("GRADIENT") === 0) {
    o.stops = (p.gradientStops || []).map((s) => ({
      position: round(s.position),
      color: rgbToHex(s.color),
      a: round(s.color.a),
    }));
  } else if (p.type === "IMAGE") {
    o.scaleMode = p.scaleMode;
    o.imageHash = p.imageHash;
  }
  return o;
}

function paintsToArr(paints) {
  if (paints === figma.mixed) return "mixed";
  if (!Array.isArray(paints)) return undefined;
  if (!paints.length) return undefined;
  return paints.map(paintToObj);
}

function effectsToArr(effects) {
  return effects.map((e) => {
    const o = { type: e.type, visible: e.visible !== false };
    if (typeof e.radius === "number") o.radius = round(e.radius);
    if (e.color) {
      o.color = rgbToHex(e.color);
      o.a = round(e.color.a);
    }
    if (e.offset) o.offset = { x: round(e.offset.x), y: round(e.offset.y) };
    if (typeof e.spread === "number") o.spread = e.spread;
    return o;
  });
}

function cornerRadius(node) {
  if (!("cornerRadius" in node)) return undefined;
  if (node.cornerRadius === figma.mixed) {
    return {
      topLeft: node.topLeftRadius,
      topRight: node.topRightRadius,
      bottomRight: node.bottomRightRadius,
      bottomLeft: node.bottomLeftRadius,
    };
  }
  return node.cornerRadius || undefined;
}

function layoutObj(node) {
  if (!("layoutMode" in node) || node.layoutMode === "NONE") return undefined;
  return {
    mode: node.layoutMode,
    primaryAxisAlignItems: node.primaryAxisAlignItems,
    counterAxisAlignItems: node.counterAxisAlignItems,
    primaryAxisSizingMode: node.primaryAxisSizingMode,
    counterAxisSizingMode: node.counterAxisSizingMode,
    layoutWrap: node.layoutWrap,
    itemSpacing: node.itemSpacing,
    padding: {
      top: node.paddingTop,
      right: node.paddingRight,
      bottom: node.paddingBottom,
      left: node.paddingLeft,
    },
  };
}

function mixedOr(v) {
  return v === figma.mixed ? "mixed" : v;
}

function textObj(node) {
  return {
    characters: node.characters,
    fontSize: mixedOr(node.fontSize),
    fontName: mixedOr(node.fontName),
    fontWeight: mixedOr(node.fontWeight),
    letterSpacing: mixedOr(node.letterSpacing),
    lineHeight: mixedOr(node.lineHeight),
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    textCase: mixedOr(node.textCase),
    textDecoration: mixedOr(node.textDecoration),
  };
}

async function componentObj(node) {
  if (node.type === "INSTANCE") {
    let main = null;
    try {
      main = await node.getMainComponentAsync();
    } catch (e) {
      // ignore
    }
    return {
      mainComponentName: main ? main.name : undefined,
      mainComponentKey: main ? main.key : undefined,
      mainComponentId: main ? main.id : undefined,
      properties: node.componentProperties ? serializeComponentProps(node.componentProperties) : undefined,
    };
  }
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    return { key: node.key, description: node.description || undefined };
  }
  return undefined;
}

function serializeComponentProps(props) {
  const o = {};
  for (const k of Object.keys(props)) {
    const p = props[k];
    o[k] = p && typeof p === "object" && "value" in p ? p.value : p;
  }
  return o;
}

async function boundVarsObj(node) {
  const bv = node.boundVariables;
  if (!bv || typeof bv !== "object") return undefined;
  const out = {};
  for (const prop of Object.keys(bv)) {
    const entry = bv[prop];
    const arr = Array.isArray(entry) ? entry : [entry];
    const names = [];
    for (const a of arr) {
      if (a && a.id) {
        try {
          const v = await figma.variables.getVariableByIdAsync(a.id);
          if (v) names.push(v.name);
        } catch (e) {
          // ignore
        }
      }
    }
    if (names.length) out[prop] = names.length === 1 ? names[0] : names;
  }
  return Object.keys(out).length ? out : undefined;
}
