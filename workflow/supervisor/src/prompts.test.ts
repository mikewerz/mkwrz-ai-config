import { describe, expect, it } from "vitest";
import { PromptStore, type PromptTemplates } from "./prompts.js";

const templates = (overrides: Partial<PromptTemplates> = {}): PromptTemplates => ({
  assignment: "Central {{phase_instructions}}",
  specification: "Specify {{ticket_id}}",
  implementation: "Implement {{ticket_id}} in {{phase}}",
  review: "Review {{ticket_id}}",
  guidance: "Guide {{ticket_id}}: {{message}}",
  "callback-reminder": "Call back",
  ...overrides,
});

describe("PromptStore", () => {
  it("refuses to render before the tracker library is loaded", () => {
    expect(() => new PromptStore().render("review", {})).toThrow("Tracker prompt library has not been loaded");
  });

  it("renders tracker-managed templates after the central library is refreshed", () => {
    const prompts = new PromptStore();
    prompts.replace(templates());
    expect(prompts.render("implementation", { ticket_id: "AGENT-0042", phase: "implementation" }))
      .toBe("Implement AGENT-0042 in implementation");
  });

  it("rejects misspelled or unsupported placeholders", () => {
    const prompts = new PromptStore();
    prompts.replace(templates({ review: "Review {{unknown_value}}" }));
    expect(() => prompts.render("review", {})).toThrow("unresolved placeholders: unknown_value");
  });
});
