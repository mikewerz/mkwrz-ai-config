import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

const ranks: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let fileState: { path: string; size: number } | null = null;

function configuredLevel(): LogLevel {
  const value = process.env.LOG_LEVEL?.trim().toLowerCase();
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function rotate(path: string, maximumFiles: number): void {
  for (let index = maximumFiles - 1; index >= 1; index -= 1) {
    try { renameSync(`${path}.${index}`, `${path}.${index + 1}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  try { renameSync(path, `${path}.1`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { rmSync(`${path}.${maximumFiles + 1}`, { force: true }); } catch { /* best effort */ }
}

function write(line: string, level: LogLevel): void {
  const configured = process.env.LOG_FILE?.trim();
  if (!configured) {
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
    return;
  }
  const path = resolve(configured);
  try {
    if (!fileState || fileState.path !== path) {
      mkdirSync(dirname(path), { recursive: true });
      let size = 0;
      try { size = statSync(path).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      fileState = { path, size };
    }
    const bytes = Buffer.byteLength(line);
    const maximumBytes = positiveInteger(process.env.LOG_MAX_BYTES, 10 * 1024 * 1024);
    const maximumFiles = positiveInteger(process.env.LOG_MAX_FILES, 5);
    if (fileState.size > 0 && fileState.size + bytes > maximumBytes) {
      rotate(path, maximumFiles);
      fileState.size = 0;
    }
    appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    fileState.size += bytes;
  } catch (error) {
    process.stderr.write(`${line.trimEnd()} ${JSON.stringify({ log_write_error: (error as Error).message })}\n`);
  }
}

function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  return {
    error: error.message, error_name: error.name,
    ...(error.stack ? { stack: error.stack } : {}),
    ...("code" in error ? { error_code: (error as Error & { code?: unknown }).code } : {}),
  };
}

export function log(level: LogLevel, event: string, context: LogContext = {}, error?: unknown): void {
  if (ranks[level] < ranks[configuredLevel()]) return;
  const line = JSON.stringify({
    timestamp: new Date().toISOString(), level, service: "agentic-project-supervisor", event,
    ...context, ...(error === undefined ? {} : errorFields(error)),
  });
  write(`${line}\n`, level);
}
