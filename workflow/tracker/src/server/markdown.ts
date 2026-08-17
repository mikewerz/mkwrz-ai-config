import { parse, stringify } from "yaml";
import type { ParsedDocument, TicketFrontmatter } from "./domain.js";

export const LOG_START = "<!-- tracker:interaction-log:start -->";
export const LOG_END = "<!-- tracker:interaction-log:end -->";

export function parseDocument(markdown: string): ParsedDocument {
  const normalized = markdown.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new Error("Ticket must start with YAML frontmatter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) throw new Error("Ticket frontmatter is not terminated with ---");
  const raw = normalized.slice(4, end);
  const value = parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ticket frontmatter must be an object");
  return { frontmatter: value as Record<string, unknown>, body: normalized.slice(end + 5) };
}

export function serializeDocument(frontmatter: TicketFrontmatter, body: string): string {
  const yaml = stringify(frontmatter, { lineWidth: 0, nullStr: "null" }).trimEnd();
  return `---\n${yaml}\n---\n${ensureInteractionLog(body)}`;
}

export function ensureInteractionLog(body: string): string {
  let next = body;
  if (!next.endsWith("\n")) next += "\n";
  if (!next.includes(LOG_START) && !next.includes(LOG_END)) {
    next = `${next.trimEnd()}\n\n## Interaction Log\n\n${LOG_START}\n${LOG_END}\n`;
  }
  if (!next.includes(LOG_START) || !next.includes(LOG_END) || next.indexOf(LOG_START) > next.indexOf(LOG_END)) {
    throw new Error("Interaction Log markers are malformed");
  }
  return next;
}

export function appendEvent(body: string, sequence: number, timestamp: string, event: string, message: string): string {
  const safe = message.replaceAll("\n", " ").trim();
  const line = `- \`${String(sequence).padStart(6, "0")}\` \`${timestamp}\` **${event}** — ${safe}\n`;
  const prepared = ensureInteractionLog(body);
  return prepared.replace(LOG_END, `${line}${LOG_END}`);
}

export function interactionLog(body: string): string {
  const start = body.indexOf(LOG_START);
  const end = body.indexOf(LOG_END);
  if (start === -1 || end === -1 || end < start) return "";
  return body.slice(start + LOG_START.length, end).trim();
}
