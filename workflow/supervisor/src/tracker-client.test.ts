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

  it("adds optional presentation hints to unrestricted evidence uploads", async () => {
    // Arrange
    const artifact = {
      id: "artifact-2", kind: "evidence", ticket_id: "AGENT-0001", node_run_id: "run-1",
      filename: "review.md", content_type: "text/markdown", size_bytes: 20, sha256: "b".repeat(64),
      created_at: "2026-08-20T12:00:00.000Z", metadata: { presentation: { title: "Review", featured: true } },
    };
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ artifact }));
    vi.stubGlobal("fetch", fetcher);
    const client = new TrackerClient("http://tracker.test", "worker-1", "process-1");

    // Act
    await client.uploadArtifact("lease-1", {
      kind: "evidence", filename: "review.md", contentType: "text/markdown", content: Buffer.from("# Review\n"),
      presentation: { title: "Review summary", description: "Approval evidence", category: "review", featured: true },
    });

    // Assert
    const [input] = fetcher.mock.calls[0]!;
    expect(Object.fromEntries((input as URL).searchParams)).toEqual({
      kind: "evidence", filename: "review.md", content_type: "text/markdown", title: "Review summary",
      description: "Approval evidence", category: "review", featured: "true",
    });
  });
});

describe("TrackerClient execution traces", () => {
  it("posts provider-neutral sequence-fenced trace batches", async () => {
    // Arrange
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ artifact: { id: "trace-artifact" }, next_sequence: 3 }, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const client = new TrackerClient("http://tracker.test", "worker-1", "process-1");
    const events = [
      { sequence: 1, timestamp: "2026-08-25T12:00:00.000Z", elapsed_ms: 0, event: "herdr.command_started", data: { command: "agent.prompt" } },
      { sequence: 2, timestamp: "2026-08-25T12:00:01.000Z", elapsed_ms: 1_000, event: "delivery.confirmed", data: { confirmation: "direct" } },
    ];

    // Act
    const result = await client.appendExecutionTrace("lease-1", {
      traceId: "11111111-1111-4111-8111-111111111111", firstSequence: 1, events, completed: true,
    });

    // Assert
    expect(result.next_sequence).toBe(3);
    const [input, init] = fetcher.mock.calls[0]!;
    expect((input as URL).pathname).toBe("/api/work/lease-1/trace/events");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(init!.body))).toEqual({
      trace_id: "11111111-1111-4111-8111-111111111111", first_sequence: 1, events, completed: true,
    });
  });
});

describe("TrackerClient provenance session evidence", () => {
  it("uploads post-callback transcript bytes with explicit provenance", async () => {
    const artifact = { id: "transcript-1", kind: "agent_transcript" };
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ artifact }, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const client = new TrackerClient("http://tracker.test", "worker-1", "process-1");
    const content = Buffer.from("agent transcript\n");

    const result = await client.uploadSessionEvidence("lease-1", {
      kind: "agent_transcript", filename: "implementation.herdr.txt", contentType: "text/plain", content,
      source: "herdr", completeness: "bounded", disposition: "callback", evidenceKey: "herdr:callback",
      provider: "claude", paneId: "w1:p1", sessionRef: "session-1", lineCount: 1,
    });

    expect(result).toEqual(artifact);
    const [input, init] = fetcher.mock.calls[0]!;
    const url = input as URL;
    expect(url.pathname).toBe("/api/work/lease-1/session-evidence");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      kind: "agent_transcript", source: "herdr", completeness: "bounded", disposition: "callback",
      evidence_key: "herdr:callback", provider: "claude", pane_id: "w1:p1", session_ref: "session-1", line_count: "1",
    });
    expect(Buffer.from(init!.body as Uint8Array)).toEqual(content);
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
