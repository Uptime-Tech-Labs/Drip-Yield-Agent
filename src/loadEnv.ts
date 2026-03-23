import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load `.env` from `process.cwd()` first, then fall back to the project root
 * (directory above `src/`). Default `dotenv/config` only uses cwd, so running
 * from a parent folder silently skips dripagent/.env.
 */
export function loadProjectEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const projectEnv = resolve(here, "../.env");
  const cwdEnv = resolve(process.cwd(), ".env");
  if (existsSync(cwdEnv)) {
    config({ path: cwdEnv });
  }
  // Fill keys missing from cwd (e.g. SYNTHESIS_* only in dripagent/.env while cwd is monorepo root).
  if (existsSync(projectEnv) && resolve(projectEnv) !== resolve(cwdEnv)) {
    config({ path: projectEnv });
  }
}
