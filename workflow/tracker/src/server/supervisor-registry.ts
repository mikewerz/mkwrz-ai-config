import { HttpError, type Provider, type TicketFrontmatter } from "./domain.js";

export interface SupervisorPresenceInput {
  supervisor_id: string;
  instance_id: string;
  hostname: string;
  ip_addresses: string[];
  project_root: string;
  herdr_session: string;
  providers: Provider[];
  started_at: string;
}

interface PresenceRecord extends SupervisorPresenceInput {
  last_seen_at: string;
}

export interface SupervisorHealth extends PresenceRecord {
  status: "online" | "offline";
  assigned_ticket: null | Pick<TicketFrontmatter, "id" | "title" | "phase" | "status">;
}

export class SupervisorRegistry {
  private readonly records = new Map<string, PresenceRecord>();

  constructor(private readonly ttlMs = 90_000, private readonly now = () => new Date()) {}

  heartbeat(input: SupervisorPresenceInput): PresenceRecord {
    const current = this.records.get(input.supervisor_id);
    const now = this.now();
    if (current && current.instance_id !== input.instance_id && now.getTime() - Date.parse(current.last_seen_at) <= this.ttlMs) {
      throw new HttpError(409, `Supervisor ID ${input.supervisor_id} is already used by a live process`);
    }
    const record = { ...input, ip_addresses: [...input.ip_addresses], providers: [...input.providers], last_seen_at: now.toISOString() };
    this.records.set(input.supervisor_id, record);
    return record;
  }

  assertInstance(supervisorId: string, instanceId: string): void {
    const current = this.records.get(supervisorId);
    if (current && current.instance_id !== instanceId && this.now().getTime() - Date.parse(current.last_seen_at) <= this.ttlMs) {
      throw new HttpError(409, `Supervisor ID ${supervisorId} is already used by a live process`);
    }
  }

  unregister(supervisorId: string, instanceId: string): boolean {
    const current = this.records.get(supervisorId);
    if (!current || current.instance_id !== instanceId) return false;
    return this.records.delete(supervisorId);
  }

  onlineProviders(): Provider[] {
    const providers = new Set<Provider>();
    for (const record of this.records.values()) {
      if (this.now().getTime() - Date.parse(record.last_seen_at) <= this.ttlMs) {
        for (const provider of record.providers) providers.add(provider);
      }
    }
    return [...providers];
  }

  hostnameFor(supervisorId: string): string | null {
    return this.records.get(supervisorId)?.hostname ?? null;
  }

  list(tickets: TicketFrontmatter[]): SupervisorHealth[] {
    const now = this.now().getTime();
    return [...this.records.values()].map((record) => {
      const assigned = tickets.find((ticket) => ticket.assigned_supervisor === record.supervisor_id
        && ticket.status !== "completed" && ticket.status !== "cancelled");
      const status: SupervisorHealth["status"] = now - Date.parse(record.last_seen_at) <= this.ttlMs ? "online" : "offline";
      return {
        ...record,
        status,
        assigned_ticket: assigned ? { id: assigned.id, title: assigned.title, phase: assigned.phase, status: assigned.status } : null,
      };
    }).sort((a, b) => a.supervisor_id.localeCompare(b.supervisor_id));
  }
}
