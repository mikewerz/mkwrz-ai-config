import { describe, expect, it } from "vitest";
import { fetchWithDeadline } from "./network.js";

describe("fetchWithDeadline", () => {
  it("aborts a stalled upstream request with a stable error code", async () => {
    // Arrange
    const stalled = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;

    // Act
    const request = fetchWithDeadline(stalled, "https://upstream.test/resource", {}, 20);

    // Assert
    await expect(request).rejects.toMatchObject({ status: 504, code: "UPSTREAM_TIMEOUT" });
  });

  it("preserves caller cancellation while still enforcing a deadline", async () => {
    // Arrange
    const controller = new AbortController();
    const stalled = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;

    // Act
    const request = fetchWithDeadline(stalled, "https://upstream.test/resource", { signal: controller.signal }, 1_000);
    controller.abort();

    // Assert
    await expect(request).rejects.toMatchObject({ status: 504, code: "UPSTREAM_TIMEOUT" });
  });
});
