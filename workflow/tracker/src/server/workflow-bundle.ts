import { createHash } from "node:crypto";
import { HttpError } from "./domain.js";
import type { TrackerConfig } from "./config-store.js";
import { PromptLibrary, type PromptDocument } from "./prompt-library.js";
import { WorkflowLibrary, type WorkflowDocument, type WorkflowRelease } from "./workflow-library.js";

export const WORKFLOW_BUNDLE_SCHEMA = "agentic-project-tracker/workflow-bundle/v1" as const;

export interface WorkflowBundlePrompt {
  name: string;
  revision: string;
  version: number;
  content: string;
}

export interface WorkflowBundle {
  schema: typeof WORKFLOW_BUNDLE_SCHEMA;
  exported_at: string;
  workflow: {
    id: string;
    revision: string;
    version: number;
    label: string;
    content: string;
  };
  prompts: WorkflowBundlePrompt[];
  requirements: {
    agent_profiles: string[];
    workflows: string[];
  };
}

export interface WorkflowBundleImportResult {
  workflow: WorkflowDocument;
  prompts: PromptDocument[];
  release: WorkflowRelease;
  installed_prompt_revisions: string[];
  unchanged_prompt_revisions: string[];
  warnings: string[];
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(422, `${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(422, `${field} must be a non-empty string`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new HttpError(422, `${field} must be a positive integer`);
  return Number(value);
}

function revision(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!/^[a-f0-9]{64}$/.test(parsed)) throw new HttpError(422, `${field} must be a SHA-256 digest`);
  return parsed;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) throw new HttpError(422, `${field} must be an array of non-empty strings`);
  return [...new Set(value as string[])].sort();
}

export function parseWorkflowBundle(value: unknown): WorkflowBundle {
  const root = record(value, "bundle");
  if (root.schema !== WORKFLOW_BUNDLE_SCHEMA) throw new HttpError(422, `Unsupported workflow bundle schema ${String(root.schema ?? "missing")}`);
  const exportedAt = text(root.exported_at, "bundle.exported_at");
  if (Number.isNaN(Date.parse(exportedAt))) throw new HttpError(422, "bundle.exported_at must be an ISO timestamp");
  const sourceWorkflow = record(root.workflow, "bundle.workflow");
  const workflow = {
    id: text(sourceWorkflow.id, "bundle.workflow.id"),
    revision: revision(sourceWorkflow.revision, "bundle.workflow.revision"),
    version: integer(sourceWorkflow.version, "bundle.workflow.version"),
    label: text(sourceWorkflow.label, "bundle.workflow.label"),
    content: text(sourceWorkflow.content, "bundle.workflow.content"),
  };
  if (digest(workflow.content) !== workflow.revision) throw new HttpError(422, "Bundled workflow content does not match its revision", undefined, "WORKFLOW_BUNDLE_INTEGRITY_FAILED");
  if (!Array.isArray(root.prompts)) throw new HttpError(422, "bundle.prompts must be an array");
  const prompts = root.prompts.map((candidate, index) => {
    const source = record(candidate, `bundle.prompts[${index}]`);
    const prompt = {
      name: text(source.name, `bundle.prompts[${index}].name`),
      revision: revision(source.revision, `bundle.prompts[${index}].revision`),
      version: integer(source.version, `bundle.prompts[${index}].version`),
      content: text(source.content, `bundle.prompts[${index}].content`),
    };
    if (digest(prompt.content) !== prompt.revision) throw new HttpError(422, `Bundled prompt ${prompt.name} content does not match its revision`, undefined, "WORKFLOW_BUNDLE_INTEGRITY_FAILED");
    return prompt;
  });
  if (new Set(prompts.map((prompt) => prompt.name)).size !== prompts.length) throw new HttpError(422, "Bundled prompt names must be unique");
  const requirements = record(root.requirements, "bundle.requirements");
  return {
    schema: WORKFLOW_BUNDLE_SCHEMA,
    exported_at: exportedAt,
    workflow,
    prompts,
    requirements: {
      agent_profiles: stringList(requirements.agent_profiles, "bundle.requirements.agent_profiles"),
      workflows: stringList(requirements.workflows, "bundle.requirements.workflows"),
    },
  };
}

export async function exportWorkflowBundle(
  workflowLibrary: WorkflowLibrary,
  promptLibrary: PromptLibrary,
  id: string,
  revisionId: string,
): Promise<WorkflowBundle> {
  const workflow = await workflowLibrary.get(id, revisionId);
  const catalog = await workflowLibrary.catalog();
  const release = catalog.releases.find((candidate) => candidate.workflow_id === id && candidate.revision === revisionId);
  if (!release) throw new HttpError(404, `Workflow ${id}@${revisionId} is not published`);
  const prompts = await Promise.all(workflow.referenced_prompts.map((name) => promptLibrary.get(name)));
  const invalidPrompts = prompts.filter((prompt) => !prompt.valid);
  if (invalidPrompts.length) {
    throw new HttpError(
      422,
      "Workflow bundle cannot be exported because referenced prompts are invalid",
      invalidPrompts.flatMap((prompt) => prompt.errors.map((error) => `${prompt.name}: ${error}`)),
      "WORKFLOW_BUNDLE_PROMPT_INVALID",
    );
  }
  return {
    schema: WORKFLOW_BUNDLE_SCHEMA,
    exported_at: new Date().toISOString(),
    workflow: { id, revision: workflow.revision, version: workflow.version ?? release.version, label: release.label, content: workflow.content },
    prompts: prompts.map((prompt) => ({ name: prompt.name, revision: prompt.revision, version: prompt.version, content: prompt.content })),
    requirements: {
      agent_profiles: [...new Set(workflow.definition.nodes.flatMap((node) => node.type === "agent" && node.agent_profile ? [node.agent_profile] : []))].sort(),
      workflows: [...new Set(workflow.definition.nodes.flatMap((node) => node.type === "workflow" && node.workflow_id ? [node.workflow_id] : []))].sort(),
    },
  };
}

export async function importWorkflowBundle(
  value: unknown,
  workflowLibrary: WorkflowLibrary,
  promptLibrary: PromptLibrary,
  config: Pick<TrackerConfig, "agent_profiles">,
): Promise<WorkflowBundleImportResult> {
  const bundle = parseWorkflowBundle(value);
  const existingWorkflows = await workflowLibrary.list();
  const workflowIds = new Set(existingWorkflows.map((item) => item.definition.id));
  const missingWorkflows = bundle.requirements.workflows.filter((id) => !workflowIds.has(id) && id !== bundle.workflow.id);
  if (missingWorkflows.length) throw new HttpError(422, "Workflow bundle has missing workflow dependencies", missingWorkflows.map((id) => `Import or create workflow ${id} first.`));
  const profileIds = new Set(config.agent_profiles.profiles.map((profile) => profile.id).concat("default"));
  const missingProfiles = bundle.requirements.agent_profiles.filter((id) => !profileIds.has(id));
  if (missingProfiles.length) throw new HttpError(422, "Workflow bundle requires unavailable agent profiles", missingProfiles.map((id) => `Configure agent profile ${id} before importing.`));

  // Validate all bundled prompts before changing the local library. This keeps
  // schema and template failures from producing a partially imported bundle.
  for (const prompt of bundle.prompts) await promptLibrary.validate(prompt.name, prompt.content);
  const promptIds = new Set((await promptLibrary.list()).filter((prompt) => prompt.valid).map((prompt) => prompt.name));
  bundle.prompts.forEach((prompt) => promptIds.add(prompt.name));
  workflowIds.add(bundle.workflow.id);
  const inspected = workflowLibrary.inspect(bundle.workflow.content, promptIds, workflowIds, profileIds);
  if (!inspected.valid) throw new HttpError(422, "Bundled workflow is invalid", inspected.errors);
  if (inspected.definition.id !== bundle.workflow.id) throw new HttpError(422, "Bundled workflow ID does not match its content");
  if (inspected.revision !== bundle.workflow.revision) throw new HttpError(422, "Bundled workflow normalization does not match its revision", undefined, "WORKFLOW_BUNDLE_INTEGRITY_FAILED");

  const installed: string[] = [];
  const unchanged: string[] = [];
  for (const prompt of bundle.prompts) {
    let current: PromptDocument | null = null;
    try { current = await promptLibrary.get(prompt.name); }
    catch (error) { if (!(error instanceof HttpError) || error.status !== 404) throw error; }
    if (current?.revision === prompt.revision) unchanged.push(`${prompt.name}@${prompt.revision}`);
    else {
      const imported = current
        ? await promptLibrary.update(prompt.name, prompt.content, current.revision)
        : await promptLibrary.create(prompt.name, prompt.content);
      if (imported.revision !== prompt.revision) throw new HttpError(500, `Imported prompt ${prompt.name} did not retain its revision`);
      installed.push(`${prompt.name}@${prompt.revision}`);
    }
  }

  const existing = existingWorkflows.find((candidate) => candidate.definition.id === bundle.workflow.id) ?? null;
  const workflow = existing?.revision === bundle.workflow.revision
    ? existing
    : await workflowLibrary.save(bundle.workflow.content, existing?.revision, promptIds, workflowIds, profileIds, {
      makeDefault: existing === null,
      label: `Imported ${bundle.workflow.label}`,
    });
  if (existing !== null) await workflowLibrary.activateTrial(workflow.definition.id, workflow.revision);
  const catalog = await workflowLibrary.catalog();
  const release = catalog.releases.find((candidate) => candidate.workflow_id === workflow.definition.id && candidate.revision === workflow.revision);
  if (!release) throw new HttpError(500, "Imported workflow release was not registered");
  return {
    workflow,
    prompts: await promptLibrary.list(),
    release,
    installed_prompt_revisions: installed,
    unchanged_prompt_revisions: unchanged,
    warnings: installed.length ? ["Bundled prompt revisions are now current. Previous local revisions remain available in prompt history."] : [],
  };
}
