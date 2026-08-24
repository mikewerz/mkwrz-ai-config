import { parse } from "yaml";
import { HttpError, type JsonPrimitive, type JsonValue } from "./domain.js";
import type { QualityConfig, QualityAttributeConfig } from "./config-store.js";

export const QUALITY_REPORT_SCHEMA = "agentic-quality/v1";
export const MAX_QUALITY_REPORT_BYTES = 256 * 1024;
const ATTRIBUTE_KEY = /^[a-z][a-z0-9._-]{0,127}$/;

export type QualityStatus = "pass" | "warn" | "fail" | "unknown";
export type QualityDirection = "higher_is_better" | "lower_is_better" | "neutral";

export interface NormalizedQualityAttribute {
  key: string;
  label: string;
  value: JsonPrimitive;
  type: "number" | "boolean" | "string";
  unit: string;
  direction: QualityDirection;
  target: JsonPrimitive;
  status: QualityStatus;
  registered: boolean;
}

export interface NormalizedQualityReport {
  schema: typeof QUALITY_REPORT_SCHEMA;
  name: string;
  artifact_name: string;
  registry_revision: number;
  overall_status: QualityStatus;
  subject: Record<string, JsonPrimitive>;
  producer: Record<string, JsonPrimitive>;
  attributes: NormalizedQualityAttribute[];
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown, field: string): JsonPrimitive {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new HttpError(422, `${field} must be a string, finite number, boolean, or null`);
}

function scalarRecord(value: unknown, field: string): Record<string, JsonPrimitive> {
  if (value === undefined) return {};
  if (!record(value)) throw new HttpError(422, `${field} must be an object of scalar values`);
  const entries = Object.entries(value);
  if (entries.length > 25) throw new HttpError(422, `${field} may contain at most 25 values`);
  return Object.fromEntries(entries.map(([key, item]) => {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(key)) throw new HttpError(422, `${field} key ${key} is invalid`);
    const parsed = scalar(item, `${field}.${key}`);
    if (typeof parsed === "string" && parsed.length > 500) throw new HttpError(422, `${field}.${key} must be at most 500 characters`);
    return [key, parsed];
  }));
}

function valueType(value: JsonPrimitive): "number" | "boolean" | "string" {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function configuredAttribute(config: QualityConfig, key: string): QualityAttributeConfig | undefined {
  return config.attributes.find((candidate) => candidate.key === key);
}

function statusRank(status: QualityStatus): number {
  return { pass: 0, unknown: 1, warn: 2, fail: 3 }[status];
}

export function parseQualityReport(
  content: Buffer,
  artifactName: string,
  requiredAttributes: string[],
  config: QualityConfig,
  registryRevision: number,
): Record<string, JsonValue> {
  if (content.byteLength > MAX_QUALITY_REPORT_BYTES) throw new HttpError(413, `Quality report exceeds the ${MAX_QUALITY_REPORT_BYTES} byte limit`);
  let raw: unknown;
  try { raw = parse(content.toString("utf8")); }
  catch (error) { throw new HttpError(422, "Quality report YAML is invalid", [(error as Error).message]); }
  if (!record(raw)) throw new HttpError(422, "Quality report must be a YAML object");
  if (raw.schema !== QUALITY_REPORT_SCHEMA) throw new HttpError(422, `Quality report schema must be ${QUALITY_REPORT_SCHEMA}`);
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : artifactName;
  if (name.length > 200) throw new HttpError(422, "Quality report name must be at most 200 characters");
  if (!Array.isArray(raw.attributes) || raw.attributes.length === 0 || raw.attributes.length > 100) {
    throw new HttpError(422, "Quality report attributes must contain between 1 and 100 entries");
  }
  const seen = new Set<string>();
  const attributes = raw.attributes.map((item, index): NormalizedQualityAttribute => {
    if (!record(item)) throw new HttpError(422, `Quality report attributes[${index}] must be an object`);
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (!ATTRIBUTE_KEY.test(key)) throw new HttpError(422, `Quality report attributes[${index}].key is invalid`);
    if (seen.has(key)) throw new HttpError(422, `Quality report attribute ${key} is duplicated`);
    seen.add(key);
    const value = scalar(item.value, `Quality report attribute ${key}.value`);
    if (value === null) throw new HttpError(422, `Quality report attribute ${key}.value cannot be null`);
    const definition = configuredAttribute(config, key);
    const actualType = valueType(value);
    if (definition && definition.type !== actualType) throw new HttpError(422, `Quality report attribute ${key} must be ${definition.type}`);
    if (typeof value === "number") {
      if (definition?.minimum !== null && definition?.minimum !== undefined && value < definition.minimum) throw new HttpError(422, `Quality report attribute ${key} is below its configured minimum`);
      if (definition?.maximum !== null && definition?.maximum !== undefined && value > definition.maximum) throw new HttpError(422, `Quality report attribute ${key} is above its configured maximum`);
    }
    const status = ["pass", "warn", "fail", "unknown"].includes(String(item.status)) ? item.status as QualityStatus : "unknown";
    const suppliedDirection = typeof item.direction === "string" ? item.direction : undefined;
    if (suppliedDirection && !["higher_is_better", "lower_is_better", "neutral"].includes(suppliedDirection)) throw new HttpError(422, `Quality report attribute ${key}.direction is invalid`);
    if (actualType !== "number" && suppliedDirection && suppliedDirection !== "neutral") throw new HttpError(422, `Quality report attribute ${key}.direction must be neutral for non-numeric values`);
    if (definition && suppliedDirection && suppliedDirection !== definition.direction) throw new HttpError(422, `Quality report attribute ${key}.direction conflicts with the registry`);
    const suppliedUnit = typeof item.unit === "string" ? item.unit.trim() : "";
    if (definition && suppliedUnit && suppliedUnit !== definition.unit) throw new HttpError(422, `Quality report attribute ${key}.unit conflicts with the registry`);
    const label = definition?.label ?? (typeof item.label === "string" && item.label.trim() ? item.label.trim() : key);
    const unit = definition?.unit ?? suppliedUnit;
    const target = item.target === undefined ? null : scalar(item.target, `Quality report attribute ${key}.target`);
    if (target !== null && valueType(target) !== actualType) throw new HttpError(422, `Quality report attribute ${key}.target must match the value type`);
    if (label.length > 200) throw new HttpError(422, `Quality report attribute ${key}.label must be at most 200 characters`);
    if (unit.length > 50) throw new HttpError(422, `Quality report attribute ${key}.unit must be at most 50 characters`);
    return {
      key,
      label,
      value,
      type: definition?.type ?? actualType,
      unit,
      direction: definition?.direction ?? (suppliedDirection as QualityDirection | undefined) ?? "neutral",
      target,
      status,
      registered: Boolean(definition),
    };
  });
  const missing = requiredAttributes.filter((key) => !seen.has(key));
  if (missing.length) throw new HttpError(422, "Quality report is missing required attributes", missing);
  const overallStatus = attributes.reduce<QualityStatus>((worst, attribute) => statusRank(attribute.status) > statusRank(worst) ? attribute.status : worst, "pass");
  const report: NormalizedQualityReport = {
    schema: QUALITY_REPORT_SCHEMA, name, artifact_name: artifactName, registry_revision: registryRevision,
    overall_status: overallStatus, subject: scalarRecord(raw.subject, "Quality report subject"),
    producer: scalarRecord(raw.producer, "Quality report producer"), attributes,
  };
  if (Buffer.byteLength(JSON.stringify(report)) > 65_536) throw new HttpError(422, "Normalized quality report exceeds the 64 KiB metadata limit");
  return { quality_report: report as unknown as JsonValue };
}

export function qualityReportMetadata(artifact: { kind: string; metadata: Record<string, JsonValue> }): NormalizedQualityReport | null {
  if (artifact.kind !== "quality_report") return null;
  const value = artifact.metadata.quality_report;
  const statuses: QualityStatus[] = ["pass", "warn", "fail", "unknown"];
  const scalarRecordIsValid = (candidate: unknown): boolean => record(candidate)
    && Object.keys(candidate).length <= 25
    && Object.entries(candidate).every(([key, item]) => /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(key)
      && (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)) || (typeof item === "string" && item.length <= 500)));
  if (!record(value)
    || value.schema !== QUALITY_REPORT_SCHEMA
    || typeof value.name !== "string" || !value.name || value.name.length > 200
    || typeof value.artifact_name !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(value.artifact_name)
    || !Number.isInteger(value.registry_revision) || Number(value.registry_revision) < 1
    || !statuses.includes(value.overall_status as QualityStatus)
    || !scalarRecordIsValid(value.subject) || !scalarRecordIsValid(value.producer)
    || !Array.isArray(value.attributes) || value.attributes.length < 1 || value.attributes.length > 100
    || Buffer.byteLength(JSON.stringify(value)) > 65_536) return null;
  const seen = new Set<string>();
  const valid = value.attributes.every((candidate) => {
    if (!record(candidate) || typeof candidate.key !== "string" || !ATTRIBUTE_KEY.test(candidate.key) || seen.has(candidate.key)) return false;
    seen.add(candidate.key);
    if (typeof candidate.label !== "string" || !candidate.label || candidate.label.length > 200
      || !["number", "boolean", "string"].includes(String(candidate.type))
      || typeof candidate.unit !== "string" || candidate.unit.length > 50
      || !["higher_is_better", "lower_is_better", "neutral"].includes(String(candidate.direction))
      || !statuses.includes(candidate.status as QualityStatus)
      || typeof candidate.registered !== "boolean") return false;
    const type = candidate.type as NormalizedQualityAttribute["type"];
    const itemValue = candidate.value;
    if (itemValue === null || typeof itemValue !== type || (type === "number" && !Number.isFinite(itemValue))) return false;
    if (type !== "number" && candidate.direction !== "neutral") return false;
    const target = candidate.target;
    if (target !== null && (target === undefined || typeof target !== type || (type === "number" && !Number.isFinite(target)))) return false;
    return true;
  });
  if (!valid) return null;
  const overallStatus = (value.attributes as unknown as NormalizedQualityAttribute[])
    .reduce<QualityStatus>((worst, attribute) => statusRank(attribute.status) > statusRank(worst) ? attribute.status : worst, "pass");
  return overallStatus === value.overall_status ? value as unknown as NormalizedQualityReport : null;
}
