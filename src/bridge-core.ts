/**
 * WebSocket relay that pairs the Figma plugin with the MCP server.
 *
 * The Figma plugin connects over a PRIVATE `gh codespace ports forward` tunnel
 * (loopback, GitHub-authenticated — never a public URL); the MCP connects over
 * localhost. Both authenticate with the shared token and join the same channel.
 * The relay then forwards every message between the two peers without persisting
 * anything — image bytes pass straight through RAM.
 *
 * This module exports the relay as a function so it can run standalone
 * (`bridge.ts`) or be embedded in the MCP process (`mcp.ts`, BRIDGE_EMBED=1).
 */
import { WebSocketServer, WebSocket } from "ws";

interface Channel {
  mcp?: WebSocket;
  plugin?: WebSocket;
}

export interface BridgeOptions {
  port: number;
  token: string;
  /** Bind host. Defaults to 0.0.0.0 so a tunnel can reach it. */
  host?: string;
  /** When false, suppresses the listening banner (used when embedded). */
  banner?: boolean;
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Start the relay. Returns the WebSocketServer (call .close() to stop). */
export function startBridgeServer(opts: BridgeOptions): WebSocketServer {
  const { port, token } = opts;
  const host = opts.host ?? "0.0.0.0";
  const channels = new Map<string, Channel>();

  const wss = new WebSocketServer({ port, host });

  wss.on("listening", () => {
    console.error(`[bridge] listening on ${host}:${port}`);
    if (opts.banner !== false) {
      console.error(`[bridge] from your LOCAL machine: gh codespace ports forward ${port}:${port} (private tunnel)`);
    }
  });

  wss.on("connection", (ws) => {
    let joined = false;
    let role: "mcp" | "plugin" | null = null;
    let channelId: string | null = null;

    let missed = 0;
    ws.on("pong", () => {
      missed = 0;
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
        if (msg.token !== token) {
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

        const existing = ch[r];
        if (existing && existing.readyState === WebSocket.OPEN) {
          send(existing, { type: "system", event: "error", message: "replaced by a newer connection" });
          existing.close(4002, "replaced");
        }
        ch[r] = ws;
        channels.set(cid, ch);
        joined = true;

        send(ws, { type: "system", event: "joined", message: `role=${r} channel=${cid}` });

        const peerRole = r === "mcp" ? "plugin" : "mcp";
        const peer = ch[peerRole];
        if (peer && peer.readyState === WebSocket.OPEN) {
          send(ws, { type: "system", event: "peer_connected", message: peerRole });
          send(peer, { type: "system", event: "peer_connected", message: r });
        }
        console.error(`[bridge] ${r} joined channel "${cid}"`);
        return;
      }

      // App-level keepalive: clients send this to keep the tunnel warm. Echo it
      // back, but never relay it to the peer.
      if (msg.type === "keepalive") {
        send(ws, { type: "keepalive" });
        return;
      }

      const ch = channelId ? channels.get(channelId) : undefined;
      if (!ch || !role) return;
      const peerRole = role === "mcp" ? "plugin" : "mcp";
      const peer = ch[peerRole];

      if (peer && peer.readyState === WebSocket.OPEN) {
        peer.send(raw.toString());
      } else if (role === "mcp" && msg.type === "request") {
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

    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // Tolerate one missed pong (a brief tunnel stall) before giving up.
      // Two strikes (~50s) keeps the plugin connected through transient blips.
      if (missed >= 2) {
        ws.terminate();
        clearInterval(heartbeat);
        return;
      }
      missed++;
      ws.ping();
    }, 25_000);

    ws.on("close", () => clearInterval(heartbeat));
  });

  wss.on("error", (err) => {
    console.error("[bridge] server error:", err.message);
  });

  return wss;
}
