import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
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
    expect(await store.start()).toMatchObject({
      version: 1, revision: 1, providers: { enabled: ["claude", "codex"] }, repositories: [],
      agent_profiles: { default: "claude", profiles: [
        { id: "claude", label: "Claude Opus", provider: "claude", model: "claude-opus-4-8", reasoning: "high" },
        { id: "codex", label: "Codex Sol", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" },
      ] },
      pricing: { estimate_missing_costs: true, models: [{ id: "openai-gpt-5-6-sol-standard-2026-08" }, { id: "anthropic-claude-opus-4-8-global-2026-08" }] },
      metrics: { human_day_rate_usd: 1_000, quota_account_aliases: {} },
      quality: { attributes: [] },
    });
    expect(await readFile(join(root, "tracker-config.yaml"), "utf8")).toContain("repositories: []");
  });

  it("persists editable pricing and the human day rate", async () => {
    const { store } = await createStore();
    const current = await store.start();
    const updated = await store.update({
      ...current,
      metrics: { human_day_rate_usd: 1_250, quota_account_aliases: { "worker-a": "personal-codex" } },
      pricing: { ...current.pricing, models: current.pricing.models.map((model) => model.provider === "codex" ? { ...model, output_per_million_usd: 31 } : model) },
    }, current.revision);
    expect(updated.metrics.human_day_rate_usd).toBe(1_250);
    expect(updated.metrics.quota_account_aliases).toEqual({ "worker-a": "personal-codex" });
    expect(updated.pricing.models.find((model) => model.provider === "codex")?.output_per_million_usd).toBe(31);
  });

  it("persists artifact lifecycle policy and rejects unsafe quota settings", async () => {
    // Arrange
    const { store } = await createStore();
    const current = await store.start();
    const artifacts = {
      max_total_bytes: 20 * 1024 ** 2, max_ticket_bytes: 4 * 1024 ** 2,
      orphan_grace_hours: 2, retention_days: 30, auto_gc_enabled: false, gc_interval_minutes: 15,
    };

    // Act
    const updated = await store.update({ ...current, artifacts }, current.revision);

    // Assert
    expect(updated.artifacts).toEqual(artifacts);
    await expect(store.update({ ...updated, artifacts: { ...artifacts, max_ticket_bytes: artifacts.max_total_bytes + 1 } }, updated.revision)).rejects.toMatchObject({ status: 422 });
    await expect(store.update({ ...updated, artifacts: { ...artifacts, auto_gc_enabled: "yes" } } as unknown as typeof updated, updated.revision)).rejects.toMatchObject({ status: 422 });
  });

  it("persists a typed quality registry and rejects duplicate keys", async () => {
    const { store } = await createStore();
    const current = await store.start();
    const attribute = { key: "coverage.line_percent", label: "Line coverage", type: "number" as const, unit: "percent", direction: "higher_is_better" as const, minimum: 0, maximum: 100 };
    const updated = await store.update({ ...current, quality: { attributes: [attribute] } }, current.revision);
    expect(updated.quality.attributes).toEqual([attribute]);
    await expect(store.update({ ...updated, quality: { attributes: [attribute, attribute] } }, updated.revision)).rejects.toMatchObject({ status: 422 });
  });

  it("persists numeric and categorical quality definitions without losing them during repository updates", async () => {
    // Arrange
    const { store } = await createStore();
    const current = await store.start();
    const attributes = [
      { key: "coverage.line_percent", label: "Line coverage", type: "number" as const, unit: "percent", direction: "higher_is_better" as const, minimum: 0, maximum: 100 },
      { key: "security.clean", label: "Security clean", type: "boolean" as const, unit: "", direction: "neutral" as const, minimum: null, maximum: null },
      { key: "release.risk", label: "Release risk", type: "string" as const, unit: "classification", direction: "neutral" as const, minimum: null, maximum: null },
    ];

    // Act
    const configured = await store.update({ ...current, quality: { attributes } }, current.revision);
    const repositoryUpdate = await store.updateRepositories([{ id: "demo", url: "https://example.test/demo.git" }], configured.revision);

    // Assert
    expect(repositoryUpdate.quality.attributes).toEqual(attributes);
  });

  it.each([
    ["unsafe key", { key: "Coverage Percent", label: "Coverage", type: "number", unit: "percent", direction: "higher_is_better", minimum: 0, maximum: 100 }],
    ["missing label", { key: "coverage.percent", label: "", type: "number", unit: "percent", direction: "higher_is_better", minimum: 0, maximum: 100 }],
    ["unsupported type", { key: "coverage.percent", label: "Coverage", type: "integer", unit: "percent", direction: "higher_is_better", minimum: 0, maximum: 100 }],
    ["unsupported direction", { key: "coverage.percent", label: "Coverage", type: "number", unit: "percent", direction: "sideways", minimum: 0, maximum: 100 }],
    ["directional categorical value", { key: "security.clean", label: "Security clean", type: "boolean", unit: "", direction: "higher_is_better", minimum: null, maximum: null }],
    ["inverted numeric bounds", { key: "coverage.percent", label: "Coverage", type: "number", unit: "percent", direction: "higher_is_better", minimum: 100, maximum: 0 }],
    ["non-finite bound", { key: "coverage.percent", label: "Coverage", type: "number", unit: "percent", direction: "higher_is_better", minimum: Number.NaN, maximum: 100 }],
    ["categorical bounds", { key: "release.risk", label: "Release risk", type: "string", unit: "classification", direction: "neutral", minimum: 0, maximum: 10 }],
  ])("rejects a quality definition with %s", async (_case, attribute) => {
    // Arrange
    const { store } = await createStore();
    const current = await store.start();

    // Act
    const action = store.update({ ...current, quality: { attributes: [attribute] } } as typeof current, current.revision);

    // Assert
    await expect(action).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a malformed or excessively large quality registry", async () => {
    // Arrange
    const { store } = await createStore();
    const current = await store.start();
    const definition = (index: number) => ({
      key: `metric.${index}`, label: `Metric ${index}`, type: "number" as const, unit: "count",
      direction: "neutral" as const, minimum: null, maximum: null,
    });

    // Act
    const malformed = store.update({ ...current, quality: { attributes: "invalid" } } as unknown as typeof current, current.revision);
    const oversized = store.update({ ...current, quality: { attributes: Array.from({ length: 201 }, (_, index) => definition(index)) } }, current.revision);

    // Assert
    await expect(malformed).rejects.toMatchObject({ status: 422 });
    await expect(oversized).rejects.toMatchObject({ status: 422 });
  });

  it("revision-fences concurrent quality registry updates", async () => {
    // Arrange
    const { store } = await createStore();
    const current = await store.start();
    const definition = (key: string) => ({
      key, label: key, type: "number" as const, unit: "count", direction: "neutral" as const, minimum: 0, maximum: null,
    });

    // Act
    const results = await Promise.allSettled([
      store.update({ ...current, quality: { attributes: [definition("tests.passed")] } }, current.revision),
      store.update({ ...current, quality: { attributes: [definition("tests.failed")] } }, current.revision),
    ]);
    const persisted = await store.read();

    // Assert
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) }),
    ]);
    expect(persisted.revision).toBe(current.revision + 1);
    expect(persisted.quality.attributes).toHaveLength(1);
  });

  it("upgrades only the exact previously shipped profile and Claude pricing defaults", async () => {
    const { root, store } = await createStore();
    const current = await store.start();
    await writeFile(join(root, "tracker-config.yaml"), stringify({
      ...current,
      agent_profiles: {
        default: "codex-default",
        profiles: [
          { id: "codex-default", label: "Codex default", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" },
          { id: "claude-default", label: "Claude default", provider: "claude", model: "claude-opus-4-6", reasoning: "high" },
          { id: "review", label: "Independent review", provider: "claude", model: "claude-opus-4-6", reasoning: "high" },
        ],
      },
      pricing: {
        ...current.pricing,
        models: current.pricing.models.map((entry) => entry.provider === "claude" ? {
          ...entry, id: "anthropic-claude-opus-4-6-global-2026-08", model: "claude-opus-4-6",
        } : entry),
      },
    }, { lineWidth: 0 }));
    const upgraded = await new TrackerConfigStore(root).read();
    expect(upgraded.agent_profiles).toMatchObject({ default: "claude", profiles: [{ id: "claude", model: "claude-opus-4-8" }, { id: "codex", model: "gpt-5.6-sol" }] });
    expect(upgraded.pricing.models.find((entry) => entry.provider === "claude")).toMatchObject({ id: "anthropic-claude-opus-4-8-global-2026-08", model: "claude-opus-4-8" });
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
