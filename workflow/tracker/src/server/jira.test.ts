import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraCloudClient } from "./jira.js";
import type { JiraConfig } from "./config-store.js";

const config: JiraConfig = { enabled: true, site_url: "https://example.atlassian.net", project_key: "ENG", issue_type: "Task" };

afterEach(() => vi.unstubAllEnvs());

describe("JiraCloudClient", () => {
  it("imports Jira Cloud ADF using the Jira key as the ticket ID", async () => {
    vi.stubEnv("JIRA_EMAIL", "agent@example.com"); vi.stubEnv("JIRA_API_TOKEN", "secret");
    const request = vi.fn(async () => Response.json({
      id: "10042", key: "ENG-42", fields: {
        summary: "Imported work", labels: ["backend"], updated: "2026-08-15T12:00:00.000+0000",
        description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Build the endpoint." }] }] },
      },
    }));
    const imported = await new JiraCloudClient(request as typeof fetch).issue(config, "ENG-42");
    expect(imported).toMatchObject({ id: "ENG-42", title: "Imported work", description: "Build the endpoint.", labels: ["backend"], jira: { key: "ENG-42", issue_id: "10042" } });
    expect(request).toHaveBeenCalledWith(expect.stringContaining("/rest/api/3/issue/ENG-42"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Basic /) }) }));
  });

  it("makes no request when Jira is disabled", async () => {
    const request = vi.fn();
    await expect(new JiraCloudClient(request as typeof fetch).issue({ ...config, enabled: false }, "ENG-42")).rejects.toMatchObject({ status: 409 });
    expect(request).not.toHaveBeenCalled();
  });
});
