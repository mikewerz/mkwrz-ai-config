import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { RepositoryConfig } from "./types.js";
import { log } from "./logger.js";

export type CloneRepository = (url: string, target: string) => Promise<void>;

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export const cloneWithGit: CloneRepository = (url, target) => new Promise((resolveClone, reject) => {
  const child = spawn("git", ["clone", "--", url, target], { stdio: ["ignore", "inherit", "inherit"] });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolveClone();
    else reject(new Error(`git clone failed for ${url} (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`})`));
  });
});

export interface RepositoryReconcilerLike {
  reconcile(repositories: RepositoryConfig[]): Promise<void>;
}

export class RepositoryReconciler implements RepositoryReconcilerLike {
  readonly root: string;

  constructor(projectRoot: string, private readonly clone: CloneRepository = cloneWithGit) {
    this.root = resolve(projectRoot);
  }

  async reconcile(repositories: RepositoryConfig[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const repository of repositories) await this.ensure(repository);
  }

  private async ensure(repository: RepositoryConfig): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository.id) || repository.id === "." || repository.id === "..") {
      throw new Error(`Unsafe repository directory ID: ${repository.id}`);
    }
    const target = resolve(this.root, repository.id);
    if (!target.startsWith(this.root + sep)) throw new Error(`Repository target escapes project root: ${repository.id}`);
    if (await exists(target)) return;

    const temporary = resolve(this.root, `.${basename(target)}.clone-${randomUUID()}.tmp`);
    try {
      await this.clone(repository.url, temporary);
      await rename(temporary, target);
      log("info", "repository.cloned", { repository: repository.id, target });
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (await exists(target)) return;
      throw error;
    }
  }
}
