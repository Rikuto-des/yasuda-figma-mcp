/**
 * Standalone bridge entry point. Reads config from the environment and starts
 * the relay (see bridge-core.ts). For the embedded variant, the MCP server
 * starts the same relay in-process when BRIDGE_EMBED is set.
 */
import { startBridgeServer } from "./bridge-core.js";
import { DEFAULT_PORT } from "./protocol.js";

const PORT = Number(process.env.BRIDGE_PORT ?? DEFAULT_PORT);
const TOKEN = process.env.BRIDGE_TOKEN;

if (!TOKEN) {
  console.error("[bridge] BRIDGE_TOKEN is required (set it in .env or the environment).");
  process.exit(1);
}

const wss = startBridgeServer({ port: PORT, token: TOKEN });
wss.on("error", () => process.exit(1));
