import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { QualityConfig } from "./config-store.js";
import type { JsonValue } from "./domain.js";
import {
  MAX_QUALITY_REPORT_BYTES,
  parseQualityReport,
  qualityReportMetadata,
} from "./quality.js";
import { normalizeTicket } from "./validation.js";

const registry: QualityConfig = {
  attributes: [
    {
      key: "coverage.line_percent",
      label: "Line coverage",
      type: "number",
      unit: "percent",
      direction: "higher_is_better",
      minimum: 0,
      maximum: 100,
    },
    {
      key: "security.clean",
      label: "Security scan clean",
      type: "boolean",
      unit: "",
      direction: "neutral",
      minimum: null,
      maximum: null,
    },
  ],
};

function yamlReport(attributes: unknown[], overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(stringify({
    schema: "agentic-quality/v1",
    name: "Repository verification",
    subject: { type: "repository", repository: "demo" },
    producer: { tool: "verify.sh", version: "1.2.3" },
    attributes,
    ...overrides,
  }));
}

function parse(attributes: unknown[], options: {
  required?: string[];
  config?: QualityConfig;
  overrides?: Record<string, unknown>;
} = {}) {
  return parseQualityReport(
    yamlReport(attributes, options.overrides),
    "verification-quality",
    options.required ?? [],
    options.config ?? registry,
    7,
  ).quality_report as Record<string, unknown>;
}

describe("quality report normalization", () => {
  it("normalizes registered and ad-hoc attributes while retaining provenance", () => {
    // Arrange
    const attributes = [
      { key: "coverage.line_percent", label: "Ignored label", value: 87.5, unit: "percent", direction: "higher_is_better", target: 80, status: "pass" },
      { key: "lint.warning_count", label: "Lint warnings", value: 3, unit: "findings", direction: "lower_is_better", target: 0, status: "warn" },
    ];

    // Act
    const result = parse(attributes, { required: ["coverage.line_percent"] });

    // Assert
    expect(result).toMatchObject({
      schema: "agentic-quality/v1",
      name: "Repository verification",
      artifact_name: "verification-quality",
      registry_revision: 7,
      overall_status: "warn",
      subject: { type: "repository", repository: "demo" },
      producer: { tool: "verify.sh", version: "1.2.3" },
      attributes: [
        { key: "coverage.line_percent", label: "Line coverage", value: 87.5, type: "number", unit: "percent", direction: "higher_is_better", target: 80, status: "pass", registered: true },
        { key: "lint.warning_count", label: "Lint warnings", value: 3, type: "number", unit: "findings", direction: "lower_is_better", target: 0, status: "warn", registered: false },
      ],
    });
  });

  it("uses stable defaults for optional report fields and unknown status values", () => {
    // Arrange
    const content = yamlReport([{ key: "custom.note", value: "ready", status: "not-a-status" }], { name: "   ", subject: undefined, producer: undefined });

    // Act
    const result = parseQualityReport(content, "fallback-name", [], { attributes: [] }, 1).quality_report as Record<string, unknown>;

    // Assert
    expect(result).toMatchObject({ name: "fallback-name", overall_status: "unknown", subject: {}, producer: {} });
    expect(result.attributes).toEqual([expect.objectContaining({
      key: "custom.note", label: "custom.note", type: "string", unit: "", direction: "neutral", target: null, status: "unknown", registered: false,
    })]);
  });

  it("derives the overall status from the worst reported attribute", () => {
    // Arrange
    const attributes = [
      { key: "one", value: true, status: "pass" },
      { key: "two", value: true, status: "unknown" },
      { key: "three", value: true, status: "warn" },
      { key: "four", value: true, status: "fail" },
    ];

    // Act
    const result = parse(attributes, { config: { attributes: [] } });

    // Assert
    expect(result.overall_status).toBe("fail");
  });

  it("reports every required attribute that is absent", () => {
    // Arrange
    const content = yamlReport([{ key: "coverage.line_percent", value: 90 }]);

    // Act
    const action = () => parseQualityReport(content, "quality", ["security.clean", "tests.pass_rate"], registry, 1);

    // Assert
    expect(action).toThrow(expect.objectContaining({
      status: 422,
      message: "Quality report is missing required attributes",
      details: ["security.clean", "tests.pass_rate"],
    }));
  });

  it.each([
    ["wrong registered type", { key: "coverage.line_percent", value: "95" }, "must be number"],
    ["below configured minimum", { key: "coverage.line_percent", value: -0.1 }, "below its configured minimum"],
    ["above configured maximum", { key: "coverage.line_percent", value: 100.1 }, "above its configured maximum"],
    ["registry unit conflict", { key: "coverage.line_percent", value: 90, unit: "ratio" }, "unit conflicts with the registry"],
    ["registry direction conflict", { key: "coverage.line_percent", value: 90, direction: "lower_is_better" }, "direction conflicts with the registry"],
  ])("rejects %s", (_case, attribute, message) => {
    // Arrange
    const content = yamlReport([attribute]);

    // Act
    const action = () => parseQualityReport(content, "quality", [], registry, 1);

    // Assert
    expect(action).toThrow(expect.objectContaining({ status: 422, message: expect.stringContaining(message) }));
  });

  it.each([
    ["an invalid key", [{ key: "Invalid Key", value: 1 }], "key is invalid"],
    ["a duplicate key", [{ key: "tests.pass", value: true }, { key: "tests.pass", value: false }], "is duplicated"],
    ["a null value", [{ key: "tests.pass", value: null }], "value cannot be null"],
    ["a mismatched target", [{ key: "tests.pass", value: true, target: "true" }], "target must match the value type"],
    ["an invalid direction", [{ key: "tests.pass", value: true, direction: "sideways" }], "direction is invalid"],
    ["a directional categorical value", [{ key: "tests.pass", value: true, direction: "higher_is_better" }], "direction must be neutral for non-numeric values"],
  ])("rejects %s", (_case, attributes, message) => {
    // Arrange
    const content = yamlReport(attributes);

    // Act
    const action = () => parseQualityReport(content, "quality", [], { attributes: [] }, 1);

    // Assert
    expect(action).toThrow(expect.objectContaining({ status: 422, message: expect.stringContaining(message) }));
  });

  it.each([
    ["invalid YAML", Buffer.from("schema: [unterminated"), "Quality report YAML is invalid"],
    ["a scalar root", Buffer.from("agentic-quality/v1"), "must be a YAML object"],
    ["an unsupported schema", yamlReport([{ key: "tests.pass", value: true }], { schema: "agentic-quality/v2" }), "schema must be agentic-quality/v1"],
    ["no attributes", yamlReport([]), "between 1 and 100 entries"],
    ["too many attributes", yamlReport(Array.from({ length: 101 }, (_, index) => ({ key: `test.${index}`, value: true }))), "between 1 and 100 entries"],
  ])("rejects %s", (_case, content, message) => {
    // Arrange
    const report = content as Buffer;

    // Act
    const action = () => parseQualityReport(report, "quality", [], { attributes: [] }, 1);

    // Assert
    expect(action).toThrow(expect.objectContaining({ status: 422, message: expect.stringContaining(message) }));
  });

  it.each([
    ["nested subject data", { subject: { repository: { id: "demo" } } }, "subject.repository must be"],
    ["an unsafe producer key", { producer: { "not a key": "tool" } }, "producer key not a key is invalid"],
    ["an oversized provenance value", { subject: { repository: "x".repeat(501) } }, "must be at most 500 characters"],
    ["too many subject fields", { subject: Object.fromEntries(Array.from({ length: 26 }, (_, index) => [`field${index}`, index])) }, "subject may contain at most 25 values"],
  ])("rejects %s", (_case, overrides, message) => {
    // Arrange
    const content = yamlReport([{ key: "tests.pass", value: true }], overrides);

    // Act
    const action = () => parseQualityReport(content, "quality", [], { attributes: [] }, 1);

    // Assert
    expect(action).toThrow(expect.objectContaining({ status: 422, message: expect.stringContaining(message) }));
  });

  it("enforces the raw report size before parsing", () => {
    // Arrange
    const content = Buffer.alloc(MAX_QUALITY_REPORT_BYTES + 1, "x");

    // Act
    const action = () => parseQualityReport(content, "quality", [], { attributes: [] }, 1);

    // Assert
    expect(action).toThrow(expect.objectContaining({ status: 413 }));
  });

  it("accepts a valid report exactly at the raw size limit", () => {
    // Arrange
    const base = yamlReport([{ key: "tests.pass", value: true }]);
    const padding = Buffer.from(`\n#${"x".repeat(MAX_QUALITY_REPORT_BYTES - base.byteLength - 2)}`);
    const content = Buffer.concat([base, padding]);

    // Act
    const result = parseQualityReport(content, "quality", [], { attributes: [] }, 1);

    // Assert
    expect(content.byteLength).toBe(MAX_QUALITY_REPORT_BYTES);
    expect(result.quality_report).toMatchObject({ schema: "agentic-quality/v1" });
  });

  it("bounds normalized ticket metadata independently from the raw YAML", () => {
    // Arrange
    const attributes = Array.from({ length: 100 }, (_, index) => ({
      key: `attribute.${index}`,
      label: `Label ${"x".repeat(180)}`,
      value: "v".repeat(500),
      status: "pass",
    }));
    const content = yamlReport(attributes);

    // Act
    const action = () => parseQualityReport(content, "quality", [], { attributes: [] }, 1);

    // Assert
    expect(action).toThrow(expect.objectContaining({ status: 422, message: "Normalized quality report exceeds the 64 KiB metadata limit" }));
  });
});

describe("normalized quality artifact validation", () => {
  function artifact(metadata: Record<string, JsonValue>, kind = "quality_report") {
    return { kind, metadata };
  }

  it("accepts metadata emitted by the normalizer", () => {
    // Arrange
    const metadata = parseQualityReport(
      yamlReport([{ key: "coverage.line_percent", value: 91, status: "pass" }]),
      "quality",
      [],
      registry,
      2,
    );

    // Act
    const result = qualityReportMetadata(artifact(metadata));

    // Assert
    expect(result).toMatchObject({ schema: "agentic-quality/v1", registry_revision: 2, overall_status: "pass" });
  });

  it.each([
    ["a different artifact kind", "script_artifact", {}],
    ["a missing report", "quality_report", {}],
    ["an unsupported schema", "quality_report", { quality_report: { schema: "agentic-quality/v2", name: "Quality", attributes: [] } }],
    ["a value/type mismatch", "quality_report", { quality_report: { schema: "agentic-quality/v1", name: "Quality", artifact_name: "quality", registry_revision: 1, overall_status: "pass", subject: {}, producer: {}, attributes: [{ key: "tests.count", label: "Tests", value: "12", type: "number", unit: "count", direction: "higher_is_better", target: null, status: "pass", registered: true }] } }],
    ["an invalid registered marker", "quality_report", { quality_report: { schema: "agentic-quality/v1", name: "Quality", artifact_name: "quality", registry_revision: 1, overall_status: "pass", subject: {}, producer: {}, attributes: [{ key: "tests.pass", label: "Tests pass", value: true, type: "boolean", unit: "", direction: "neutral", target: null, status: "pass", registered: "yes" }] } }],
  ])("rejects %s", (_case, kind, metadata) => {
    // Arrange
    const candidate = artifact(metadata as Record<string, JsonValue>, kind);

    // Act
    const result = qualityReportMetadata(candidate);

    // Assert
    expect(result).toBeNull();
  });

  it("accepts a ticket with normalized quality evidence and flags one with corrupted evidence", () => {
    // Arrange
    const metadata = parseQualityReport(
      yamlReport([{ key: "coverage.line_percent", value: 91, status: "pass" }]),
      "quality",
      [],
      registry,
      2,
    );
    const artifact = {
      id: "quality-1", kind: "quality_report", ticket_id: "AGENT-0001", node_run_id: null,
      filename: "quality.yaml", content_type: "application/yaml", size_bytes: 100,
      sha256: "a".repeat(64), created_at: "2026-08-20T12:00:00.000Z", metadata,
    };
    const ticket = { id: "AGENT-0001", title: "Quality", repositories: [{ id: "demo", primary: true }], artifacts: [artifact] };

    // Act
    const valid = normalizeTicket(ticket);
    const corrupted = structuredClone(ticket);
    (corrupted.artifacts[0]!.metadata.quality_report as Record<string, unknown>).overall_status = "fail";
    const invalid = normalizeTicket(corrupted);

    // Assert
    expect(valid).toMatchObject({ admitted: true, errors: [] });
    expect(invalid.errors).toContain("quality report artifact quality-1 has invalid normalized metadata");
  });
});
