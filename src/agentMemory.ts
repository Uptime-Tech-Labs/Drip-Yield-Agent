import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";

/** Local SQLite (libSQL) for threads + working memory. Override with `MASTRA_MEMORY_URL`. */
const DEFAULT_DB_URL = "file:./data/mastra-memory.db";

function ensureDbParentDir(url: string): void {
  if (!url.startsWith("file:")) return;
  const rest = url.slice("file:".length);
  const pathOnly = rest.startsWith("/") ? rest : resolve(process.cwd(), rest);
  mkdirSync(dirname(pathOnly), { recursive: true });
}

const dbUrl = (process.env.MASTRA_MEMORY_URL ?? DEFAULT_DB_URL).trim();
ensureDbParentDir(dbUrl);

/**
 * Conversation + [working memory](https://mastra.ai/docs/memory/working-memory) for long-lived context
 * (e.g. [The Synthesis](https://synthesis.md/skill.md) hackathon notes — **no secrets** in working memory).
 */
export const agentMemory = new Memory({
  name: "dripagent-memory",
  storage: new LibSQLStore({
    id: "dripagent-memory-store",
    url: dbUrl,
  }),
  options: {
    lastMessages: 40,
    workingMemory: {
      enabled: true,
      scope: "resource",
      template: `# The Synthesis (hackathon)
Follow the [Synthesis skill](https://synthesis.md/skill.md). Base API: \`https://synthesis.devfolio.co\`. Do **not** put API keys here; use env or \`.synthesis-credentials\`. Do not share UUIDs with your human unless they ask.

- **Themes / goals**:
- **Tracks / prizes**:
- **Registration / team** (high-level only, no IDs in chat unless asked):
- **Human collaborator**:
- **This repo (dripagent) next steps**:
`,
    },
  },
});

/** Stable resource id for memory scoping (default: dripagent). */
export const MEMORY_RESOURCE_ID =
  process.env.MASTRA_MEMORY_RESOURCE_ID?.trim() || "dripagent";

/** Default conversation thread id for \`generateLegacy\` / \`generate\`. */
export const MEMORY_THREAD_ID =
  process.env.MASTRA_MEMORY_THREAD_ID?.trim() || "dripagent-main";
