#!/usr/bin/env node
/**
 * CLI entry so the package can be run from anywhere via npx, e.g.
 *   npx -y github:Rikuto-des/yasuda-figma-mcp mcp
 *
 * Subcommands:
 *   mcp     Run the MCP server (stdio). BRIDGE_EMBED=1 also hosts the bridge.
 *   bridge  Run the standalone bridge relay.
 *   tunnel  Open a private tunnel from local :3055 to your Codespace (runs gh).
 *   setup   Generate / print your per-user BRIDGE_TOKEN.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function usage(): void {
  console.error(
    [
      "yasuda-figma-mcp — secure, read-only Figma MCP (local render, no public S3)",
      "",
      "Usage:",
      "  yasuda-figma-mcp mcp      Run the MCP server (stdio). Set BRIDGE_EMBED=1 to also host the bridge.",
      "  yasuda-figma-mcp bridge   Run the standalone bridge relay.",
      "  yasuda-figma-mcp tunnel   Private tunnel local:3055 -> your Codespace (uses gh).",
      "  yasuda-figma-mcp setup    Generate / print your per-user BRIDGE_TOKEN.",
      "",
      "Env: BRIDGE_TOKEN (required for mcp/bridge), BRIDGE_PORT=3055,",
      "     BRIDGE_URL=ws://127.0.0.1:3055, BRIDGE_CHANNEL=default, BRIDGE_EMBED=1",
    ].join("\n"),
  );
}

function runScript(file: string, command: string, args: string[]): void {
  const path = fileURLToPath(new URL(`../scripts/${file}`, import.meta.url));
  const child = spawn(command, [path, ...args], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

const cmd = process.argv[2];

switch (cmd) {
  case "mcp":
    await import("./mcp.js");
    break;
  case "bridge":
    await import("./bridge.js");
    break;
  case "setup":
    runScript("setup.mjs", process.execPath, []);
    break;
  case "tunnel":
    runScript("tunnel.sh", "bash", process.argv.slice(3));
    break;
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
