import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { PromptStore } from "./prompts.js";
import type { ClaimedTicket, Guidance } from "./types.js";

export interface AssignmentBundle {
  root: string;
  ticketDirectory: string;
  runDirectory: string;
  startHerePath: string;
  callbackHelperPath: string;
  artifactHelperPath: string;
  attachmentsDirectory: string;
}

interface CallbackConfiguration {
  schema_version: 1;
  ticket_id: string;
  node_id: string;
  lease_id: string;
  callback_base: string;
  endpoints: { comment: string; ask: string; complete: string; fail: string; metadata: string; candidates: string; artifacts: string };
  allowed_outcomes: Array<{ id: string; label: string; description: string }>;
  schemas: Record<string, unknown>;
}

async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

async function callbackHelperProgram(): Promise<void> {
  // Keep the generated helper independent of the supervisor's module loader.
  // A Function-wrapped import remains valid when this function is serialized by
  // tsc, tsx, or Vitest and the extensionless helper is launched directly.
  const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
  const { mkdir, readFile, writeFile } = await load("node:fs/promises") as unknown as typeof import("node:fs/promises");
  const { dirname, join } = await load("node:path") as unknown as typeof import("node:path");
  const helperFile = process.argv[1];
  if (!helperFile) throw new Error("Cannot determine the callback helper path");
  const configurationFile = join(dirname(helperFile), "callbacks.json");
  const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
  const [command, ...args] = process.argv.slice(2);
  const usage = () => {
    console.error("Usage:");
    console.error("  ./callback schema [complete|ask|fail|comment|metadata-put|candidates]");
    console.error("  ./callback complete <payload.json|->");
    console.error("  ./callback ask <payload.json|->");
    console.error("  ./callback fail <payload.json|->");
    console.error("  ./callback comment <payload.json|->");
    console.error("  ./callback metadata get [key]");
    console.error("  ./callback metadata put <key> <value.json|->");
    console.error("  ./callback emit-candidates <payload.json|->");
  };
  const readPayload = async (path: string | undefined) => {
    if (!path) throw new Error("A JSON payload file is required. Use '-' to read stdin.");
    const text = path === "-" ? await new Promise<string>((accept, reject) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk; });
      process.stdin.on("end", () => accept(value));
      process.stdin.on("error", reject);
    }) : await readFile(path, "utf8");
    return JSON.parse(text);
  };
  const send = async (method: string, url: string, body?: unknown) => {
    const outbox = join(dirname(configurationFile), "outbox");
    await mkdir(outbox, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const requestPath = join(outbox, `${id}.request.json`);
    await writeFile(requestPath, `${JSON.stringify({ created_at: new Date().toISOString(), method, url, body: body ?? null }, null, 2)}\n`);
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* retain response text */ }
    await writeFile(join(outbox, `${id}.response.json`), `${JSON.stringify({ status: response.status, ok: response.ok, body: parsed }, null, 2)}\n`);
    if (!response.ok) throw new Error(`Tracker returned HTTP ${response.status}: ${text}`);
    if (text) process.stdout.write(`${text}\n`);
  };

  try {
    if (command === "schema") {
      const schema = args[0] ? configuration.schemas[args[0]] : configuration.schemas;
      if (schema === undefined) throw new Error(`Unknown schema ${args[0]}`);
      process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
      return;
    }
    if (command && ["complete", "ask", "fail", "comment"].includes(command)) {
      const payload = await readPayload(args[0]);
      if (command === "complete" && !configuration.allowed_outcomes.some((outcome: { id: string }) => outcome.id === payload?.outcome)) {
        throw new Error(`complete outcome must be one of: ${configuration.allowed_outcomes.map((outcome: { id: string }) => outcome.id).join(", ")}`);
      }
      await send("POST", configuration.endpoints[command as "complete" | "ask" | "fail" | "comment"], payload);
      return;
    }
    if (command === "metadata" && args[0] === "get") {
      const url = args[1] ? `${configuration.endpoints.metadata}/${encodeURIComponent(args[1])}` : configuration.endpoints.metadata;
      await send("GET", url);
      return;
    }
    if (command === "metadata" && args[0] === "put") {
      if (!args[1]) throw new Error("metadata put requires a key");
      const value = await readPayload(args[2]);
      await send("PUT", `${configuration.endpoints.metadata}/${encodeURIComponent(args[1])}`, { value });
      return;
    }
    if (command === "emit-candidates") {
      await send("POST", configuration.endpoints.candidates, await readPayload(args[0]));
      return;
    }
    usage();
    process.exitCode = 2;
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

function callbackHelperSource(): string {
  return `#!/usr/bin/env node\n${callbackHelperProgram.toString()}\ncallbackHelperProgram().catch((error) => { console.error(error?.message ?? String(error)); process.exitCode = 1; });\n`;
}

async function artifactHelperProgram(): Promise<void> {
  const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
  const { mkdir, readFile, writeFile } = await load("node:fs/promises") as unknown as typeof import("node:fs/promises");
  const { basename, dirname, extname, join } = await load("node:path") as unknown as typeof import("node:path");
  const helperFile = process.argv[1];
  if (!helperFile) throw new Error("Cannot determine the artifact helper path");
  const configurationFile = join(dirname(helperFile), "callbacks.json");
  const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
  const [path, ...rawOptions] = process.argv.slice(2);
  if (!path || path === "--help") {
    console.error("Usage: ./publish-artifact <file> [--title TEXT] [--description TEXT] [--category TEXT] [--content-type MIME] [--featured]");
    process.exitCode = path ? 0 : 2;
    return;
  }
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rawOptions.length; index += 1) {
    const option = rawOptions[index]!;
    if (option === "--featured") { options.featured = true; continue; }
    if (!["--title", "--description", "--category", "--content-type"].includes(option)) throw new Error(`Unknown option ${option}`);
    const value = rawOptions[++index];
    if (!value) throw new Error(`${option} requires a value`);
    options[option.slice(2)] = value;
  }
  const filename = basename(path);
  if (!filename) throw new Error("Artifact path must name a file");
  const extension = extname(filename).toLowerCase();
  const inferred: Record<string, string> = {
    ".md": "text/markdown", ".markdown": "text/markdown", ".html": "text/html", ".htm": "text/html",
    ".txt": "text/plain", ".log": "text/plain", ".json": "application/json", ".yaml": "application/yaml", ".yml": "application/yaml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  };
  const contentType = String(options["content-type"] ?? inferred[extension] ?? "application/octet-stream");
  if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(contentType)) throw new Error("--content-type must be a MIME type without parameters");
  const query = new URLSearchParams({ kind: "evidence", filename, content_type: contentType });
  for (const key of ["title", "description", "category"] as const) if (typeof options[key] === "string") query.set(key, options[key]);
  if (options.featured === true) query.set("featured", "true");
  const url = `${configuration.endpoints.artifacts}?${query}`;
  const content = await readFile(path);
  const outbox = join(dirname(configurationFile), "outbox");
  await mkdir(outbox, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(join(outbox, `${id}.artifact.request.json`), `${JSON.stringify({ created_at: new Date().toISOString(), method: "POST", url, file: path, bytes: content.byteLength }, null, 2)}\n`);
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: content });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* retain response text */ }
  await writeFile(join(outbox, `${id}.artifact.response.json`), `${JSON.stringify({ status: response.status, ok: response.ok, body: parsed }, null, 2)}\n`);
  if (!response.ok) throw new Error(`Tracker returned HTTP ${response.status}: ${text}`);
  if (text) process.stdout.write(`${text}\n`);
}

function artifactHelperSource(): string {
  return `#!/usr/bin/env node\n${artifactHelperProgram.toString()}\nartifactHelperProgram().catch((error) => { console.error(error?.message ?? String(error)); process.exitCode = 1; });\n`;
}

export function assignmentValues(ticket: ClaimedTicket, callbackBaseUrl: string, projectRoot: string): Record<string, string> {
  const lease = ticket.frontmatter.execution.lease_id;
  const node = ticket.workflow_node;
  const outputLog = ticket.frontmatter.workflow.incoming?.output_log_path;
  const outputLogUrls = outputLog ? outputLog.split("\n").filter(Boolean).map((path) => new URL(path, callbackBaseUrl).toString()).join("\n") : "No persisted output log.";
  return {
    ticket_id: ticket.frontmatter.id,
    phase: ticket.frontmatter.phase,
    callback_base: new URL(`/api/work/${lease}/`, callbackBaseUrl).toString(),
    node_id: node.id,
    node_name: node.name,
    allowed_outcomes: node.outcomes.map((outcome) => `- ${outcome.id}: ${outcome.label}${outcome.description ? ` — ${outcome.description}` : ""}`).join("\n"),
    incoming_outcome: ticket.frontmatter.workflow.incoming?.outcome ?? "none",
    incoming_summary: ticket.frontmatter.workflow.incoming?.summary ?? "No prior transition summary.",
    incoming_handoff: ticket.frontmatter.workflow.incoming?.handoff ?? "No explicit handoff message.",
    incoming_node: ticket.frontmatter.workflow.incoming?.source_node ?? "none",
    incoming_output: ticket.frontmatter.workflow.incoming?.output ?? "No inline output was configured.",
    incoming_output_log: outputLogUrls,
    ticket_path: ticket.path,
    ticket_markdown: ticket.markdown,
    project_root: projectRoot,
  };
}

function callbackConfiguration(ticket: ClaimedTicket, callbackBaseUrl: string): CallbackConfiguration {
  const base = new URL(`/api/work/${ticket.frontmatter.execution.lease_id}/`, callbackBaseUrl).toString();
  const allowed = ticket.workflow_node.outcomes;
  return {
    schema_version: 1,
    ticket_id: ticket.frontmatter.id,
    node_id: ticket.workflow_node.id,
    lease_id: ticket.frontmatter.execution.lease_id,
    callback_base: base,
    endpoints: {
      comment: new URL("comment", base).toString(), ask: new URL("ask", base).toString(),
      complete: new URL("complete", base).toString(), fail: new URL("fail", base).toString(), metadata: new URL("metadata", base).toString(), candidates: new URL("candidates", base).toString(), artifacts: new URL("artifacts", base).toString(),
    },
    allowed_outcomes: allowed.map(({ id, label, description }) => ({ id, label, description })),
    schemas: {
      complete: { outcome: allowed[0]?.id ?? "completed", summary: "Work performed, decisions, and verification.", handoff: "Actionable context for the next node, if any.", pull_requests: [{ repository: "repository-id", url: "https://github.com/owner/repository/pull/123" }] },
      ask: { questions: [{ question: "Focused question", options: ["Optional suggestion"] }] },
      fail: { reason: "Concrete blocker or unrecoverable failure." },
      comment: { message: "Concise durable progress note or decision." },
      "metadata-put": { any: "JSON value; the helper wraps it as the endpoint's value field" },
      candidates: { source_id: "configured-source-id", candidates: [{ external_key: "stable-deduplication-key", title: "Child work item", description: "Complete ticket description", repositories: [{ id: "repository-id", primary: true }], metadata: { discovered_by: "current-node" } }] },
    },
  };
}

function callbackMarkdown(configuration: CallbackConfiguration, helperPath: string, artifactHelperPath: string): string {
  const outcomes = configuration.allowed_outcomes.length
    ? configuration.allowed_outcomes.map((outcome) => `- \`${outcome.id}\`: ${outcome.label} — ${outcome.description}`).join("\n")
    : "- `completed`: Complete the assigned work";
  return `# Callback contract

This lease advances only through a tracker callback. Use the generated helper at:

\`${helperPath}\`

## Allowed completion outcomes

${outcomes}

## Helper commands

\`\`\`bash
${helperPath} schema complete
${helperPath} complete result.json
${helperPath} ask questions.json
${helperPath} fail failure.json
${helperPath} comment comment.json
${helperPath} metadata get
${helperPath} metadata get release
${helperPath} metadata put release release-value.json
${helperPath} emit-candidates candidates.json
${artifactHelperPath} report.md --title "Implementation summary" --category review --featured
\`\`\`

Use \`-\` instead of a filename to read JSON from stdin. The callback helper validates completion outcomes, writes every request and response under \`outbox/\`, and then calls the lease-fenced tracker endpoint. The artifact helper accepts any file and optional display hints; publish evidence before the terminal callback closes the lease.

Raw callback base, if the helper cannot be used: \`${configuration.callback_base}\`

Before becoming idle, send \`ask\`, \`complete\`, or \`fail\`. A comment is not terminal.
`;
}

export class AssignmentBundleWriter {
  readonly root: string;

  constructor(root: string, private readonly supervisorId: string) {
    this.root = resolve(root);
  }

  private bundleFor(ticket: ClaimedTicket): AssignmentBundle {
    const runId = ticket.frontmatter.execution.node_run_id;
    if (!runId) throw new Error(`Ticket ${ticket.frontmatter.id} has no node run ID`);
    const attempt = String(ticket.frontmatter.execution.attempt ?? 1).padStart(4, "0");
    const nodeId = ticket.workflow_node.id;
    const ticketDirectory = join(this.root, this.supervisorId, "tickets", ticket.frontmatter.id);
    const runDirectory = join(ticketDirectory, "runs", `${attempt}-${nodeId}-${runId}`);
    return {
      root: this.root, ticketDirectory, runDirectory,
      startHerePath: join(runDirectory, "START_HERE.md"),
      callbackHelperPath: join(runDirectory, "callback"),
      artifactHelperPath: join(runDirectory, "publish-artifact"),
      attachmentsDirectory: join(runDirectory, "attachments"),
    };
  }

  async prepare(ticket: ClaimedTicket, callbackBaseUrl: string, projectRoot: string, prompts: PromptStore): Promise<AssignmentBundle> {
    const bundle = this.bundleFor(ticket);
    await mkdir(join(bundle.runDirectory, "updates"), { recursive: true });
    await mkdir(join(bundle.runDirectory, "outbox"), { recursive: true });
    await atomicWrite(bundle.callbackHelperPath, callbackHelperSource());
    await chmod(bundle.callbackHelperPath, 0o755);
    await atomicWrite(bundle.artifactHelperPath, artifactHelperSource());
    await chmod(bundle.artifactHelperPath, 0o755);
    await this.refresh(bundle, ticket, callbackBaseUrl, projectRoot, prompts);
    await atomicWrite(join(bundle.ticketDirectory, "ACTIVE.json"), `${JSON.stringify({
      schema_version: 1, ticket_id: ticket.frontmatter.id, node_run_id: ticket.frontmatter.execution.node_run_id,
      run_directory: bundle.runDirectory, start_here: bundle.startHerePath, callback_helper: bundle.callbackHelperPath, artifact_helper: bundle.artifactHelperPath,
      updated_at: new Date().toISOString(),
    }, null, 2)}\n`);
    return bundle;
  }

  async refresh(bundle: AssignmentBundle, ticket: ClaimedTicket, callbackBaseUrl: string, projectRoot: string, prompts: PromptStore): Promise<void> {
    const attachments = await this.materializeAttachments(bundle, ticket, callbackBaseUrl);
    const values = assignmentValues(ticket, callbackBaseUrl, projectRoot);
    if (!ticket.node_prompt) throw new Error(`Agent node ${ticket.workflow_node.id} has no pinned prompt`);
    const nodeInstructions = prompts.renderContent(ticket.node_prompt.id, ticket.node_prompt.content, values);
    const configuration = callbackConfiguration(ticket, callbackBaseUrl);
    const repositories = ticket.frontmatter.repositories.map((repository) => ({ ...repository, path: join(projectRoot, repository.id) }));
    const artifacts = (ticket.frontmatter.artifacts ?? []).map((artifact) => ({
      ...artifact,
      url: new URL(`/api/tickets/${encodeURIComponent(ticket.frontmatter.id)}/artifacts/${encodeURIComponent(artifact.id)}/content`, callbackBaseUrl).toString(),
    }));
    const generatedNotice = "> Generated assignment snapshot. You may edit these files for your own notes, but edits are not sent back to the tracker and are not durable workflow changes.\n";
    const startHere = `# Start here: ${ticket.frontmatter.id} — ${ticket.workflow_node.name}

${generatedNotice}
This directory contains the durable input for node run \`${ticket.frontmatter.execution.node_run_id}\`.

## Read in this order

1. [node.md](./node.md) — the exact objective and node-specific instructions.
2. [ticket.md](./ticket.md) — the complete ticket snapshot.
3. [attachments.md](./attachments.md) — local paths for every ticket attachment.
4. [incoming.md](./incoming.md) — the preceding outcome, handoff, and Script output references.
5. [artifacts.md](./artifacts.md) — tracker-owned Script artifacts and checkpoint provenance.
6. [callbacks.md](./callbacks.md) — allowed outcomes and the callback contract.
7. [context.json](./context.json) — machine-readable execution and repository context when needed.

## Workspace

- Supervisor project root: \`${projectRoot}\`
${repositories.map((repository) => `- ${repository.primary ? "Primary" : "Additional"} repository \`${repository.id}\`: \`${repository.path}\``).join("\n")}

Use your normal tools, credentials, judgment, planning, and subagents. Work autonomously inside the current node.

To publish human-readable evidence for later inspection, run \`${bundle.artifactHelperPath} --help\`. Artifact contents are unrestricted and must be published before the terminal callback.

## Ticket attachments

${attachments.length ? attachments.map((attachment) => `- \`${attachment.filename}\`: \`${attachment.path}\``).join("\n") : "No files are attached to this ticket."}

## Before becoming idle

Use the exact helper path below to ask, complete, or fail:

\`${bundle.callbackHelperPath}\`

For example, run \`${bundle.callbackHelperPath} schema complete\` to print the completion payload example. A comment alone does not release the lease.
`;
    const incoming = `# Incoming transition

${generatedNotice}
- Previous node: ${values.incoming_node}
- Selected outcome: ${values.incoming_outcome}
- Previous result: ${values.incoming_summary}
- Actionable handoff: ${values.incoming_handoff}

## Prior node output

${values.incoming_output}

Full output log: ${values.incoming_output_log}
`;
    const context = {
      schema_version: 1, generated_at: new Date().toISOString(), supervisor_id: this.supervisorId,
      assignment: { directory: bundle.runDirectory, start_here: bundle.startHerePath, callback_helper: bundle.callbackHelperPath, artifact_helper: bundle.artifactHelperPath },
      ticket: { id: ticket.frontmatter.id, title: ticket.frontmatter.title, tracker_path: ticket.path, phase: ticket.frontmatter.phase, revision: (ticket.frontmatter as Record<string, unknown>).revision ?? null },
      workflow: ticket.frontmatter.workflow ?? null, node: ticket.workflow_node ?? null,
      execution: ticket.frontmatter.execution, resolved_agent_profile: ticket.resolved_agent_profile ?? null,
      project_root: projectRoot, repositories, attachments, artifacts, checkpoints: ticket.frontmatter.checkpoints ?? [],
      prompt: ticket.node_prompt ? { id: ticket.node_prompt.id, revision: ticket.node_prompt.revision } : null,
    };
    await Promise.all([
      atomicWrite(bundle.startHerePath, startHere),
      atomicWrite(join(bundle.runDirectory, "ticket.md"), `${generatedNotice}\n${ticket.markdown.trim()}\n`),
      atomicWrite(join(bundle.runDirectory, "node.md"), `# Current node instructions\n\n${generatedNotice}\n${nodeInstructions.trim()}\n`),
      atomicWrite(join(bundle.runDirectory, "incoming.md"), incoming),
      atomicWrite(join(bundle.runDirectory, "attachments.md"), `# Ticket attachments\n\n${generatedNotice}\n${attachments.length ? attachments.map((attachment) => `- **${attachment.filename}** (${attachment.content_type}, ${attachment.size_bytes} bytes)\n  - Local path: \`${attachment.path}\`\n  - SHA-256: \`${attachment.sha256}\``).join("\n") : "No files are attached to this ticket."}\n`),
      atomicWrite(join(bundle.runDirectory, "artifacts.md"), `# Tracker artifacts and checkpoints\n\n${generatedNotice}\n## Artifacts\n\n${artifacts.length ? artifacts.map((artifact) => `- **${artifact.filename}** — ${artifact.kind}, ${artifact.size_bytes} bytes\n  - URL: ${artifact.url}\n  - SHA-256: \`${artifact.sha256}\`${artifact.node_run_id ? `\n  - Node run: \`${artifact.node_run_id}\`` : ""}`).join("\n") : "No workflow artifacts have been stored."}\n\n## Checkpoints\n\n${(ticket.frontmatter.checkpoints ?? []).length ? (ticket.frontmatter.checkpoints ?? []).map((checkpoint) => `- **${checkpoint.label}** — \`${checkpoint.id}\`, ${checkpoint.kind}, ${checkpoint.repositories.length} repositories`).join("\n") : "No checkpoints have been recorded."}\n`),
      atomicWrite(join(bundle.runDirectory, "context.json"), `${JSON.stringify(context, null, 2)}\n`),
      atomicWrite(join(bundle.runDirectory, "callbacks.json"), `${JSON.stringify(configuration, null, 2)}\n`),
      atomicWrite(join(bundle.runDirectory, "callbacks.md"), callbackMarkdown(configuration, bundle.callbackHelperPath, bundle.artifactHelperPath)),
    ]);
  }

  private async materializeAttachments(bundle: AssignmentBundle, ticket: ClaimedTicket, callbackBaseUrl: string): Promise<Array<{
    id: string; filename: string; content_type: string; size_bytes: number; sha256: string; path: string;
  }>> {
    await mkdir(bundle.attachmentsDirectory, { recursive: true });
    const activeIds = new Set((ticket.frontmatter.attachments ?? []).map((attachment) => attachment.id));
    for (const entry of await readdir(bundle.attachmentsDirectory, { withFileTypes: true })) {
      if (!activeIds.has(entry.name)) await rm(join(bundle.attachmentsDirectory, entry.name), { recursive: true, force: true });
    }
    const output = [];
    for (const attachment of ticket.frontmatter.attachments ?? []) {
      const filename = basename(attachment.filename);
      const directory = join(bundle.attachmentsDirectory, attachment.id);
      const path = join(directory, filename);
      await mkdir(directory, { recursive: true });
      const url = new URL(`/api/tickets/${encodeURIComponent(ticket.frontmatter.id)}/attachments/${encodeURIComponent(attachment.id)}/content`, callbackBaseUrl);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not download attachment ${filename}: tracker returned HTTP ${response.status}`);
      const content = new Uint8Array(await response.arrayBuffer());
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (content.byteLength !== attachment.size_bytes || sha256 !== attachment.sha256) throw new Error(`Attachment ${filename} failed its assignment integrity check`);
      await atomicWrite(path, content);
      output.push({ ...attachment, path });
    }
    return output;
  }

  async appendUpdate(bundle: AssignmentBundle, guidance: Guidance): Promise<string> {
    const path = join(bundle.runDirectory, "updates", `${String(guidance.sequence).padStart(8, "0")}-${guidance.id}.md`);
    await atomicWrite(path, `# Assignment update ${guidance.sequence}\n\n${guidance.message.trim()}\n`);
    return path;
  }
}
