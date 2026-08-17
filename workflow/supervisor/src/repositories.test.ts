import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryReconciler, type CloneRepository } from "./repositories.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agentic-repositories-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("repository reconciliation", () => {
  it("leaves an existing repository path untouched", async () => {
    const target = join(root, "demo");
    await mkdir(target);
    await writeFile(join(target, "local.txt"), "keep me");
    const clone = vi.fn<CloneRepository>();

    await new RepositoryReconciler(root, clone).reconcile([{ id: "demo", url: "https://github.com/example/demo.git" }]);

    expect(clone).not.toHaveBeenCalled();
    expect(await readFile(join(target, "local.txt"), "utf8")).toBe("keep me");
  });

  it("clones through a temporary directory and publishes the completed checkout", async () => {
    const clone = vi.fn<CloneRepository>(async (_url, temporary) => {
      expect(temporary).not.toBe(join(root, "demo"));
      await mkdir(temporary);
      await writeFile(join(temporary, "README.md"), "ready");
    });

    await new RepositoryReconciler(root, clone).reconcile([{ id: "demo", url: "git@github.com:example/demo.git" }]);

    expect(await readFile(join(root, "demo", "README.md"), "utf8")).toBe("ready");
    expect((await readdir(root)).filter((name) => name.includes(".clone-"))).toEqual([]);
  });

  it("removes a failed partial clone and rejects unsafe targets", async () => {
    const clone = vi.fn<CloneRepository>(async (_url, temporary) => {
      await mkdir(temporary);
      await writeFile(join(temporary, "partial"), "incomplete");
      throw new Error("credentials unavailable");
    });
    const reconciler = new RepositoryReconciler(root, clone);

    await expect(reconciler.reconcile([{ id: "demo", url: "private:demo.git" }])).rejects.toThrow("credentials unavailable");
    expect(await readdir(root)).toEqual([]);
    await expect(reconciler.reconcile([{ id: "../escape", url: "private:escape.git" }])).rejects.toThrow("Unsafe repository directory ID");
  });
});
