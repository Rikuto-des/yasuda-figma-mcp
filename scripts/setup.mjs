#!/usr/bin/env node
/**
 * Per-user token setup. Generates (or reuses) a BRIDGE_TOKEN and makes it
 * available to the bridge and MCP server.
 *
 * Token source priority:
 *   1. `BRIDGE_TOKEN` already in the environment (e.g. a Codespaces secret) — authoritative, .env is left untouched.
 *   2. An existing `.env` — reused (idempotent).
 *   3. Otherwise a fresh random token is generated and written to `.env`.
 *
 * The printed token is what each developer pastes into the Figma plugin's
 * Token field. `.env` is gitignored; the token never enters the repo.
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const ENV = ".env";

function existingToken() {
  if (process.env.BRIDGE_TOKEN && process.env.BRIDGE_TOKEN.trim()) {
    return { token: process.env.BRIDGE_TOKEN.trim(), source: "environment / Codespaces secret" };
  }
  if (existsSync(ENV)) {
    const m = readFileSync(ENV, "utf8").match(/^\s*BRIDGE_TOKEN\s*=\s*(.+?)\s*$/m);
    if (m && m[1] && !/replace/i.test(m[1])) return { token: m[1].trim(), source: ".env (existing)" };
  }
  return null;
}

const found = existingToken();
const token = found ? found.token : randomBytes(24).toString("hex");
const source = found ? found.source : "newly generated";
const fromSecret = source.startsWith("environment");

let wroteEnv = false;
if (!fromSecret) {
  writeFileSync(ENV, `BRIDGE_TOKEN=${token}\nBRIDGE_PORT=3055\nBRIDGE_CHANNEL=default\n`);
  wroteEnv = true;
}

const line = "─".repeat(64);
console.log(`\n${line}`);
console.log("  yasuda-figma-mcp — token setup");
console.log(line);
console.log(`  Source : ${source}`);
console.log(`  .env   : ${wroteEnv ? "written (gitignored)" : "skipped — using the secret/env value"}`);
console.log(`\n  Bridge token  →  paste this into the Figma plugin's "Token" field:\n`);
console.log(`      ${token}\n`);
console.log("  Next steps:");
console.log("   1) npm run bridge                         # start the bridge (in this Codespace)");
console.log("   2) on your LOCAL machine:  npm run tunnel  # private tunnel, no public port");
console.log('   3) in Figma: run "Yasuda Figma MCP", paste the token, Connect');
console.log(`\n  Rotate the token anytime:  rm .env && npm run setup`);
console.log(`${line}\n`);
