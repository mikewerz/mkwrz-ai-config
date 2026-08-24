import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

interface ArtifactVersionIndex {
  current_version: number;
  versions: Array<{ version: number; revision: string; created_at: string }>;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function artifactVersion(directory: string, id: string, revision: string): Promise<number> {
  const path = join(directory, ".versions", id, "index.json");
  let index: ArtifactVersionIndex = { current_version: 0, versions: [] };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ArtifactVersionIndex;
    if (Number.isInteger(parsed.current_version) && Array.isArray(parsed.versions)) index = parsed;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const existing = index.versions.find((entry) => entry.revision === revision);
  if (existing) return existing.version;
  const version = Math.max(index.current_version, ...index.versions.map((entry) => entry.version), 0) + 1;
  index.current_version = version;
  index.versions.push({ version, revision, created_at: new Date().toISOString() });
  await atomicWrite(path, `${JSON.stringify(index, null, 2)}\n`);
  return version;
}
