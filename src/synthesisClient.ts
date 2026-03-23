import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** [The Synthesis](https://synthesis.md/skill.md) hackathon API */
export const SYNTHESIS_API_BASE = "https://synthesis.devfolio.co";

/** Non-secret registration metadata (gitignored). API key lives in credentials file only. */
export interface SynthesisRegistrationRecord {
  participantId: string;
  teamId: string;
  name: string;
  registrationTxn?: string;
  savedAt: string;
}

function credentialsPath(): string {
  return resolve(
    process.cwd(),
    process.env.SYNTHESIS_CREDENTIALS_FILE?.trim() || ".synthesis-credentials"
  );
}

function registrationPath(): string {
  return resolve(
    process.cwd(),
    process.env.SYNTHESIS_REGISTRATION_FILE?.trim() || ".synthesis-registration.json"
  );
}

/**
 * Read saved registration metadata from disk (no API key).
 */
export function loadSynthesisRegistration(): SynthesisRegistrationRecord | null {
  const p = registrationPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SynthesisRegistrationRecord;
  } catch {
    return null;
  }
}

/**
 * POST /register/complete (no Bearer — used right after email/social verification).
 * Writes `sk-synth-...` to the credentials file and metadata JSON, and prints a summary to stdout.
 */
export async function completeSynthesisRegistration(pendingId: string): Promise<{
  ok: boolean;
  status: number;
  record?: SynthesisRegistrationRecord;
  apiKeySavedTo?: string;
  registrationSavedTo?: string;
  error?: string;
  rawText?: string;
}> {
  const url = `${SYNTHESIS_API_BASE}/register/complete`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pendingId: pendingId.trim() }),
  });
  const text = await res.text();

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: text.slice(0, 4000),
      rawText: text,
    };
  }

  let j: {
    participantId?: string;
    teamId?: string;
    name?: string;
    apiKey?: string;
    registrationTxn?: string;
  };
  try {
    j = JSON.parse(text) as typeof j;
  } catch {
    return { ok: false, status: res.status, error: "Invalid JSON in response", rawText: text };
  }

  if (!j.apiKey?.startsWith("sk-synth-")) {
    return { ok: false, status: res.status, error: "Response missing sk-synth apiKey", rawText: text };
  }
  if (!j.participantId || !j.teamId || !j.name) {
    return { ok: false, status: res.status, error: "Response missing participantId, teamId, or name", rawText: text };
  }

  const cred = credentialsPath();
  const reg = registrationPath();
  writeFileSync(cred, `${j.apiKey}\n`, "utf8");

  const record: SynthesisRegistrationRecord = {
    participantId: j.participantId,
    teamId: j.teamId,
    name: j.name,
    registrationTxn: j.registrationTxn,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(reg, JSON.stringify(record, null, 2), "utf8");

  const banner = formatRegistrationBanner(record, cred, reg);
  console.log(banner);

  return {
    ok: true,
    status: res.status,
    record,
    apiKeySavedTo: cred,
    registrationSavedTo: reg,
  };
}

export function formatRegistrationBanner(
  record: SynthesisRegistrationRecord,
  apiKeyPath: string,
  metadataPath: string
): string {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  The Synthesis — registration complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Name:              ${record.name}
  Participant ID:    ${record.participantId}
  Team ID:             ${record.teamId}
  Registration tx:   ${record.registrationTxn ?? "(none)"}
  API key saved to:  ${apiKeyPath}
  Metadata saved to: ${metadataPath}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
}

/**
 * Loads `sk-synth-...` from `SYNTHESIS_API_KEY` or the first non-empty line of the credentials file
 * (see skill: store the key in a local file, never in working memory / chat).
 */
export function loadSynthesisApiKey(): string | null {
  const env = process.env.SYNTHESIS_API_KEY?.trim();
  if (env) return env;
  const file =
    process.env.SYNTHESIS_CREDENTIALS_FILE?.trim() || ".synthesis-credentials";
  const abs = resolve(process.cwd(), file);
  if (!existsSync(abs)) return null;
  const line = readFileSync(abs, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  if (!line?.startsWith("sk-synth-")) return null;
  return line;
}

export async function synthesisRequest(
  method: string,
  path: string,
  bodyJson?: string
): Promise<{ status: number; ok: boolean; json?: unknown; text: string }> {
  const key = loadSynthesisApiKey();
  if (!key) {
    throw new Error(
      "Missing Synthesis API key: set SYNTHESIS_API_KEY or first line of .synthesis-credentials (sk-synth-...)"
    );
  }
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${SYNTHESIS_API_BASE}${p}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
  };
  if (bodyJson != null && bodyJson.length > 0) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    method,
    headers,
    body: bodyJson && bodyJson.length > 0 ? bodyJson : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const max = 24_000;
  const clipped = text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
  return { status: res.status, ok: res.ok, json, text: clipped };
}
