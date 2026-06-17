/**
 * WebSocket relay that pairs the Figma plugin with the MCP server.
 *
 * Runs inside the Codespace. The MCP server connects over localhost; the Figma
 * plugin connects over a PRIVATE `gh codespace ports forward` tunnel (loopback,
 * GitHub-authenticated — never a public URL). Both authenticate with
 * BRIDGE_TOKEN and join the same channel. The bridge then forwards every message
 * between the two peers without persisting anything — image bytes pass straight
 * through RAM and are never written to disk or any external service.
 *
 * Defense in depth: the private tunnel gates reachability, and BRIDGE_TOKEN gates
 * channel membership. Use a long random value (npm run token) and rotate if leaked.
 */
import { WebSocketServer, WebSocket } from "ws";

import { DEFAULT_PORT } from "./protocol.js";

const PORT = Number(process.env.BRIDGE_PORT ?? DEFAULT_PORT);
const TOKEN = process.env.BRIDGE_TOKEN;

if (!TOKEN) {
  console.error("[bridge] BRIDGE_TOKEN is required (set it in .env or the environment).");
  process.exit(1);
}

interface Channel {
  mcp?: WebSocket;
  plugin?: WebSocket;
}

const channels = new Map<string, Channel>();

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

const wss = new WebSocketServer({ port: PORT, host: "0.0.0.0" });

wss.on("listening", () => {
  console.error(`[bridge] listening on 0.0.0.0:${PORT}`);
  console.error(`[bridge] from your LOCAL machine: gh codespace ports forward ${PORT}:${PORT} (private tunnel)`);
});

wss.on("connection", (ws) => {
  let joined = false;
  let role: "mcp" | "plugin" | null = null;
  let channelId: string | null = null;

  // Liveness: tunnels can drop idle sockets, so track pong replies.
  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!joined) {
      if (msg.type !== "join") {
        send(ws, { type: "system", event: "error", message: "expected join message" });
        ws.close(4000, "expected join");
        return;
      }
      if (msg.token !== TOKEN) {
        send(ws, { type: "system", event: "error", message: "invalid token" });
        ws.close(4001, "invalid token");
        return;
      }
      if (msg.role !== "mcp" && msg.role !== "plugin") {
        send(ws, { type: "system", event: "error", message: "invalid role" });
        ws.close(4000, "invalid role");
        return;
      }

      const r: "mcp" | "plugin" = msg.role;
      const cid = String(msg.channel || "default");
      role = r;
      channelId = cid;
      const ch = channels.get(cid) ?? {};

      // Replace any stale connection of the same role (e.g. plugin reconnected).
      const existing = ch[r];
      if (existing && existing.readyState === WebSocket.OPEN) {
        send(existing, { type: "system", event: "error", message: "replaced by a newer connection" });
        existing.close(4002, "replaced");
      }
      ch[r] = ws;
      channels.set(cid, ch);
      joined = true;

      send(ws, { type: "system", event: "joined", message: `role=${r} channel=${cid}` });

      // If the peer is already here, tell both sides.
      const peerRole = r === "mcp" ? "plugin" : "mcp";
      const peer = ch[peerRole];
      if (peer && peer.readyState === WebSocket.OPEN) {
        send(ws, { type: "system", event: "peer_connected", message: peerRole });
        send(peer, { type: "system", event: "peer_connected", message: role });
      }
      console.error(`[bridge] ${r} joined channel "${cid}"`);
      return;
    }

    // Already joined: relay to the peer.
    const ch = channelId ? channels.get(channelId) : undefined;
    if (!ch || !role) return;
    const peerRole = role === "mcp" ? "plugin" : "mcp";
    const peer = ch[peerRole];

    if (peer && peer.readyState === WebSocket.OPEN) {
      peer.send(raw.toString());
    } else if (role === "mcp" && msg.type === "request") {
      // No plugin connected — fail the request fast instead of timing out.
      send(ws, {
        type: "response",
        requestId: msg.requestId,
        ok: false,
        error: "Figma plugin is not connected. Open the plugin in Figma and connect it to the bridge.",
      });
    }
  });

  ws.on("close", () => {
    if (!channelId || !role) return;
    const ch = channels.get(channelId);
    if (ch && ch[role] === ws) {
      delete ch[role];
      const peerRole = role === "mcp" ? "plugin" : "mcp";
      const peer = ch[peerRole];
      if (peer && peer.readyState === WebSocket.OPEN) {
        send(peer, { type: "system", event: "peer_disconnected", message: role });
      }
      if (!ch.mcp && !ch.plugin) channels.delete(channelId);
    }
    console.error(`[bridge] ${role} left channel "${channelId}"`);
  });

  ws.on("error", (err) => {
    console.error(`[bridge] socket error (${role ?? "unjoined"}):`, err.message);
  });

  // Per-socket heartbeat.
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      clearInterval(heartbeat);
      return;
    }
    alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);

  ws.on("close", () => clearInterval(heartbeat));
});

wss.on("error", (err) => {
  console.error("[bridge] server error:", err.message);
  process.exit(1);
});
