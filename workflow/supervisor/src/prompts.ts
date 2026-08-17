export type PromptName = "assignment" | "specification" | "implementation" | "review" | "guidance" | "callback-reminder";
export type PromptTemplates = Record<PromptName, string>;

export class PromptStore {
  private templates: PromptTemplates | null = null;

  replace(templates: PromptTemplates): void { this.templates = { ...templates }; }

  render(name: PromptName, values: Record<string, string>): string {
    if (!this.templates) throw new Error("Tracker prompt library has not been loaded");
    const template = this.templates[name].trim();
    const placeholders = [...template.matchAll(/\{\{([a-z0-9_]+)\}\}/g)].map((match) => match[1]!);
    const unknown = [...new Set(placeholders.filter((placeholder) => values[placeholder] === undefined))];
    if (unknown.length > 0) throw new Error(`Prompt ${name}.md has unresolved placeholders: ${unknown.join(", ")}`);
    let output = template;
    for (const placeholder of new Set(placeholders)) {
      output = output.replaceAll(`{{${placeholder}}}`, values[placeholder]!);
    }
    return output;
  }
}
