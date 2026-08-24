import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadEnvFile } from "node:process";
import { ArtifactStore } from "./artifact-store.js";
import { parseDocument } from "./markdown.js";

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

const root = resolve(process.argv[2] ?? process.env.TICKETS_ROOT ?? "tickets");
const referenced = new Set<string>();

async function visit(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      try {
        const document = parseDocument(await readFile(path, "utf8"));
        if (Array.isArray(document.frontmatter.artifacts)) for (const artifact of document.frontmatter.artifacts) {
          if (artifact && typeof artifact === "object" && typeof (artifact as { id?: unknown }).id === "string") referenced.add((artifact as { id: string }).id);
        }
      } catch { /* Malformed ticket files are reported by the tracker, not mutated here. */ }
    }
  }
}

await visit(root);
const diagnostics = await new ArtifactStore(root).diagnose(referenced);
process.stdout.write(`${JSON.stringify({ ticket_root: root, ...diagnostics }, null, 2)}\n`);
if (!diagnostics.healthy) process.exitCode = 2;
