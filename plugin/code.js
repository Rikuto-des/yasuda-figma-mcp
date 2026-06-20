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
    case "apply_ui_spec":
      return handleApplyUiSpec(params);
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
  resetVarCache();
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
  resetVarCache();
  const collections = {};
  async function addCollection(id) {
    if (!id || collections[id]) return;
    try {
      const c = await withTimeout(figma.variables.getVariableCollectionByIdAsync(id), 2500, null);
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
  const map = await localVarMap(); // bulk, instead of one (hang-prone) lookup per id
  const variables = [];
  for (const id of Object.keys(ids)) {
    const v = map[id];
    if (v) {
      variables.push(varInfo(v));
      await addCollection(v.variableCollectionId);
    } else {
      // Bound to a remote/library variable we can't resolve locally — still
      // report the id so the binding isn't lost.
      variables.push({ id, name: undefined, remote: true });
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
  // Under documentAccess: "dynamic-page", reading a non-current page's `children`
  // throws until that page is loaded — so only count the current page's children.
  const curId = figma.currentPage.id;
  const pages = figma.root.children.map((p) => {
    const o = { id: p.id, name: p.name };
    if (p.id === curId && "children" in p) o.childCount = p.children.length;
    return o;
  });
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
// apply_ui_spec (WRITE) — build a screen from a declarative UI spec.
//
// The model never sends code; it sends DATA (the spec, see docs/UI_SPEC.ja.md),
// and this fixed builder applies it. No eval, no network — same trust boundary
// as the read ops. The MCP server has already run the full STRUCTURAL validation
// (src/ui-spec.ts); here we re-validate the bits we use (defense in depth):
// resolve components against the LIVE document, clamp numbers, and reject
// features not implemented yet. Application is atomic — any failure removes
// everything created so the document is never left half-built.
//
// Implemented: frame (auto-layout), instance (variant/boolean/text props),
// text (with font loading), token binding (gap/padding/fill -> variables), and
// HUG/FIXED/FILL sizing. INSTANCE_SWAP props are reported as not-yet-supported.
// ---------------------------------------------------------------------------

async function handleApplyUiSpec(params) {
  requireDesignMode();
  const mode = (params.target && params.target.mode) || "create";

  // Always validate against the live document FIRST, and never write if invalid.
  // create rolls back cleanly on failure, but selection edits mutate existing
  // nodes that can't be perfectly undone — validate-first is how we keep them safe.
  const errors = [];
  await dryValidateRoot(params, mode, errors);
  if (params.validateOnly || errors.length > 0) {
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  if (mode === "create") return applyCreate(params);
  if (mode === "into-selection") return applyIntoSelection(params);
  if (mode === "update-selection") return applyUpdateSelection(params);
  return { valid: false, errors: [{ path: "target.mode", message: "unknown target mode: " + mode }], warnings: [] };
}

// ---- apply modes ----------------------------------------------------------

async function applyCreate(params) {
  const created = [];
  let rootNode;
  try {
    rootNode = await buildNode(params.root, "root", created);
    // Size the root now that it is on the page (FILL on the root is rejected here).
    if (params.root.type === "frame") applyFrameSizing(rootNode, params.root, "root", true);
    centerInViewport(rootNode);
    figma.currentPage.selection = [rootNode];
    figma.viewport.scrollAndZoomIntoView([rootNode]);
  } catch (e) {
    rollback(created); // atomic: never leave a half-built tree
    return applyError(e);
  }
  return applyOk(rootNode, created);
}

async function applyIntoSelection(params) {
  let parent;
  try {
    parent = requireSingleSelection();
  } catch (e) {
    return applyError(e);
  }
  if (!isAutoLayoutFrame(parent)) {
    return applyError(new Error("the selected node must be an auto-layout frame to append into (selected: " + parent.type + ")"));
  }
  const created = [];
  let child;
  try {
    child = await buildNode(params.root, "root", created);
    parent.appendChild(child);
    if (params.root.type === "frame") applyFrameSizing(child, params.root, "root", false);
    figma.currentPage.selection = [child];
    figma.viewport.scrollAndZoomIntoView([child]);
  } catch (e) {
    rollback(created);
    return applyError(e);
  }
  return applyOk(child, created);
}

async function applyUpdateSelection(params) {
  let node;
  try {
    node = requireSingleSelection();
  } catch (e) {
    return applyError(e);
  }
  const created = [];
  try {
    await updateSelectedNode(node, params.root, "root", !parentIsAutoLayout(node), created);
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
  } catch (e) {
    rollback(created); // best-effort: removes nodes we added (in-place prop edits can't be undone)
    return applyError(e);
  }
  return applyOk(node, created);
}

// Update the SELECTED node from the spec root. The selected node's type must
// match (we never silently replace what the user picked); descendants may be
// replaced during child reconciliation.
async function updateSelectedNode(node, spec, path, isRoot, created) {
  if (!typeCompatible(spec.type, node.type)) {
    throw new Error(
      "selected node is a " + node.type + " but the spec root is a " + spec.type + "; types must match for update-selection",
    );
  }
  await updateInPlace(node, spec, path, isRoot, created);
}

// Update one existing node in place: frame own-props + child reconcile, instance
// (swap component if it differs, then props), or text.
async function updateInPlace(node, spec, path, isRoot, created) {
  if (spec.type === "frame") {
    await configureFrame(node, spec, path);
    // Only touch children when the spec provides `children`. Omitting it leaves
    // the existing children alone (partial update, like every other field); an
    // explicit [] is the way to clear them.
    if (spec.children !== undefined) await reconcileChildren(node, spec, path, created);
    applyFrameSizing(node, spec, path, isRoot);
  } else if (spec.type === "instance") {
    if (spec.name) node.name = spec.name;
    const target = await resolveComponent(spec.componentId);
    // Swap the whole component when the spec points at a different family. Same
    // family (e.g. another variant of the same set) is handled by props below.
    if ((await instanceFamilyId(node)) !== target.familyId) node.swapComponent(target.comp);
    if (spec.props && Object.keys(spec.props).length > 0) {
      const map = await resolveInstanceProps(target.defs, spec.props, path);
      const needsFont = Object.keys(map).some((k) => target.defs[k] && target.defs[k].type === "TEXT");
      if (needsFont) await loadInstanceTextFonts(node);
      node.setProperties(map);
    }
  } else if (spec.type === "text") {
    await configureText(node, spec, path);
  }
}

// Idempotent child diff with NAME-based matching: each spec child reuses an
// existing child of the same name + compatible type (unnamed children fall back
// to their position); unmatched spec children are built fresh, unmatched
// existing children removed, and everything reordered to the spec order. Robust
// to reordering across re-runs. The frame is auto-layout (configureFrame set it).
async function reconcileChildren(frame, spec, path, created) {
  const kids = Array.isArray(spec.children) ? spec.children : [];
  const existing = frame.children.slice();
  const consumed = new Array(existing.length).fill(false);
  const finalNodes = [];
  const isFresh = [];

  for (let i = 0; i < kids.length; i++) {
    const childPath = path + ".children[" + i + "]";
    const m = findChildMatch(existing, consumed, kids[i], i);
    if (m >= 0) {
      consumed[m] = true;
      await updateInPlace(existing[m], kids[i], childPath, false, created); // in an auto-layout parent
      finalNodes.push(existing[m]);
      isFresh.push(false);
    } else {
      finalNodes.push(await buildNode(kids[i], childPath, created));
      isFresh.push(true);
    }
  }

  // Remove existing children no spec child claimed.
  for (let j = 0; j < existing.length; j++) {
    if (!consumed[j]) {
      try {
        existing[j].remove();
      } catch (_) {
        // already gone
      }
    }
  }
  // Reorder/insert to the spec order, then size freshly built frame children
  // (reconciled frames were already sized by updateInPlace, in their parent).
  for (let i = 0; i < finalNodes.length; i++) frame.insertChild(i, finalNodes[i]);
  for (let i = 0; i < finalNodes.length; i++) {
    if (isFresh[i] && kids[i].type === "frame") {
      applyFrameSizing(finalNodes[i], kids[i], path + ".children[" + i + "]", false);
    }
  }
}

// Pick an existing child for a spec child: by name + compatible type when the
// spec child is named; otherwise the unconsumed child at the same index if its
// type is compatible. Returns the existing index, or -1 to build fresh.
function findChildMatch(existing, consumed, childSpec, index) {
  if (childSpec.name) {
    for (let j = 0; j < existing.length; j++) {
      if (!consumed[j] && existing[j].name === childSpec.name && typeCompatible(childSpec.type, existing[j].type)) {
        return j;
      }
    }
    return -1;
  }
  if (index < existing.length && !consumed[index] && typeCompatible(childSpec.type, existing[index].type)) {
    return index;
  }
  return -1;
}

// ---- selection helpers ----------------------------------------------------

function requireSingleSelection() {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) throw new Error('nothing is selected — select a node, or use target.mode "create"');
  if (sel.length > 1) throw new Error("select exactly one node (" + sel.length + " are selected)");
  return sel[0];
}

function isAutoLayoutFrame(node) {
  return !!node && node.type === "FRAME" && "layoutMode" in node && node.layoutMode !== "NONE";
}

function parentIsAutoLayout(node) {
  return isAutoLayoutFrame(node.parent);
}

function typeCompatible(specType, figmaType) {
  return (
    (specType === "frame" && figmaType === "FRAME") ||
    (specType === "instance" && figmaType === "INSTANCE") ||
    (specType === "text" && figmaType === "TEXT")
  );
}

function rollback(created) {
  for (const n of created.slice().reverse()) {
    try {
      n.remove();
    } catch (_) {
      // already gone (e.g. removed with its parent)
    }
  }
}

function applyOk(rootNode, created) {
  return {
    valid: true,
    root: { id: rootNode.id, name: rootNode.name, type: rootNode.type },
    created: created.map((n) => n.id),
    warnings: [],
  };
}

function applyError(e) {
  return { valid: false, errors: [{ path: "root", message: errMsg(e) }], warnings: [] };
}

// Read-only validation against the LIVE document. Mirrors what build* does, but
// only resolves (components, props, variables, styles) without mutating, and
// collects every error so the agent can fix the whole spec in one pass. The
// validation rules themselves live in the shared resolve* helpers below, so dry
// and build stay in sync.
async function dryValidate(node, path, isRoot, errors) {
  if (!node || typeof node !== "object") {
    errors.push({ path, message: "node must be an object" });
    return;
  }
  if (node.type === "frame") {
    if (isRoot && (node.width === "FILL" || node.height === "FILL")) {
      errors.push({ path, message: '"FILL" needs an auto-layout parent; the root frame has none' });
    }
    await dryCheckVar(node.gap, "FLOAT", path + ".gap", errors);
    await dryCheckPaddingVars(node.padding, path + ".padding", errors);
    await dryCheckVar(node.fill, "COLOR", path + ".fill", errors);
    if (Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i++) {
        await dryValidate(node.children[i], path + ".children[" + i + "]", false, errors);
      }
    }
  } else if (node.type === "instance") {
    try {
      const resolved = await resolveComponent(node.componentId);
      if (node.props && Object.keys(node.props).length > 0) {
        await resolveInstanceProps(resolved.defs, node.props, path); // throws on the first bad prop
      }
    } catch (e) {
      errors.push({ path, message: errMsg(e) });
    }
  } else if (node.type === "text") {
    if (node.textStyleId) {
      try {
        const style = await figma.getStyleByIdAsync(node.textStyleId);
        if (!style || style.type !== "TEXT") {
          errors.push({ path: path + ".textStyleId", message: "text style not found: " + node.textStyleId });
        }
      } catch (e) {
        errors.push({ path: path + ".textStyleId", message: errMsg(e) });
      }
    }
    await dryCheckVar(node.fill, "COLOR", path + ".fill", errors);
  }
}

async function dryCheckVar(value, expectedType, path, errors) {
  if (!isTokenRef(value)) return;
  try {
    await resolveVariable(value, expectedType, path);
  } catch (e) {
    errors.push({ path, message: errMsg(e) });
  }
}

async function dryCheckPaddingVars(padding, path, errors) {
  if (isTokenRef(padding)) {
    await dryCheckVar(padding, "FLOAT", path, errors);
    return;
  }
  if (padding && typeof padding === "object") {
    for (const k of ["top", "right", "bottom", "left"]) {
      if (isTokenRef(padding[k])) await dryCheckVar(padding[k], "FLOAT", path + "." + k, errors);
    }
  }
}

// Route dry validation by target mode (mirrors the apply* dispatch).
async function dryValidateRoot(params, mode, errors) {
  if (!params.root || typeof params.root !== "object") {
    errors.push({ path: "root", message: "root must be an object" });
    return;
  }
  if (mode === "create") {
    await dryValidate(params.root, "root", true, errors);
  } else if (mode === "into-selection") {
    let parent;
    try {
      parent = requireSingleSelection();
    } catch (e) {
      errors.push({ path: "target", message: errMsg(e) });
      return;
    }
    if (!isAutoLayoutFrame(parent)) {
      errors.push({ path: "target", message: "the selected node must be an auto-layout frame to append into (selected: " + parent.type + ")" });
    }
    await dryValidate(params.root, "root", false, errors); // parent is auto-layout → root FILL allowed
  } else if (mode === "update-selection") {
    let node;
    try {
      node = requireSingleSelection();
    } catch (e) {
      errors.push({ path: "target", message: errMsg(e) });
      return;
    }
    await dryValidateUpdate(node, params.root, "root", !parentIsAutoLayout(node), errors);
  } else {
    errors.push({ path: "target.mode", message: "unknown target mode: " + mode });
  }
}

async function dryValidateUpdate(node, spec, path, isRoot, errors) {
  if (!typeCompatible(spec.type, node.type)) {
    errors.push({ path, message: "selected node is a " + node.type + " but the spec root is a " + spec.type + "; types must match for update-selection" });
    return;
  }
  await dryUpdateInPlace(node, spec, path, isRoot, errors);
}

// Read-only mirror of updateInPlace / reconcile*, collecting every error.
async function dryUpdateInPlace(node, spec, path, isRoot, errors) {
  if (spec.type === "frame") {
    if (isRoot && (spec.width === "FILL" || spec.height === "FILL")) {
      errors.push({ path, message: '"FILL" needs an auto-layout parent; the selected frame has none' });
    }
    await dryCheckVar(spec.gap, "FLOAT", path + ".gap", errors);
    await dryCheckPaddingVars(spec.padding, path + ".padding", errors);
    await dryCheckVar(spec.fill, "COLOR", path + ".fill", errors);
    if (spec.children !== undefined) await dryReconcileChildren(node, spec, path, errors);
  } else if (spec.type === "instance") {
    try {
      // Validates the (swap) target component exists locally and props are valid
      // against its definitions.
      const target = await resolveComponent(spec.componentId);
      if (spec.props && Object.keys(spec.props).length > 0) await resolveInstanceProps(target.defs, spec.props, path);
    } catch (e) {
      errors.push({ path, message: errMsg(e) });
    }
  } else if (spec.type === "text") {
    if (spec.textStyleId) {
      try {
        const style = await figma.getStyleByIdAsync(spec.textStyleId);
        if (!style || style.type !== "TEXT") errors.push({ path: path + ".textStyleId", message: "text style not found: " + spec.textStyleId });
      } catch (e) {
        errors.push({ path: path + ".textStyleId", message: errMsg(e) });
      }
    }
    await dryCheckVar(spec.fill, "COLOR", path + ".fill", errors);
  }
}

// Read-only mirror of reconcileChildren's name-based matching.
async function dryReconcileChildren(frame, spec, path, errors) {
  const kids = Array.isArray(spec.children) ? spec.children : [];
  const existing = frame.children.slice();
  const consumed = new Array(existing.length).fill(false);
  for (let i = 0; i < kids.length; i++) {
    const childPath = path + ".children[" + i + "]";
    const m = findChildMatch(existing, consumed, kids[i], i);
    if (m >= 0) {
      consumed[m] = true;
      await dryUpdateInPlace(existing[m], kids[i], childPath, false, errors);
    } else {
      await dryValidate(kids[i], childPath, false, errors);
    }
  }
}

async function buildNode(node, path, created) {
  if (!node || typeof node !== "object") throw new Error("node must be an object at " + path);
  if (node.type === "frame") return buildFrame(node, path, created);
  if (node.type === "instance") return buildInstance(node, path, created);
  if (node.type === "text") return buildText(node, path, created);
  throw new Error("unsupported node type at " + path + ": " + node.type);
}

// Set a frame's own auto-layout properties from the spec (no children, no
// sizing). Shared by create (buildFrame) and update-selection. Only fields the
// spec provides are written, so an update leaves unspecified properties as-is.
async function configureFrame(frame, node, path) {
  if (node.name) frame.name = node.name;
  frame.layoutMode = node.layout;

  if (node.gap !== undefined) {
    if (isTokenRef(node.gap)) {
      frame.setBoundVariable("itemSpacing", await resolveVariable(node.gap, "FLOAT", path + ".gap"));
    } else {
      frame.itemSpacing = clampNum(node.gap, 0, 10000, 0);
    }
  }
  if (node.padding !== undefined) await applyPadding(frame, node.padding, path + ".padding");
  if (node.primaryAxisAlign) frame.primaryAxisAlignItems = node.primaryAxisAlign;
  if (node.counterAxisAlign) frame.counterAxisAlignItems = node.counterAxisAlign;
  if (node.fill !== undefined) await applyNodeFill(frame, node.fill, path + ".fill");
}

async function buildFrame(node, path, created) {
  const frame = figma.createFrame();
  created.push(frame);
  await configureFrame(frame, node, path);

  // Build and append children, then size each child — sizing (esp. FILL) needs
  // the child to already be inside its auto-layout parent. The parent frame is
  // sized by ITS parent (or the root handler), not here.
  if (Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      const childSpec = node.children[i];
      const childPath = path + ".children[" + i + "]";
      const child = await buildNode(childSpec, childPath, created);
      frame.appendChild(child);
      if (childSpec.type === "frame") applyFrameSizing(child, childSpec, childPath, false);
    }
  }
  return frame;
}

async function buildInstance(node, path, created) {
  const resolved = await resolveComponent(node.componentId); // throws on any problem
  const inst = resolved.comp.createInstance();
  created.push(inst);
  if (node.name) inst.name = node.name;

  if (node.props && Object.keys(node.props).length > 0) {
    const map = await resolveInstanceProps(resolved.defs, node.props, path);
    // Setting a TEXT property edits an inner text layer, which needs its font
    // loaded first. Variant/boolean changes don't.
    const needsFont = Object.keys(map).some((k) => resolved.defs[k] && resolved.defs[k].type === "TEXT");
    if (needsFont) await loadInstanceTextFonts(inst);
    inst.setProperties(map);
  }
  return inst;
}

// Apply spec text properties to a text node (fresh or existing). Shared by
// create (buildText) and update-selection.
async function configureText(t, node, path) {
  if (node.name) t.name = node.name;

  // Characters can only be written once the node's current font(s) are loaded.
  await loadAllFontsOfText(t);
  if (typeof node.characters === "string") t.characters = node.characters;

  if (node.textStyleId) {
    const style = await figma.getStyleByIdAsync(node.textStyleId);
    if (!style || style.type !== "TEXT") throw new Error("text style not found: " + node.textStyleId);
    await loadFontSafe(style.fontName); // the style switches the font; load it too
    await t.setTextStyleIdAsync(node.textStyleId);
  } else if (node.fontSize !== undefined) {
    t.fontSize = clampNum(node.fontSize, 1, 10000, 16);
  }

  if (node.fill !== undefined) await applyNodeFill(t, node.fill, path + ".fill");
}

async function buildText(node, path, created) {
  const t = figma.createText();
  created.push(t);
  await configureText(t, node, path);
  return t;
}

// Resolve a spec componentId to { comp, defs }: the local COMPONENT to
// instantiate plus its property definitions (used to resolve props). A
// COMPONENT_SET resolves to its default variant, but its definitions come from
// the SET (variant props live there). Rejects non-components and remote
// (library) components — MVP is local-only.
async function resolveComponent(componentId) {
  const node = await figma.getNodeByIdAsync(componentId);
  if (!node) throw new Error("component not found: " + componentId);
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new Error("componentId " + componentId + " is a " + node.type + ", not a COMPONENT or COMPONENT_SET");
  }
  if (node.remote) {
    throw new Error("component " + componentId + " is from a remote library; only local components are supported");
  }
  let defs = {};
  try {
    defs = node.componentPropertyDefinitions || {};
  } catch (e) {
    defs = {};
  }
  if (node.type === "COMPONENT_SET") {
    const dv = node.defaultVariant;
    if (!dv) throw new Error("component set " + componentId + " has no default variant");
    return { comp: dv, defs, familyId: node.id };
  }
  return { comp: node, defs, familyId: node.id };
}

// The "family" id of an existing instance: its component set's id when the main
// component is a variant, else the main component's id. Compared against
// resolveComponent().familyId to decide whether update-selection must swap.
async function instanceFamilyId(inst) {
  const main = await inst.getMainComponentAsync();
  if (!main) return null;
  if (main.parent && main.parent.type === "COMPONENT_SET") return main.parent.id;
  return main.id;
}

// Resolve spec props (friendly names) to an exact-key setProperties() map,
// validating each value against the component's definitions. Throws on the first
// problem with a path-prefixed message.
async function resolveInstanceProps(defs, props, path) {
  const map = {};
  for (const specName of Object.keys(props)) {
    const key = resolvePropKey(defs, specName, path);
    const def = defs[key];
    const value = props[specName];
    const where = path + ".props." + specName;
    if (def.type === "VARIANT") {
      const opts = def.variantOptions || [];
      const sval = String(value);
      if (opts.indexOf(sval) === -1) {
        throw new Error(where + ': "' + sval + '" is not a valid value (options: ' + opts.join(", ") + ")");
      }
      map[key] = sval;
    } else if (def.type === "BOOLEAN") {
      if (typeof value !== "boolean") throw new Error(where + ": expected a boolean");
      map[key] = value;
    } else if (def.type === "TEXT") {
      map[key] = String(value);
    } else if (def.type === "INSTANCE_SWAP") {
      // The value is a componentId; setProperties accepts the resolved node
      // (string | boolean | ComponentNode | ComponentSetNode), so we pass the
      // node object — no id/key ambiguity. Must be a local component.
      map[key] = await resolveSwapComponent(value, where);
    } else {
      throw new Error(where + ": unsupported property type " + def.type);
    }
  }
  return map;
}

// Resolve an INSTANCE_SWAP value (a componentId) to the local component node to
// swap in. Accepts a COMPONENT or COMPONENT_SET; rejects remote/library nodes.
async function resolveSwapComponent(value, where) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(where + ": INSTANCE_SWAP value must be a componentId string");
  }
  const node = await figma.getNodeByIdAsync(value);
  if (!node) throw new Error(where + ": swap component not found: " + value);
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new Error(where + ": INSTANCE_SWAP value must reference a COMPONENT or COMPONENT_SET (got " + node.type + ")");
  }
  if (node.remote) {
    throw new Error(where + ": swap component " + value + " is from a remote library; only local components are supported");
  }
  return node;
}

// Map a friendly prop name to the exact Figma key. VARIANT keys are the plain
// name; others are "name#id". Accepts an exact key directly; otherwise matches
// on friendly name, erroring on none or on ambiguity.
function resolvePropKey(defs, specName, path) {
  if (Object.prototype.hasOwnProperty.call(defs, specName)) return specName;
  const matches = Object.keys(defs).filter((k) => friendlyPropName(k) === specName);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    const available = Object.keys(defs).map(friendlyPropName).join(", ");
    throw new Error(path + '.props: no property named "' + specName + '" (available: ' + available + ")");
  }
  throw new Error(path + '.props: property "' + specName + '" is ambiguous; use the exact key (one of: ' + matches.join(", ") + ")");
}

// Resolve a token reference to a Figma variable of the expected resolved type.
async function resolveVariable(ref, expectedType, path) {
  const v = await figma.variables.getVariableByIdAsync(ref.var);
  if (!v) throw new Error(path + ": variable not found: " + ref.var);
  if (v.resolvedType !== expectedType) {
    throw new Error(path + ": variable " + (ref.name || v.name) + " is " + v.resolvedType + ", expected " + expectedType);
  }
  return v;
}

async function applyPadding(frame, padding, path) {
  if (isTokenRef(padding)) {
    const v = await resolveVariable(padding, "FLOAT", path);
    frame.setBoundVariable("paddingTop", v);
    frame.setBoundVariable("paddingRight", v);
    frame.setBoundVariable("paddingBottom", v);
    frame.setBoundVariable("paddingLeft", v);
    return;
  }
  if (typeof padding === "number") {
    const v = clampNum(padding, 0, 10000, 0);
    frame.paddingTop = v;
    frame.paddingRight = v;
    frame.paddingBottom = v;
    frame.paddingLeft = v;
    return;
  }
  if (padding && typeof padding === "object") {
    await applyPaddingSide(frame, "paddingTop", padding.top, path + ".top");
    await applyPaddingSide(frame, "paddingRight", padding.right, path + ".right");
    await applyPaddingSide(frame, "paddingBottom", padding.bottom, path + ".bottom");
    await applyPaddingSide(frame, "paddingLeft", padding.left, path + ".left");
  }
}

async function applyPaddingSide(frame, field, value, path) {
  if (value === undefined) return;
  if (isTokenRef(value)) {
    frame.setBoundVariable(field, await resolveVariable(value, "FLOAT", path));
  } else {
    frame[field] = clampNum(value, 0, 10000, 0);
  }
}

// Set a node's fill from a hex string, "NONE", or a COLOR token reference. Used
// for both frames and text.
async function applyNodeFill(node, fill, path) {
  if (fill === "NONE") {
    node.fills = [];
    return;
  }
  if (isTokenRef(fill)) {
    const v = await resolveVariable(fill, "COLOR", path);
    const base = { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
    node.fills = [figma.variables.setBoundVariableForPaint(base, "color", v)];
    return;
  }
  if (typeof fill === "string") {
    const rgb = hexToRgb(fill);
    if (rgb) node.fills = [{ type: "SOLID", color: { r: rgb.r, g: rgb.g, b: rgb.b }, opacity: rgb.a }];
  }
}

function applyFrameSizing(frame, spec, path, isRoot) {
  applyAxisSize(frame, "horizontal", spec.width, path + ".width", isRoot);
  applyAxisSize(frame, "vertical", spec.height, path + ".height", isRoot);
}

function applyAxisSize(frame, axis, value, path, isRoot) {
  const horiz = axis === "horizontal";
  if (value === undefined || value === "HUG") {
    if (horiz) frame.layoutSizingHorizontal = "HUG";
    else frame.layoutSizingVertical = "HUG";
    return;
  }
  if (value === "FILL") {
    if (isRoot) {
      throw new Error(path + ': "FILL" needs an auto-layout parent; the root frame has none — use "HUG" or a number');
    }
    if (horiz) frame.layoutSizingHorizontal = "FILL";
    else frame.layoutSizingVertical = "FILL";
    return;
  }
  // number -> fixed size on that axis.
  if (horiz) {
    frame.layoutSizingHorizontal = "FIXED";
    frame.resize(clampNum(value, 1, 100000, frame.width), frame.height);
  } else {
    frame.layoutSizingVertical = "FIXED";
    frame.resize(frame.width, clampNum(value, 1, 100000, frame.height));
  }
}

function centerInViewport(node) {
  const c = figma.viewport.center;
  node.x = Math.round(c.x - node.width / 2);
  node.y = Math.round(c.y - node.height / 2);
}

function isTokenRef(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && "var" in v;
}

// Load a font, tolerating the default/mixed case (fresh text nodes carry a
// single concrete font, but guard anyway).
async function loadFontSafe(font) {
  if (!font || font === figma.mixed) {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    return;
  }
  await figma.loadFontAsync(font);
}

// Load every font used by an instance's text layers, so setting a TEXT property
// (which edits those layers) won't fail on an unloaded font.
async function loadInstanceTextFonts(inst) {
  let texts = [];
  try {
    texts = inst.findAllWithCriteria
      ? inst.findAllWithCriteria({ types: ["TEXT"] })
      : inst.findAll((n) => n.type === "TEXT");
  } catch (e) {
    texts = [];
  }
  for (const t of texts) await loadAllFontsOfText(t);
}

async function loadAllFontsOfText(t) {
  try {
    const len = t.characters.length;
    const fonts = len > 0 ? t.getRangeAllFontNames(0, len) : [t.fontName];
    for (const f of fonts) {
      if (f && f !== figma.mixed) await figma.loadFontAsync(f);
    }
  } catch (e) {
    // best-effort; setProperties will surface a clear error if a font is missing
  }
}

function hexToRgb(hex) {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const a = m[2] !== undefined ? parseInt(m[2], 16) / 255 : 1;
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a };
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

// Time-box an async lookup so a hanging Figma API call degrades gracefully
// instead of stalling the whole serialization. Under documentAccess:
// "dynamic-page", getVariableByIdAsync / getMainComponentAsync for library-backed
// nodes can take many seconds (or effectively hang), which previously made
// get_design_context time out on real design-system files.
function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((res) => setTimeout(() => res(fallback), ms))]);
}

// id -> Variable map, built ONCE per read request from a single
// getLocalVariablesAsync() call, instead of one getVariableByIdAsync per node
// (which is slow and can hang). Library/remote variables aren't local, so their
// names won't resolve from here — callers still return the raw id for those.
let _localVarMapPromise = null;
function resetVarCache() {
  _localVarMapPromise = null;
}
function localVarMap() {
  if (!_localVarMapPromise) {
    _localVarMapPromise = (async () => {
      const map = Object.create(null);
      try {
        const vars = await withTimeout(figma.variables.getLocalVariablesAsync(), 8000, []);
        for (const v of vars) map[v.id] = v;
      } catch (e) {
        // ignore
      }
      return map;
    })();
  }
  return _localVarMapPromise;
}

async function componentObj(node) {
  if (node.type === "INSTANCE") {
    let main = null;
    try {
      main = await withTimeout(node.getMainComponentAsync(), 2500, null);
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
  const map = await localVarMap(); // one bulk lookup, cached for the whole request
  const out = {};
  for (const prop of Object.keys(bv)) {
    const entry = bv[prop];
    const arr = Array.isArray(entry) ? entry : [entry];
    const refs = [];
    for (const a of arr) {
      if (a && a.id) {
        const v = map[a.id];
        // Always include the raw id (raw data); add the name when it's a local
        // variable. Remote/library bindings keep just the id.
        refs.push(v ? { id: a.id, name: v.name } : { id: a.id });
      }
    }
    if (refs.length) out[prop] = refs.length === 1 ? refs[0] : refs;
  }
  return Object.keys(out).length ? out : undefined;
}
