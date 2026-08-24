import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { arch, hostname, platform, release } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ClaimedTicket } from "./types.js";

const execute = promisify(execFile);

async function git(path: string, args: string[]): Promise<string | null> {
  try { return (await execute("git", ["-C", path, ...args], { timeout: 15_000, maxBuffer: 2_000_000 })).stdout.trim(); }
  catch { return null; }
}

export async function captureRepositoryState(projectRoot: string, ticket: ClaimedTicket) {
  return Promise.all(ticket.frontmatter.repositories.map(async (repository) => {
    const path = join(projectRoot, repository.id);
    const [head, branch, remote, status, diff] = await Promise.all([
      git(path, ["rev-parse", "HEAD"]), git(path, ["branch", "--show-current"]),
      git(path, ["config", "--get", "remote.origin.url"]), git(path, ["status", "--porcelain=v1"]),
      git(path, ["diff", "--binary", "HEAD"]),
    ]);
    return {
      id: repository.id, primary: repository.primary, path, head_sha: head, branch: branch || null, remote_url: remote,
      dirty: Boolean(status), status_sha256: status === null ? null : createHash("sha256").update(status).digest("hex"),
      diff_sha256: diff === null ? null : createHash("sha256").update(diff).digest("hex"),
    };
  }));
}

export async function fileIdentity(path: string | null) {
  if (!path) return null;
  try {
    const content = await readFile(path);
    return { path, sha256: createHash("sha256").update(content).digest("hex"), size_bytes: content.byteLength };
  } catch { return { path, sha256: null, size_bytes: null }; }
}

export function supervisorRuntime(projectRoot: string) {
  return {
    hostname: hostname(), project_root: projectRoot,
    node_version: process.version, platform: platform(), platform_release: release(), architecture: arch(),
  };
}
