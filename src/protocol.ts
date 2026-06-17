/**
 * Wire protocol shared between the bridge, the MCP server, and (informally) the
 * Figma plugin. Everything is plain JSON over WebSocket text frames.
 *
 * Topology:
 *   plugin  <--wss-->  bridge  <--ws(localhost)-->  mcp
 *
 * The bridge is a dumb relay: it authenticates each side with a shared token,
 * pairs an "mcp" and a "plugin" within the same channel, and forwards every
 * other message verbatim to the peer. It never inspects or stores payloads.
 *
 * The MCP server sends a generic `request` { op, params }; the plugin executes
 * the read-only operation against the LOCAL Figma document and replies with a
 * `response` { ok, result | error }. No data ever leaves the user's machine
 * except across this user-controlled channel — there is no S3 or third party.
 */

export type ClientRole = "mcp" | "plugin";

/** First message every client must send after the socket opens. */
export interface JoinMessage {
  type: "join";
  role: ClientRole;
  channel: string;
  token: string;
}

/** mcp -> plugin: run a read-only operation. */
export interface RequestMessage {
  type: "request";
  requestId: string;
  op: string;
  params: Record<string, unknown>;
}

/** plugin -> mcp (or bridge -> mcp when no plugin is connected): the answer. */
export interface ResponseMessage {
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** bridge -> client: connection lifecycle notifications. */
export interface SystemMessage {
  type: "system";
  event: "joined" | "peer_connected" | "peer_disconnected" | "error";
  message?: string;
}

export type BridgeMessage = JoinMessage | RequestMessage | ResponseMessage | SystemMessage;

/** A base64-encoded image produced by the plugin's exportAsync (no data: prefix). */
export interface RenderedImage {
  nodeId: string;
  name: string;
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

export const DEFAULT_PORT = 3055;
export const DEFAULT_CHANNEL = "default";
