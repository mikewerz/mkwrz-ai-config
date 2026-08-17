import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrackerConfigStore } from "./config-store.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "tracker-config-"));
  roots.push(root);
  return { root, store: new TrackerConfigStore(root, () => new Date("2026-08-14T12:00:00Z")) };
}

describe("TrackerConfigStore", () => {
  it("creates a valid empty YAML configuration in the ticket root", async () => {
    const { root, store } = await createStore();
    expect(await store.start()).toMatchObject({ version: 1, revision: 1, providers: { enabled: ["claude", "codex"] }, repositories: [] });
    expect(await readFile(join(root, "tracker-config.yaml"), "utf8")).toContain("repositories: []");
  });

  it("atomically updates repositories while preserving future top-level settings", async () => {
    const { root, store } = await createStore();
    await writeFile(join(root, "tracker-config.yaml"), [
      "version: 1", "revision: 4", "updated_at: 2026-08-14T11:00:00Z", "future_setting: keep-me", "repositories: []", "",
    ].join("\n"));
    const updated = await store.updateRepositories([{ id: "demo-api", url: "git@github.com:example/demo-api.git" }], 4);
    expect(updated).toMatchObject({ revision: 5, future_setting: "keep-me", providers: { enabled: ["claude", "codex"] }, repositories: [{ id: "demo-api" }] });
    await expect(store.updateRepositories([], 4)).rejects.toMatchObject({ status: 409 });
  });

  it("persists enabled work providers and rejects an empty selection", async () => {
    const { store } = await createStore();
    const current = await store.start();
    const updated = await store.update({ ...current, providers: { enabled: ["claude", "codex"] } }, current.revision);
    expect(updated.providers.enabled).toEqual(["claude", "codex"]);
    await expect(store.update({ ...updated, providers: { enabled: [] } }, updated.revision)).rejects.toMatchObject({ status: 422 });
  });

  it("rejects unsafe directories and duplicate repository URLs", async () => {
    const { store } = await createStore();
    await store.start();
    await expect(store.updateRepositories([{ id: "../escape", url: "https://example.test/repo.git" }], 1)).rejects.toMatchObject({ status: 422 });
    await expect(store.updateRepositories([
      { id: "one", url: "https://example.test/repo.git" }, { id: "two", url: "https://example.test/repo.git" },
    ], 1)).rejects.toMatchObject({ status: 422 });
  });

  it("allocates durable AGENT identifiers without reusing them", async () => {
    const { store } = await createStore();
    await store.start();
    expect(await store.previewTicketId()).toBe("AGENT-0001");
    expect(await Promise.all([store.allocateTicketId(), store.allocateTicketId()])).toEqual(["AGENT-0001", "AGENT-0002"]);
    expect(await store.previewTicketId()).toBe("AGENT-0003");
    expect((await store.read()).tickets.next_number).toBe(3);
    expect(await store.previewTicketId(["AGENT-0003", "AGENT-0004"])).toBe("AGENT-0005");
  });
});
