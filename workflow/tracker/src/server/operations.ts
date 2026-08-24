export type BackgroundOperation = "github_observation" | "artifact_maintenance" | "intake_scheduling";

export interface OperationSnapshot {
  in_progress: boolean;
  last_started_at: string | null;
  last_succeeded_at: string | null;
  last_failed_at: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
  details: Record<string, unknown>;
}

function empty(): OperationSnapshot {
  return {
    in_progress: false, last_started_at: null, last_succeeded_at: null,
    last_failed_at: null, last_duration_ms: null, last_error: null, details: {},
  };
}

export class OperationalMonitor {
  private readonly operations: Record<BackgroundOperation, OperationSnapshot> = {
    github_observation: empty(), artifact_maintenance: empty(), intake_scheduling: empty(),
  };

  async run<T>(name: BackgroundOperation, work: () => Promise<T>, details: (result: T) => Record<string, unknown> = () => ({})): Promise<T> {
    const operation = this.operations[name];
    const started = Date.now();
    operation.in_progress = true;
    operation.last_started_at = new Date(started).toISOString();
    try {
      const result = await work();
      operation.last_succeeded_at = new Date().toISOString();
      operation.last_duration_ms = Date.now() - started;
      operation.last_error = null;
      operation.details = details(result);
      return result;
    } catch (error) {
      operation.last_failed_at = new Date().toISOString();
      operation.last_duration_ms = Date.now() - started;
      operation.last_error = (error as Error).message;
      throw error;
    } finally { operation.in_progress = false; }
  }

  snapshot(): Record<BackgroundOperation, OperationSnapshot> {
    return structuredClone(this.operations);
  }
}
