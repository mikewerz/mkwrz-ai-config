import { describe, expect, it } from "vitest";
import { SupervisorRegistry } from "./supervisor-registry.js";

describe("SupervisorRegistry", () => {
  it("projects online and stale presence without losing ticket affinity", () => {
    let time = Date.parse("2026-08-14T12:00:00Z");
    const registry = new SupervisorRegistry(90_000, () => new Date(time));
    registry.heartbeat({
      supervisor_id: "vm-one", instance_id: "instance-one", hostname: "worker-one",
      ip_addresses: ["192.0.2.70"], project_root: "/srv/projects", herdr_session: "agents",
      providers: ["claude", "codex"], activity_capabilities: ["repository_action", "inline_shell"], started_at: new Date(time).toISOString(),
    });
    const ticket = {
      id: "APT-1", title: "Pinned work", phase: "implementation", status: "waiting_approval",
      assigned_supervisor: "vm-one",
    } as never;
    expect(registry.list([ticket])[0]).toMatchObject({ status: "online", assigned_ticket: { id: "APT-1" } });
    time += 90_001;
    expect(registry.list([ticket])[0]).toMatchObject({ status: "offline", assigned_ticket: { id: "APT-1" } });
    expect(registry.onlineProviders()).toEqual([]);
    expect(registry.unregister("vm-one", "wrong-instance")).toBe(false);
    expect(registry.unregister("vm-one", "instance-one")).toBe(true);
    expect(registry.list([ticket])).toEqual([]);
  });
});
