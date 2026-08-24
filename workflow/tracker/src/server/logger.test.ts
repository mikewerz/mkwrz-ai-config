import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { log } from "./logger.js";

const cleanup: string[] = [];
const original = { LOG_FILE: process.env.LOG_FILE, LOG_LEVEL: process.env.LOG_LEVEL, LOG_MAX_BYTES: process.env.LOG_MAX_BYTES, LOG_MAX_FILES: process.env.LOG_MAX_FILES };

afterEach(async () => {
  for (const key of Object.keys(original) as Array<keyof typeof original>) {
    const value = original[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("structured logger", () => {
  it("filters by level and rotates bounded JSON log files", async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), "agentic-logger-")); cleanup.push(root);
    const path = join(root, "tracker.log");
    process.env.LOG_FILE = path;
    process.env.LOG_LEVEL = "info";
    process.env.LOG_MAX_BYTES = "300";
    process.env.LOG_MAX_FILES = "2";

    // Act
    log("debug", "filtered.event", { secret: "not-written" });
    for (let index = 0; index < 8; index += 1) log("info", "rotation.event", { index, payload: "x".repeat(100) });

    // Assert
    const files = await readdir(root);
    expect(files).toContain("tracker.log");
    expect(files).toContain("tracker.log.1");
    expect(files).not.toContain("tracker.log.3");
    const contents = await Promise.all(files.map((file) => readFile(join(root, file), "utf8")));
    expect(contents.join("\n")).not.toContain("filtered.event");
    expect(JSON.parse((await readFile(path, "utf8")).trim())).toMatchObject({ level: "info", service: "agentic-project-tracker", event: "rotation.event" });
  });
});
