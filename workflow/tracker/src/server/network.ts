import { HttpError } from "./domain.js";

export const DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS = 15_000;

export function requestTimeoutMs(configured = process.env.EXTERNAL_REQUEST_TIMEOUT_MS): number {
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 ? parsed : DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS;
}

export async function fetchWithDeadline(
  request: typeof fetch,
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = requestTimeoutMs(),
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await request(input, { ...init, signal });
  } catch (error) {
    if (signal.aborted) throw new HttpError(504, `Upstream request timed out after ${timeoutMs}ms`, undefined, "UPSTREAM_TIMEOUT");
    throw error;
  }
}
