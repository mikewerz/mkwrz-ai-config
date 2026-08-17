import { HttpError, type PullRequestObservation, type PullRequestRef } from "./domain.js";
import type { TrackerConfigStore } from "./config-store.js";
import type { TicketStore } from "./ticket-store.js";

interface GithubUser { login?: string; type?: string }
interface GithubComment { id: number; body?: string; user?: GithubUser }
interface GithubReview extends GithubComment { state?: string }
interface GithubPull { state: string; draft: boolean; merged: boolean; mergeable: boolean | null; user?: GithubUser }

function coordinates(url: string): { owner: string; repo: string; number: number } {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") throw new HttpError(422, "Only standard github.com pull requests can be observed");
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) throw new HttpError(422, `Invalid GitHub pull request URL: ${url}`);
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

export class GithubObserver {
  constructor(private readonly store: TicketStore, private readonly configs: TrackerConfigStore, private readonly request: typeof fetch = fetch) {}

  private async get<T>(path: string): Promise<T> {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) throw new HttpError(503, "GitHub observation requires GITHUB_TOKEN");
    const response = await this.request(`https://api.github.com${path}`, { headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
    } });
    if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, `GitHub request failed (${response.status})`, (await response.text()).slice(0, 1000));
    return response.json() as Promise<T>;
  }

  private ignored(user: GithubUser | undefined, ignored: Set<string>): boolean {
    return !user?.login || user.type === "Bot" || ignored.has(user.login.toLowerCase());
  }

  private async observe(pr: PullRequestRef, ignored: Set<string>, includeExistingFeedback = false): Promise<{ observation: PullRequestObservation; actionable: string[] }> {
    const { owner, repo, number } = coordinates(pr.url);
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const [pull, issueComments, reviewComments, reviews] = await Promise.all([
      this.get<GithubPull>(`${base}/pulls/${number}`),
      this.get<GithubComment[]>(`${base}/issues/${number}/comments?per_page=100`),
      this.get<GithubComment[]>(`${base}/pulls/${number}/comments?per_page=100`),
      this.get<GithubReview[]>(`${base}/pulls/${number}/reviews?per_page=100`),
    ]);
    const prior = pr.observation;
    const ignoredForPull = new Set(ignored);
    if (pull.user?.login) ignoredForPull.add(pull.user.login.toLowerCase());
    const humanIssues = issueComments.filter((item) => !this.ignored(item.user, ignoredForPull));
    const humanReviewComments = reviewComments.filter((item) => !this.ignored(item.user, ignoredForPull));
    const humanReviews = reviews.filter((item) => !this.ignored(item.user, ignoredForPull));
    const max = <T extends { id: number }>(items: T[]) => items.reduce((value, item) => Math.max(value, item.id), 0);
    const actionable: string[] = [];
    if (prior || includeExistingFeedback) {
      const lastIssueCommentId = prior?.last_issue_comment_id ?? 0;
      const lastReviewCommentId = prior?.last_review_comment_id ?? 0;
      const lastReviewId = prior?.last_review_id ?? 0;
      for (const item of humanIssues.filter((candidate) => candidate.id > lastIssueCommentId)) actionable.push(`PR comment from ${item.user?.login}: ${(item.body ?? "").slice(0, 500)}`);
      for (const item of humanReviewComments.filter((candidate) => candidate.id > lastReviewCommentId)) actionable.push(`Review comment from ${item.user?.login}: ${(item.body ?? "").slice(0, 500)}`);
      for (const item of humanReviews.filter((candidate) => candidate.id > lastReviewId && candidate.state === "CHANGES_REQUESTED")) actionable.push(`GitHub review requested changes by ${item.user?.login}.`);
    }
    if (pull.mergeable === false && !prior?.merge_conflict_reported) actionable.push("GitHub reports that the pull request has merge conflicts.");
    return {
      observation: {
        checked_at: new Date().toISOString(), state: pull.state, draft: pull.draft, merged: pull.merged, mergeable: pull.mergeable,
        last_issue_comment_id: max(humanIssues), last_review_comment_id: max(humanReviewComments), last_review_id: max(humanReviews),
        merge_conflict_reported: pull.mergeable === false,
      },
      actionable,
    };
  }

  async checkTicket(id: string): Promise<{ checked: number; reopened: boolean }> {
    const config = await this.configs.read();
    const current = await this.store.get(id);
    const ticket = current.frontmatter;
    if (!current.valid || !ticket) throw new HttpError(422, "Ticket is invalid", current.errors);
    if (ticket.archived_at) throw new HttpError(409, "Archived tickets are not observed");
    const completedWork = ticket.phase === "done" && ticket.status === "completed";
    const specificationApproval = ticket.phase === "specification" && ticket.status === "waiting_approval";
    if (!completedWork && !specificationApproval) throw new HttpError(409, "Only completed tickets or specifications waiting for approval can be checked for PR follow-up");
    const pullRequests = specificationApproval
      ? ticket.pull_requests.filter((pr) => pr.phase === undefined || pr.phase === "specification")
      : ticket.pull_requests;
    if (pullRequests.length === 0) return { checked: 0, reopened: false };
    const ignored = new Set(config.github.ignored_logins.map((item) => item.toLowerCase()));
    const results = await Promise.all(pullRequests.map(async (pr) => ({ pr, result: await this.observe(pr, ignored, specificationApproval) })));
    const actionable = results.flatMap(({ pr, result }) => result.actionable.map((item) => `${pr.url}: ${item}`));
    await this.store.command(id, {
      event: actionable.length ? specificationApproval ? "github.specification_follow_up_found" : "github.follow_up_found" : "github.pull_requests_checked",
      message: actionable.length ? actionable.join(" ") : `Checked ${results.length} pull request(s); no new follow-up was found.`,
      expectedRevision: ticket.revision,
    }, (next) => {
      const observations = new Map(results.map(({ pr, result }) => [pr.url, result.observation]));
      next.pull_requests = next.pull_requests.map((pr) => ({ ...pr, observation: observations.get(pr.url) ?? pr.observation ?? null }));
      if (actionable.length) {
        next.phase = specificationApproval ? "specification" : "implementation";
        next.status = "ready";
        next.archived_at = null;
      }
      return { ticket: next };
    });
    return { checked: results.length, reopened: actionable.length > 0 };
  }

  async checkAll(): Promise<void> {
    const config = await this.configs.read();
    if (!config.github.observation_enabled) return;
    const tickets = await this.store.summaries(false);
    for (const ticket of tickets.filter((item) => item.valid && ((item.phase === "done" && item.status === "completed")
      || (item.phase === "specification" && item.status === "waiting_approval")))) {
      try { await this.checkTicket(ticket.id); } catch (error) { console.error(`[github] observation failed for ${ticket.id}`, error); }
    }
  }
}
