#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const input = await readFile(0, "utf8");
const snapshot = JSON.parse(input);
const sessionId = typeof snapshot.session_id === "string" && /^[A-Za-z0-9._-]+$/.test(snapshot.session_id)
  ? snapshot.session_id : null;

if (sessionId) {
  const root = process.env.AGENTIC_TELEMETRY_ROOT || join(homedir(), ".agentic-project-supervisor", "telemetry");
  const directory = join(root, "claude");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = join(directory, `${sessionId}.json`);
  const temporary = join(directory, `.${sessionId}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ ...snapshot, captured_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

if (process.env.CLAUDE_TELEMETRY_STATUSLINE_QUIET !== "1") {
  const model = snapshot.model?.display_name || snapshot.model?.id || "Claude";
  const context = Number.isFinite(snapshot.context_window?.used_percentage) ? `ctx ${snapshot.context_window.used_percentage}%` : null;
  const cost = Number.isFinite(snapshot.cost?.total_cost_usd) ? `$${snapshot.cost.total_cost_usd.toFixed(4)}` : null;
  const effort = snapshot.effort?.level || null;
  process.stdout.write([model, effort, context, cost].filter(Boolean).join(" · "));
}
