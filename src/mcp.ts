/**
 * MCP server (stdio) for GitHub Copilot in Codespaces.
 *
 * It exposes read-only Figma tools that mirror the official Figma Dev Mode MCP,
 * but every operation is executed LOCALLY inside the user's running Figma app
 * via the companion plugin (over the bridge). Nothing is uploaded to S3 or any
 * third-party service — screenshots are produced by the same engine as
 * right-click -> "Copy as PNG".
 *
 * This process runs in the SAME Codespace as the bridge, so it connects to the
 * bridge over localhost. The Figma plugin reaches the bridge through a private,
 * GitHub-authenticated `gh codespace ports forward` tunnel — never a public port.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket } from "ws";
import { z } from "zod";

import { startBridgeServer } from "./bridge-core.js";
import { DEFAULT_CHANNEL, DEFAULT_PORT, type RenderedImage } from "./protocol.js";
import { validateUiSpec } from "./ui-spec.js";

const BRIDGE_URL = process.env.BRIDGE_URL ?? `ws://127.0.0.1:${DEFAULT_PORT}`;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const CHANNEL = process.env.BRIDGE_CHANNEL ?? DEFAULT_CHANNEL;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 30_000);
const EXPORT_DIR = process.env.FIGMA_EXPORT_DIR ?? ".figma-exports";

if (!BRIDGE_TOKEN) {
  console.error("[mcp] BRIDGE_TOKEN is required (set it in .env or the environment).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Bridge client: a resilient WebSocket connection with request/response
// correlation. All Figma reads funnel through request().
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class BridgeClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private pluginConnected = false;
  private readonly pending = new Map<string, Pending>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    this.connect();
  }

  get isPluginConnected(): boolean {
    return this.connected && this.pluginConnected;
  }

  private connect(): void {
    const ws = new WebSocket(BRIDGE_URL);
    this.ws = ws;

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "join", role: "mcp", channel: CHANNEL, token: BRIDGE_TOKEN }));
    });

    ws.on("message", (raw) => this.handleMessage(raw.toString()));

    ws.on("close", (code) => {
      this.connected = false;
      this.pluginConnected = false;
      // 4002 = the bridge replaced us with a newer MCP on the same channel.
      // Stay down instead of reconnecting, or two MCP instances flap forever
      // (which spams the plugin with repeated "MCP connected").
      if (code === 4002) {
        console.error("[mcp] replaced by another MCP instance on this channel; not reconnecting.");
        return;
      }
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error("[mcp] bridge socket error:", err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1_500);
  }

  private handleMessage(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.type === "system") {
      if (msg.event === "joined") {
        this.connected = true;
      } else if (msg.event === "peer_connected" && msg.message === "plugin") {
        this.pluginConnected = true;
      } else if (msg.event === "peer_disconnected" && msg.message === "plugin") {
        this.pluginConnected = false;
      }
      return;
    }

    if (msg.type === "response" && typeof msg.requestId === "string") {
      const pending = this.pending.get(msg.requestId);
      if (!pending) return;
      this.pending.delete(msg.requestId);
      clearTimeout(pending.timer);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(String(msg.error ?? "unknown plugin error")));
      }
    }
  }

  request(op: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.connected) {
        reject(
          new Error(
            "Bridge is not connected. Start it with `npm run bridge` in the Codespace and ensure BRIDGE_URL/BRIDGE_TOKEN match.",
          ),
        );
        return;
      }
      if (!this.pluginConnected) {
        reject(
          new Error(
            "Figma plugin is not connected. In Figma, run the 'Yasuda Figma MCP' plugin and press Connect.",
          ),
        );
        return;
      }

      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms waiting for the Figma plugin.`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: "request", requestId, op, params }));
    });
  }
}

const bridge = new BridgeClient();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a node id from a Figma URL's node-id query (1-23 -> "1:23"). */
function nodeIdFromUrl(url: string): string | null {
  try {
    const raw = new URL(url).searchParams.get("node-id");
    return raw ? raw.replace(/-/g, ":") : null;
  } catch {
    return null;
  }
}

/** Build the {selection|node} target the plugin understands from common args. */
function buildTarget(args: { url?: string; nodeId?: string }): Record<string, unknown> {
  const nodeId = args.nodeId ?? (args.url ? nodeIdFromUrl(args.url) : null);
  return nodeId ? { kind: "node", nodeId } : { kind: "selection" };
}

const nodeTargetShape = {
  url: z
    .string()
    .optional()
    .describe("Figma URL containing a node-id, e.g. https://www.figma.com/design/KEY/Name?node-id=1-23"),
  nodeId: z.string().optional().describe('Figma node id like "1:23". Takes precedence over url.'),
};

function jsonResult(result: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "yasuda-figma-mcp", version: "0.1.0" });

// 1) Screenshot — local render, equivalent to right-click "Copy as PNG".
server.registerTool(
  "yfigma_get_screenshot",
  {
    title: "Get Figma screenshot (local render)",
    description:
      "Render the current selection or a specific node in the user's running Figma app as a PNG/JPG — exactly like right-click -> Copy as PNG. The image is produced locally and returned inline; it is never uploaded to S3 or any public URL.",
    inputSchema: {
      ...nodeTargetShape,
      scale: z.number().min(1).max(4).optional().describe("Export scale 1-4 (default 2)."),
      format: z.enum(["PNG", "JPG"]).optional().describe("Image format (default PNG)."),
      saveToFile: z
        .boolean()
        .optional()
        .describe("Also save the image to FIGMA_EXPORT_DIR inside the Codespace and return the path."),
    },
  },
  async (args) => {
    try {
      const result = (await bridge.request("screenshot", {
        target: buildTarget(args),
        scale: args.scale ?? 2,
        format: args.format ?? "PNG",
      })) as { images: RenderedImage[] };

      const images = result.images ?? [];
      if (images.length === 0) {
        return errorResult("No exportable node was found for the given target.");
      }

      const content: CallToolResult["content"] = [];
      for (const img of images) {
        content.push({
          type: "text",
          text: `${img.name} (${img.nodeId}) — ${img.width}x${img.height}`,
        });
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });

        if (args.saveToFile) {
          const dir = resolve(process.cwd(), EXPORT_DIR);
          await mkdir(dir, { recursive: true });
          const ext = img.mimeType === "image/jpeg" ? "jpg" : "png";
          const safe = img.nodeId.replace(/[^a-zA-Z0-9_-]/g, "_");
          const file = join(dir, `${safe}.${ext}`);
          await writeFile(file, Buffer.from(img.data, "base64"));
          content.push({ type: "text", text: `Saved: ${file}` });
        }
      }
      return { content };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// 1b) Export node — vector SVG (default) or raster PNG/JPG, rendered locally.
server.registerTool(
  "yfigma_export_node",
  {
    title: "Export a Figma node as SVG/PNG/JPG (local, no upload)",
    description:
      "Export the selection or a node as vector SVG markup (default) or a raster PNG/JPG. Produced locally via the same engine as right-click -> Copy as SVG/PNG and returned inline; nothing is uploaded. Use SVG for icons/vectors (the markup is returned as text), and PNG/JPG for raster assets or image fills.",
    inputSchema: {
      ...nodeTargetShape,
      format: z.enum(["SVG", "PNG", "JPG"]).optional().describe("Export format (default SVG)."),
      scale: z.number().min(1).max(4).optional().describe("Raster export scale 1-4 (default 2; ignored for SVG)."),
    },
  },
  async (args) => {
    try {
      const result = (await bridge.request("export_node", {
        target: buildTarget(args),
        format: args.format ?? "SVG",
        scale: args.scale ?? 2,
      })) as { assets: Array<Record<string, any>> };

      const assets = result.assets ?? [];
      if (assets.length === 0) return errorResult("No exportable node was found for the given target.");

      const content: CallToolResult["content"] = [];
      for (const a of assets) {
        if (a.format === "SVG") {
          const svg = Buffer.from(a.svgBase64, "base64").toString("utf8");
          content.push({ type: "text", text: `${a.name} (${a.nodeId}) — SVG` });
          content.push({ type: "text", text: svg });
        } else {
          content.push({ type: "text", text: `${a.name} (${a.nodeId}) — ${a.format} ${a.width}x${a.height}` });
          content.push({ type: "image", data: a.data, mimeType: a.mimeType });
        }
      }
      return { content };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// 2) Metadata — compact node tree (ids, names, types, geometry).
server.registerTool(
  "yfigma_get_metadata",
  {
    title: "Get Figma metadata",
    description:
      "Return a compact tree of the selection or a node: id, name, type, position and size for each node and its descendants. Use this first to discover node ids cheaply before requesting heavier context.",
    inputSchema: {
      ...nodeTargetShape,
      depth: z.number().int().min(0).max(20).optional().describe("Max tree depth to traverse (default 6)."),
    },
  },
  async (args) => {
    try {
      const result = await bridge.request("metadata", {
        target: buildTarget(args),
        depth: args.depth ?? 6,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// 3) Design context — deep serialization for code generation.
server.registerTool(
  "yfigma_get_design_context",
  {
    title: "Get Figma design context",
    description:
      "Return a deep, structured representation of the selection or a node for implementing it as code: layout (auto-layout, constraints, padding, spacing), styles (fills, strokes, effects, corner radius, opacity), typography, text content, component/instance info and bound design-token variables. This is the raw design data; the calling model generates the actual code.",
    inputSchema: {
      ...nodeTargetShape,
      depth: z.number().int().min(0).max(12).optional().describe("Max tree depth to traverse (default 4)."),
    },
  },
  async (args) => {
    try {
      const result = await bridge.request("design_context", {
        target: buildTarget(args),
        depth: args.depth ?? 4,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// 4) Variable definitions — design tokens used by a node, or all local variables.
server.registerTool(
  "yfigma_get_variable_defs",
  {
    title: "Get Figma variable definitions",
    description:
      "Return design-token variables (with values resolved per mode) and their collections. Scope to a node/selection to get only the variables it binds, or use scope=all for every local variable in the file.",
    inputSchema: {
      ...nodeTargetShape,
      scope: z
        .enum(["target", "all"])
        .optional()
        .describe('"target" (default) = variables bound by the node/selection; "all" = every local variable.'),
    },
  },
  async (args) => {
    try {
      const result = await bridge.request("variable_defs", {
        target: buildTarget(args),
        scope: args.scope ?? "target",
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// 5) Search design system — local + published components and styles by name.
server.registerTool(
  "yfigma_search_design_system",
  {
    title: "Search Figma design system",
    description:
      "Search components, component sets and styles (paint/text/effect) in the current file by name substring. Returns matching names with their node ids and published keys where available. If the result has truncated:true, the limit was hit — narrow with the query argument.",
    inputSchema: {
      query: z.string().describe("Case-insensitive substring to match against component/style names."),
      kinds: z
        .array(z.enum(["component", "style"]))
        .optional()
        .describe('What to search (default both). e.g. ["component"].'),
      allPages: z.boolean().optional().describe("Search across all pages (default false: current page only)."),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)."),
    },
  },
  async (args) => {
    try {
      const result = await bridge.request("search_design_system", {
        query: args.query,
        kinds: args.kinds ?? ["component", "style"],
        allPages: args.allPages ?? false,
        limit: args.limit ?? 50,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// 5b) List component sets — variant definitions + exact property keys for planning writes.
server.registerTool(
  "yfigma_list_component_sets",
  {
    title: "List Figma component sets (variants + property keys)",
    description:
      "List local component sets and standalone components with their property definitions: variant groups and their options, defaults, and the EXACT property keys (plain name for VARIANT, name#id for TEXT/BOOLEAN/INSTANCE_SWAP) plus a friendly name for each. Use this to plan apply_ui_spec instances accurately. Variants that live inside a set are represented by the set, not listed separately. If the result has truncated:true, narrow with the query argument.",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive substring to match against component/set names."),
      allPages: z.boolean().optional().describe("Search across all pages (default false: current page only)."),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)."),
    },
  },
  async (args) => {
    try {
      const result = await bridge.request("list_component_sets", {
        query: args.query ?? "",
        allPages: args.allPages ?? false,
        limit: args.limit ?? 50,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// 6) Libraries — available team-library variable collections (plugin API limits noted).
server.registerTool(
  "yfigma_get_libraries",
  {
    title: "Get Figma libraries",
    description:
      "List design-system libraries available to this file. Note: the Figma plugin API only exposes team-library VARIABLE collections, so component-library enumeration is limited compared to the official MCP. Returns what the local API can see plus a note.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.request("libraries", {});
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// 7) FigJam — serialize a FigJam board.
server.registerTool(
  "yfigma_get_figjam",
  {
    title: "Get FigJam content",
    description:
      "Serialize a FigJam board: sticky notes, shapes-with-text, text, sections, tables and connectors with their text and geometry. Operates on the selection or the whole current page.",
    inputSchema: {
      ...nodeTargetShape,
    },
  },
  async (args) => {
    try {
      const result = await bridge.request("figjam", { target: buildTarget(args) });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// 8) Document info — file, pages, current page, selection summary.
server.registerTool(
  "yfigma_get_document_info",
  {
    title: "Get Figma document info",
    description:
      "Return high-level context about the open file: file name, editor type, list of pages, the current page, and a summary of the current selection (ids, names, types).",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.request("document_info", {});
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// 9) Whoami — current Figma user + open file context.
server.registerTool(
  "yfigma_whoami",
  {
    title: "Get current Figma user",
    description:
      "Return the current Figma user (id, name) as reported by the running app, plus the open file and page. Useful to confirm the plugin is connected to the expected account/document.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.request("whoami", {});
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// 10) Apply UI spec (WRITE) — build a screen from a declarative spec.
server.registerTool(
  "yfigma_apply_ui_spec",
  {
    title: "Apply a UI spec to Figma (write)",
    description:
      "Create a screen in the open Figma file from a declarative UI spec (see docs/UI_SPEC.ja.md). Requires Figma Design mode. Builds from EXISTING local components and auto-layout — never raw rectangles or absolute coordinates. The model sends only this declarative data (never code); the plugin applies it deterministically and atomically. First observe the design system with yfigma_list_component_sets / yfigma_get_variable_defs to get real componentIds and tokens. Set validateOnly:true to check the spec against the live document without writing. Returns the created root/node ids, or a list of validation errors. Supports frame, instance (with variant/boolean/text/instance-swap props — instance-swap values are a componentId), text (with font loading), token binding for gap/padding/fill, and HUG/FIXED/FILL sizing.",
    inputSchema: {
      version: z.literal(1).describe("Spec version. Must be 1."),
      validateOnly: z
        .boolean()
        .optional()
        .describe("If true, validate against the live document and return a report without writing."),
      target: z
        .object({ mode: z.enum(["create", "into-selection", "update-selection"]) })
        .optional()
        .describe(
          'Where to apply: "create" (default — a new screen at the viewport center), "into-selection" (append the root into the selected auto-layout frame), or "update-selection" (update the selected node to match the root).',
        ),
      root: z
        .record(z.unknown())
        .describe("The single root node (usually a frame). See docs/UI_SPEC.ja.md for the schema."),
    },
  },
  async (args) => {
    try {
      const spec: Record<string, unknown> = { version: args.version, root: args.root };
      if (args.validateOnly !== undefined) spec.validateOnly = args.validateOnly;
      if (args.target !== undefined) spec.target = args.target;

      // Layer 1: structural validation (the source of truth) — reject early,
      // before involving the plugin or the live document.
      const structural = validateUiSpec(spec);
      if (!structural.valid) {
        return jsonResult({ valid: false, errors: structural.errors, warnings: structural.warnings });
      }

      // Layer 2: the plugin re-validates semantically and applies (or dry-runs).
      const result = (await bridge.request("apply_ui_spec", spec)) as {
        warnings?: unknown[];
        [k: string]: unknown;
      };
      const warnings = [...structural.warnings, ...(result.warnings ?? [])];
      return jsonResult({ ...result, warnings });
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // BRIDGE_EMBED=1 → host the relay in this process, so no separate `npm run
  // bridge` is needed. Used by the npx/multi-project setup where Copilot
  // launches only the MCP. The plugin still reaches it over the private tunnel.
  if (/^(1|true|yes|on)$/i.test(process.env.BRIDGE_EMBED ?? "")) {
    const port = Number(process.env.BRIDGE_PORT ?? DEFAULT_PORT);
    startBridgeServer({ port, token: BRIDGE_TOKEN! });
    console.error(`[mcp] embedded bridge listening on :${port}`);
  }

  bridge.start();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] yasuda-figma-mcp ready (stdio). Bridge:", BRIDGE_URL, "channel:", CHANNEL);
}

main().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});
