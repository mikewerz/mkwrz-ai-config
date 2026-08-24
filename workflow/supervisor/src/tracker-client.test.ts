import { afterEach, describe, expect, it, vi } from "vitest";
import { TrackerClient } from "./tracker-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("TrackerClient quality artifact uploads", () => {
  it("sends the declaration identity and exact report bytes to the tracker", async () => {
    // Arrange
    const artifact = {
      id: "artifact-1", kind: "quality_report", ticket_id: "AGENT-0001", node_run_id: "run-1",
      filename: "quality report.yaml", content_type: "application/yaml", size_bytes: 25, sha256: "a".repeat(64),
      created_at: "2026-08-20T12:00:00.000Z", metadata: {},
    };
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ artifact }));
    vi.stubGlobal("fetch", fetcher);
    const client = new TrackerClient("http://tracker.test", "worker-1", "process-1");
    const content = Buffer.from("schema: agentic-quality/v1\n");

    // Act
    const result = await client.uploadArtifact("lease-1", {
      kind: "quality_report",
      artifactName: "verification-quality",
      filename: "quality report.yaml",
      contentType: "application/yaml",
      content,
    });

    // Assert
    expect(result).toEqual(artifact);
    const [input, init] = fetcher.mock.calls[0]!;
    const url = input as URL;
    expect(url.pathname).toBe("/api/work/lease-1/artifacts");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: "quality_report",
      artifact_name: "verification-quality",
      filename: "quality report.yaml",
      content_type: "application/yaml",
    });
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/octet-stream" } });
    expect(Buffer.from(init!.body as Uint8Array)).toEqual(content);
  });

  it("surfaces tracker validation failures without reinterpreting them", async () => {
    // Arrange
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "QUALITY_REPORT_INVALID", error: "Quality report schema is invalid" }, { status: 422 })));
    const client = new TrackerClient("http://tracker.test", "worker-1", "process-1");

    // Act
    const action = client.uploadArtifact("lease-1", {
      kind: "quality_report", artifactName: "quality", filename: "quality.yaml", contentType: "application/yaml", content: Buffer.from("invalid"),
    });

    // Assert
    await expect(action).rejects.toMatchObject({ status: 422, code: "QUALITY_REPORT_INVALID", message: "Quality report schema is invalid" });
  });
});

describe("TrackerClient request deadlines", () => {
  it("fails a stalled tracker request with a stable timeout error", async () => {
    // Arrange
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const client = new TrackerClient("http://tracker.test", "worker-1", "process-1", { requestMs: 1_000 });

    // Act
    const request = client.config();

    // Assert
    await expect(request).rejects.toMatchObject({ status: 504, code: "TRACKER_TIMEOUT", message: "Tracker request timed out after 1000ms" });
  });
});
