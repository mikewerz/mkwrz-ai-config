import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HttpError, type TicketFrontmatter, type WorkflowNodeRun, type WorkflowRunLedgerRef } from "./domain.js";

function sha256(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function ticketKey(id: string): string { return sha256(id); }

interface RunLedgerDocument {
  version: 1;
  ticket_id: string;
  ticket_revision: number;
  written_at: string;
  runs: WorkflowNodeRun[];
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, path);
    try { const directory = await open(dirname(path), "r"); await directory.sync(); await directory.close(); } catch { /* unsupported */ }
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export class RunLedger {
  constructor(private readonly root: string, private readonly clock: () => Date = () => new Date()) {}

  private directory(ticketId: string): string { return join(this.root, ".runs", ticketKey(ticketId), "ledger"); }
  private path(ticketId: string, ticketRevision: number): string { return join(this.directory(ticketId), `${ticketRevision}.json`); }

  async externalize(ticket: TicketFrontmatter): Promise<TicketFrontmatter> {
    if (!ticket.workflow) return structuredClone(ticket);
    const document: RunLedgerDocument = {
      version: 1, ticket_id: ticket.id, ticket_revision: ticket.revision,
      written_at: this.clock().toISOString(), runs: structuredClone(ticket.workflow.node_runs),
    };
    const content = `${JSON.stringify(document, null, 2)}\n`;
    const reference: WorkflowRunLedgerRef = {
      version: 1, ticket_revision: ticket.revision, run_count: document.runs.length, sha256: sha256(content),
    };
    await atomicWrite(this.path(ticket.id, ticket.revision), content);
    const persisted = structuredClone(ticket);
    persisted.workflow!.run_ledger = reference;
    persisted.workflow!.node_runs = [];
    return persisted;
  }

  async hydrate(ticket: TicketFrontmatter): Promise<void> {
    const reference = ticket.workflow?.run_ledger;
    if (!ticket.workflow || !reference) return;
    let content: string;
    try { content = await readFile(this.path(ticket.id, reference.ticket_revision), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(409, `Run ledger for ticket ${ticket.id} is missing`, reference, "RUN_LEDGER_MISSING");
      throw error;
    }
    if (sha256(content) !== reference.sha256) throw new HttpError(409, `Run ledger for ticket ${ticket.id} failed its integrity check`, reference, "RUN_LEDGER_INTEGRITY_FAILED");
    let document: RunLedgerDocument;
    try { document = JSON.parse(content) as RunLedgerDocument; }
    catch { throw new HttpError(409, `Run ledger for ticket ${ticket.id} is invalid JSON`, reference, "RUN_LEDGER_INVALID"); }
    if (document.version !== 1 || document.ticket_id !== ticket.id || document.ticket_revision !== reference.ticket_revision || !Array.isArray(document.runs) || document.runs.length !== reference.run_count) {
      throw new HttpError(409, `Run ledger for ticket ${ticket.id} does not match its ticket reference`, reference, "RUN_LEDGER_MISMATCH");
    }
    ticket.workflow.node_runs = structuredClone(document.runs);
  }

  async prune(ticket: TicketFrontmatter): Promise<void> {
    const reference = ticket.workflow?.run_ledger;
    if (!reference) return;
    const directory = this.directory(ticket.id);
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await Promise.all(files.filter((name) => name.endsWith(".json") && name !== `${reference.ticket_revision}.json`)
      .map((name) => rm(resolve(directory, name), { force: true })));
  }
}

