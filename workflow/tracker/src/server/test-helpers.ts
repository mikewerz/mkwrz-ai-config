export function ticketMarkdown(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    id: "APT-0001", title: "First ticket", priority: 10, labels: [], repositories: [{ id: "demo", primary: true }],
  };
  const data = { ...base, ...overrides };
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) || (value && typeof value === "object")) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else lines.push(`${key}: ${String(value)}`);
  }
  lines.push("---", "", "# Goal", "", "Complete the requested work.", "");
  return lines.join("\n");
}
