import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ArtifactRecord, ArtifactKind, JsonValue } from "./domain.js";
import { HttpError } from "./domain.js";
import type { ArtifactPolicyConfig } from "./config-store.js";

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

const artifactKinds = new Set<ArtifactKind>(["attachment", "evidence", "script_output", "script_artifact", "quality_report", "checkpoint_bundle", "checkpoint_manifest", "execution_manifest", "execution_trace", "agent_transcript", "harness_session_log"]);
function artifactRecord(value: unknown): value is ArtifactRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && /^[0-9a-f-]{36}$/.test(record.id)
    && artifactKinds.has(record.kind as ArtifactKind)
    && typeof record.ticket_id === "string"
    && (record.node_run_id === null || typeof record.node_run_id === "string")
    && typeof record.filename === "string" && typeof record.content_type === "string"
    && Number.isSafeInteger(record.size_bytes) && Number(record.size_bytes) >= 0
    && typeof record.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256)
    && typeof record.created_at === "string" && !Number.isNaN(Date.parse(record.created_at))
    && Boolean(record.metadata) && typeof record.metadata === "object" && !Array.isArray(record.metadata);
}

async function atomicWrite(path: string, content: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, path);
    try { const directory = await open(dirname(path), "r"); await directory.sync(); await directory.close(); } catch { /* unsupported on some filesystems */ }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export class ArtifactStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, private readonly clock: () => Date = () => new Date()) {}

  private blobPath(digest: string): string { return join(this.root, ".artifacts", "blobs", "sha256", digest.slice(0, 2), digest); }
  private recordPath(id: string): string { return join(this.root, ".artifacts", "records", `${id}.json`); }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async records(): Promise<Array<{ path: string; record: ArtifactRecord }>> {
    const directory = join(this.root, ".artifacts", "records");
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records: Array<{ path: string; record: ArtifactRecord }> = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const path = join(directory, name);
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (artifactRecord(parsed)) records.push({ path, record: parsed });
      }
      catch { /* Reported separately by diagnostics. */ }
    }
    return records;
  }

  private async blobPaths(): Promise<string[]> {
    const root = join(this.root, ".artifacts", "blobs", "sha256");
    const output: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) output.push(path);
      }
    };
    await visit(root);
    return output;
  }

  private async assertQuota(ticketId: string, content: Buffer, policy?: ArtifactPolicyConfig): Promise<void> {
    if (!policy) return;
    const records = await this.records();
    const ticketBytes = records.filter(({ record }) => record.ticket_id === ticketId).reduce((sum, { record }) => sum + record.size_bytes, 0);
    if (ticketBytes + content.byteLength > policy.max_ticket_bytes) {
      throw new HttpError(413, `Artifact quota for ticket ${ticketId} would exceed ${policy.max_ticket_bytes} bytes`, { used_bytes: ticketBytes, requested_bytes: content.byteLength, limit_bytes: policy.max_ticket_bytes }, "ARTIFACT_TICKET_QUOTA_EXCEEDED");
    }
    const digest = sha256(content);
    let blobExists = true;
    try { await stat(this.blobPath(digest)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") blobExists = false; else throw error; }
    const totalBytes = (await Promise.all((await this.blobPaths()).map(async (path) => (await stat(path)).size)))
      .reduce((sum, size) => sum + size, 0);
    if (!blobExists && totalBytes + content.byteLength > policy.max_total_bytes) {
      throw new HttpError(413, `Artifact store quota would exceed ${policy.max_total_bytes} bytes`, { used_bytes: totalBytes, requested_bytes: content.byteLength, limit_bytes: policy.max_total_bytes }, "ARTIFACT_STORE_QUOTA_EXCEEDED");
    }
  }

  async put(input: {
    ticket_id: string; kind: ArtifactKind; filename: string; content_type: string; content: Buffer;
    node_run_id?: string | null; metadata?: Record<string, JsonValue>; policy?: ArtifactPolicyConfig;
  }): Promise<ArtifactRecord> {
    return this.serial(async () => {
      await this.assertQuota(input.ticket_id, input.content, input.policy);
      const digest = sha256(input.content);
      const blob = this.blobPath(digest);
      try { await stat(blob); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await atomicWrite(blob, input.content);
      }
      const record: ArtifactRecord = {
        id: randomUUID(), kind: input.kind, ticket_id: input.ticket_id,
        node_run_id: input.node_run_id ?? null, filename: input.filename,
        content_type: input.content_type, size_bytes: input.content.byteLength,
        sha256: digest, created_at: this.clock().toISOString(), metadata: input.metadata ?? {},
      };
      await atomicWrite(this.recordPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
      return record;
    });
  }

  async get(id: string): Promise<{ record: ArtifactRecord; content: Buffer }> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(422, "Artifact id is invalid", { artifact_id: id }, "ARTIFACT_ID_INVALID");
    let record: ArtifactRecord;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.recordPath(id), "utf8"));
      if (!artifactRecord(parsed)) throw new HttpError(409, `Artifact ${id} has an invalid record`, { artifact_id: id }, "ARTIFACT_RECORD_INVALID");
      record = parsed;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error(`Artifact ${id} was not found`), { code: "ENOENT" });
      throw error;
    }
    const content = await readFile(this.blobPath(record.sha256));
    if (content.byteLength !== record.size_bytes || sha256(content) !== record.sha256) throw new HttpError(409, `Artifact ${id} failed its integrity check`, { artifact_id: id }, "ARTIFACT_INTEGRITY_FAILED");
    return { record, content };
  }

  async deleteRecord(id: string): Promise<void> { await rm(this.recordPath(id), { force: true }); }

  async diagnose(referencedIds: Set<string>): Promise<ArtifactDiagnostics> {
    const recordsDirectory = join(this.root, ".artifacts", "records");
    let recordNames: string[] = [];
    try { recordNames = await readdir(recordsDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const invalid_records: Array<{ path: string; error: string }> = [];
    const records: ArtifactRecord[] = [];
    for (const name of recordNames.filter((item) => item.endsWith(".json"))) {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(recordsDirectory, name), "utf8"));
        if (!artifactRecord(parsed)) throw new Error("record does not match the artifact schema");
        records.push(parsed);
      }
      catch (error) { invalid_records.push({ path: join(".artifacts", "records", name), error: (error as Error).message }); }
    }
    const byId = new Map(records.map((record) => [record.id, record]));
    const missing_records = [...referencedIds].filter((id) => !byId.has(id));
    const orphan_records = records.filter((record) => !referencedIds.has(record.id));
    const missing_blobs: string[] = [];
    const corrupt_blobs: string[] = [];
    for (const record of records) {
      try {
        const content = await readFile(this.blobPath(record.sha256));
        if (content.byteLength !== record.size_bytes || sha256(content) !== record.sha256) corrupt_blobs.push(record.sha256);
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") missing_blobs.push(record.sha256); else throw error; }
    }
    const referencedDigests = new Set(records.map((record) => record.sha256));
    const blobs = await this.blobPaths();
    const orphan_blobs = blobs.filter((path) => !referencedDigests.has(basename(path))).map((path) => basename(path));
    const uniqueBytes = new Map(records.map((record) => [record.sha256, record.size_bytes]));
    const diskBlobBytes = (await Promise.all(blobs.map(async (path) => (await stat(path)).size))).reduce((sum, size) => sum + size, 0);
    return {
      generated_at: this.clock().toISOString(), record_count: records.length, referenced_record_count: referencedIds.size,
      logical_bytes: records.reduce((sum, record) => sum + record.size_bytes, 0),
      unique_blob_bytes: [...uniqueBytes.values()].reduce((sum, size) => sum + size, 0), disk_blob_bytes: diskBlobBytes,
      missing_records, invalid_records, orphan_records, missing_blobs: [...new Set(missing_blobs)],
      corrupt_blobs: [...new Set(corrupt_blobs)], orphan_blobs,
      healthy: missing_records.length === 0 && invalid_records.length === 0 && orphan_records.length === 0
        && missing_blobs.length === 0 && corrupt_blobs.length === 0 && orphan_blobs.length === 0,
    };
  }

  async collect(referencedIds: Set<string>, policy: ArtifactPolicyConfig): Promise<ArtifactCollectionResult> {
    return this.serial(async () => {
      const diagnostics = await this.diagnose(referencedIds);
      const now = this.clock().getTime();
      const graceMs = Math.max(policy.orphan_grace_hours * 60 * 60 * 1000, policy.retention_days * 24 * 60 * 60 * 1000);
      const removed_records: string[] = [];
      for (const record of diagnostics.orphan_records) {
        if (now - Date.parse(record.created_at) < graceMs) continue;
        await rm(this.recordPath(record.id), { force: true }); removed_records.push(record.id);
      }
      const remaining = await this.records();
      const remainingDigests = new Set(remaining.map(({ record }) => record.sha256));
      const removed_blobs: string[] = [];
      for (const path of await this.blobPaths()) {
        const digest = basename(path);
        if (remainingDigests.has(digest)) continue;
        const info = await stat(path);
        if (now - info.mtimeMs < graceMs) continue;
        await rm(path, { force: true }); removed_blobs.push(digest);
      }
      return { completed_at: this.clock().toISOString(), removed_records, removed_blobs };
    });
  }
}

export interface ArtifactDiagnostics {
  generated_at: string; record_count: number; referenced_record_count: number; logical_bytes: number; unique_blob_bytes: number; disk_blob_bytes: number;
  missing_records: string[]; invalid_records: Array<{ path: string; error: string }>; orphan_records: ArtifactRecord[];
  missing_blobs: string[]; corrupt_blobs: string[]; orphan_blobs: string[]; healthy: boolean;
}
export interface ArtifactCollectionResult { completed_at: string; removed_records: string[]; removed_blobs: string[] }
