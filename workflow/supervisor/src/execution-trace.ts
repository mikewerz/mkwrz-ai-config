import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecutionTraceEvent } from "./types.js";
import { log } from "./logger.js";

export interface ExecutionTraceTransport {
  appendExecutionTrace(lease: string, input: {
    traceId: string; firstSequence: number; events: ExecutionTraceEvent[]; completed?: boolean;
  }): Promise<{ next_sequence?: number }>;
}

export interface ExecutionTraceSink {
  record(event: string, data?: Record<string, unknown>): void;
}

function jsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[maximum depth]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code;
    return { name: value.name, message: value.message, code: typeof code === "string" ? code : null };
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => jsonSafe(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [key, jsonSafe(item, depth + 1)]));
  return String(value);
}

export class ExecutionTraceRecorder implements ExecutionTraceSink {
  readonly traceId: string;
  readonly spoolPath: string;
  private readonly startedAt = Date.now();
  private nextSequence = 1;
  private pending: ExecutionTraceEvent[] = [];
  private flushing: Promise<void> = Promise.resolve();
  private spoolWrite: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private lastObservation = "";

  constructor(
    private readonly transport: ExecutionTraceTransport,
    private readonly lease: string,
    spoolDirectory: string,
    private readonly context: Record<string, unknown>,
    private readonly batchSize = 64,
    private readonly flushIntervalMs = 30_000,
    traceId = randomUUID(),
  ) {
    this.traceId = traceId;
    this.spoolPath = join(spoolDirectory, `${traceId}.jsonl`);
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.spoolPath), { recursive: true });
    this.record("execution.trace_started", { schema_version: 1, trace_id: this.traceId, ...this.context });
    await this.flush();
  }

  record(event: string, data: Record<string, unknown> = {}): void {
    if (this.closed) return;
    const safe = jsonSafe(data) as Record<string, unknown>;
    if (event === "herdr.observation") {
      const fingerprint = JSON.stringify(safe);
      if (fingerprint === this.lastObservation) return;
      this.lastObservation = fingerprint;
    }
    const item: ExecutionTraceEvent = {
      sequence: this.nextSequence++, timestamp: new Date().toISOString(),
      elapsed_ms: Math.max(0, Date.now() - this.startedAt), event, data: safe,
    };
    this.pending.push(item);
    this.spoolWrite = this.spoolWrite.then(() => appendFile(this.spoolPath, `${JSON.stringify(item)}\n`, { encoding: "utf8", mode: 0o600 }))
      .catch((error) => log("warn", "execution_trace.spool_failed", { lease_id: this.lease, trace_id: this.traceId }, error));
    if (this.pending.length >= this.batchSize) void this.flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, this.flushIntervalMs);
      this.flushTimer.unref();
    }
  }

  async flush(completed = false): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flushing = this.flushing.then(async () => {
      while (this.pending.length) {
        const batch = this.pending.slice(0, this.batchSize);
        const finalBatch = (completed || batch.some((event) => event.event === "execution.trace_finished")) && batch.length === this.pending.length;
        try {
          const response = await this.transport.appendExecutionTrace(this.lease, {
            traceId: this.traceId, firstSequence: batch[0]!.sequence, events: batch,
            ...(finalBatch ? { completed: true } : {}),
          });
          if (response.next_sequence !== undefined && response.next_sequence !== batch.at(-1)!.sequence + 1) throw new Error(`Tracker acknowledged unexpected trace sequence ${response.next_sequence}`);
          this.pending.splice(0, batch.length);
        } catch (error) {
          log("warn", "execution_trace.flush_failed", { lease_id: this.lease, trace_id: this.traceId, first_sequence: batch[0]!.sequence }, error);
          break;
        }
      }
    });
    return this.flushing;
  }

  async close(disposition: string): Promise<void> {
    if (this.closed) return;
    this.record("execution.trace_finished", { disposition });
    this.closed = true;
    await this.spoolWrite;
    await this.flush(true);
  }
}
