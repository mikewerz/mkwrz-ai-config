import { describe, expect, it } from "vitest";
import { OperationalMonitor } from "./operations.js";

describe("OperationalMonitor", () => {
  it("records successful background operation timing and details", async () => {
    // Arrange
    const monitor = new OperationalMonitor();

    // Act
    const result = await monitor.run("artifact_maintenance", async () => ({ removed: 2 }), (value) => value);

    // Assert
    expect(result).toEqual({ removed: 2 });
    expect(monitor.snapshot().artifact_maintenance).toMatchObject({
      in_progress: false, last_started_at: expect.any(String), last_succeeded_at: expect.any(String),
      last_failed_at: null, last_duration_ms: expect.any(Number), last_error: null, details: { removed: 2 },
    });
  });

  it("retains the last failure without leaving the operation marked in progress", async () => {
    // Arrange
    const monitor = new OperationalMonitor();

    // Act
    const operation = monitor.run("github_observation", async () => { throw new Error("GitHub unavailable"); });

    // Assert
    await expect(operation).rejects.toThrow("GitHub unavailable");
    expect(monitor.snapshot().github_observation).toMatchObject({
      in_progress: false, last_failed_at: expect.any(String), last_error: "GitHub unavailable",
    });
  });
});
