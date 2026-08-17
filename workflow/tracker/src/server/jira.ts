import { HttpError, type JiraRef, type TicketFrontmatter } from "./domain.js";
import type { JiraConfig } from "./config-store.js";

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    labels?: string[];
    updated?: string;
    priority?: { name?: string } | null;
  };
}

function adfText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const node = value as { text?: unknown; content?: unknown[]; type?: unknown };
  if (typeof node.text === "string") return node.text;
  const content = Array.isArray(node.content) ? node.content.map(adfText).join(node.type === "doc" ? "\n\n" : "") : "";
  return content.trim();
}

function toAdf(text: string): Record<string, unknown> {
  const paragraphs = text.trim().split(/\n{2,}/).filter(Boolean).map((paragraph) => ({
    type: "paragraph",
    content: [{ type: "text", text: paragraph.replace(/\n/g, " ") }],
  }));
  return { version: 1, type: "doc", content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [] }] };
}

export class JiraCloudClient {
  constructor(private readonly request: typeof fetch = fetch) {}

  private credentials(): { email: string; token: string } {
    const email = process.env.JIRA_EMAIL?.trim() ?? "";
    const token = process.env.JIRA_API_TOKEN?.trim() ?? "";
    if (!email || !token) throw new HttpError(503, "Jira is enabled but JIRA_EMAIL and JIRA_API_TOKEN are not configured");
    return { email, token };
  }

  private async call<T>(config: JiraConfig, path: string, init: RequestInit = {}): Promise<T> {
    if (!config.enabled) throw new HttpError(409, "Jira integration is disabled");
    const { email, token } = this.credentials();
    const response = await this.request(`${config.site_url}/rest/api/3${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        Accept: "application/json", "Content-Type": "application/json", ...init.headers,
      },
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new HttpError(response.status === 404 ? 404 : 502, `Jira Cloud request failed (${response.status})`, detail.slice(0, 1000));
    }
    return response.json() as Promise<T>;
  }

  async issue(config: JiraConfig, key: string): Promise<{ id: string; title: string; description: string; labels: string[]; source_updated_at: string | null; jira: JiraRef }> {
    const issue = await this.call<JiraIssue>(config, `/issue/${encodeURIComponent(key)}?fields=summary,description,labels,updated,priority`);
    const synced = new Date().toISOString();
    return {
      id: issue.key, title: issue.fields.summary?.trim() || issue.key, description: adfText(issue.fields.description), labels: issue.fields.labels ?? [],
      source_updated_at: issue.fields.updated ?? null,
      jira: { key: issue.key, issue_id: issue.id, url: `${config.site_url}/browse/${encodeURIComponent(issue.key)}`, last_synced_at: synced, source_updated_at: issue.fields.updated ?? null },
    };
  }

  async create(config: JiraConfig, ticket: TicketFrontmatter, description: string): Promise<JiraRef> {
    const created = await this.call<{ id: string; key: string }>(config, "/issue", {
      method: "POST",
      body: JSON.stringify({ fields: {
        project: { key: config.project_key }, issuetype: { name: config.issue_type }, summary: ticket.title,
        description: toAdf(`Tracker ticket: ${ticket.id}\n\n${description}`), labels: ticket.labels,
      } }),
    });
    return (await this.issue(config, created.key)).jira;
  }
}
