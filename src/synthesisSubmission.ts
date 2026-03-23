/**
 * The Synthesis project submission (draft → self-custody → publish).
 * @see https://synthesis.devfolio.co/submission/skill.md
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "./loadEnv";
import { loadSynthesisApiKey, loadSynthesisRegistration, synthesisRequest } from "./synthesisClient";

/** stETH Agent Treasury — wstETH yield budget for agents (matches MainnetYieldVault + spend). */
export const DEFAULT_SYNTHESIS_TRACK_UUID = "5e445a077b5248e0974904915f76e1a0";

export interface SynthesisProjectRecord {
  projectUuid: string;
  teamUuid: string;
  savedAt: string;
}

function projectStatePath(): string {
  return resolve(process.cwd(), ".synthesis-project.json");
}

export function loadSynthesisProjectRecord(): SynthesisProjectRecord | null {
  const p = projectStatePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SynthesisProjectRecord;
  } catch {
    return null;
  }
}

function saveSynthesisProjectRecord(rec: SynthesisProjectRecord): void {
  writeFileSync(projectStatePath(), JSON.stringify(rec, null, 2), "utf8");
}

function envList(key: string, fallback: string[]): string[] {
  const raw = process.env[key]?.trim();
  if (!raw) return [...fallback];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTrackUuids(): string[] {
  const u = envList("SYNTHESIS_PROJECT_TRACK_UUIDS", [DEFAULT_SYNTHESIS_TRACK_UUID]);
  return u.length > 0 ? u : [DEFAULT_SYNTHESIS_TRACK_UUID];
}

/**
 * Build POST /projects body per submission skill. Requires SYNTHESIS_PROJECT_REPO_URL (public GitHub).
 */
export function buildCreateProjectBody(teamUUID: string): {
  body: Record<string, unknown> | null;
  missing: string[];
} {
  const missing: string[] = [];
  const req = (k: string, v: string | undefined): string => {
    if (v == null || !String(v).trim()) {
      missing.push(k);
      return "";
    }
    return String(v).trim();
  };

  const repoURL = req("SYNTHESIS_PROJECT_REPO_URL", process.env.SYNTHESIS_PROJECT_REPO_URL);
  const name = req(
    "SYNTHESIS_PROJECT_NAME",
    process.env.SYNTHESIS_PROJECT_NAME ?? loadSynthesisRegistration()?.name ?? "Drip Yield Agent"
  );
  const description = req(
    "SYNTHESIS_PROJECT_DESCRIPTION",
    process.env.SYNTHESIS_PROJECT_DESCRIPTION ??
      "Autonomous agent that draws only wstETH yield from a mainnet vault, bridges to Base USDC, and spends on x402 — principal stays put."
  );
  const problemStatement = req(
    "SYNTHESIS_PROJECT_PROBLEM_STATEMENT",
    process.env.SYNTHESIS_PROJECT_PROBLEM_STATEMENT ??
      "Agents need spendable budgets without liquidating user principal. Moving staking yield to L2 USDC for real-world payments (e.g. x402) should be automated, policy-bound, and auditable."
  );
  const conversationLog = req(
    "SYNTHESIS_PROJECT_CONVERSATION_LOG",
    process.env.SYNTHESIS_PROJECT_CONVERSATION_LOG ??
      [
        "Human: defined yield-only draws, whitelist recipients, bridge to Base USDC, x402 game as spend target.",
        "Agent: implemented MainnetYieldVault + clients, Across wstETH→Base USDC path, Uniswap fallback, viem txs, Mastra tools.",
        "Iteration: env/RPC tuning, optional Base vault, Synthesis registration and submission automation.",
      ].join("\n")
  );

  const frameworkRaw = (
    process.env.SYNTHESIS_SUBMISSION_AGENT_FRAMEWORK?.trim() || "mastra"
  ).toLowerCase();
  const allowedFw = new Set([
    "langchain",
    "elizaos",
    "mastra",
    "vercel-ai-sdk",
    "anthropic-agents-sdk",
    "other",
  ]);
  const agentFramework = allowedFw.has(frameworkRaw) ? frameworkRaw : "mastra";
  const agentFrameworkOther =
    agentFramework === "other"
      ? req(
          "SYNTHESIS_SUBMISSION_AGENT_FRAMEWORK_OTHER",
          process.env.SYNTHESIS_SUBMISSION_AGENT_FRAMEWORK_OTHER
        )
      : undefined;

  const harnessRaw = (
    process.env.SYNTHESIS_SUBMISSION_AGENT_HARNESS?.trim() ||
    process.env.SYNTHESIS_AGENT_HARNESS?.trim() ||
    "cursor"
  ).toLowerCase();
  const allowedH = new Set([
    "openclaw",
    "claude-code",
    "codex-cli",
    "opencode",
    "cursor",
    "cline",
    "aider",
    "windsurf",
    "copilot",
    "other",
  ]);
  const agentHarness = allowedH.has(harnessRaw) ? harnessRaw : "cursor";
  const agentHarnessOther =
    agentHarness === "other"
      ? req("SYNTHESIS_SUBMISSION_AGENT_HARNESS_OTHER", process.env.SYNTHESIS_SUBMISSION_AGENT_HARNESS_OTHER)
      : undefined;

  const model =
    process.env.SYNTHESIS_SUBMISSION_MODEL?.trim() ||
    process.env.SYNTHESIS_AGENT_MODEL?.trim() ||
    "claude-sonnet-4-5";

  const skills = envList("SYNTHESIS_SUBMISSION_SKILLS", ["web-search"]);
  const tools = envList("SYNTHESIS_SUBMISSION_TOOLS", [
    "Foundry",
    "viem",
    "TypeScript",
    "Mastra",
    "Across",
    "Uniswap V3",
  ]);
  const helpfulResources = envList("SYNTHESIS_SUBMISSION_HELPFUL_RESOURCES", [
    "https://viem.sh/docs/getting-started",
    "https://docs.lido.fi/contracts/wsteth",
    "https://docs.across.to/",
  ]);

  const intention = (
    process.env.SYNTHESIS_SUBMISSION_INTENTION?.trim() || "continuing"
  ).toLowerCase();
  const allowedI = new Set(["continuing", "exploring", "one-time"]);
  const intentionSafe = allowedI.has(intention) ? intention : "continuing";

  if (skills.length < 1) missing.push("SYNTHESIS_SUBMISSION_SKILLS (at least one skill id)");
  if (tools.length < 1) missing.push("SYNTHESIS_SUBMISSION_TOOLS (at least one tool name)");

  if (missing.length > 0) return { body: null, missing };

  const submissionMetadata: Record<string, unknown> = {
    agentFramework,
    agentHarness,
    model,
    skills,
    tools,
    helpfulResources,
    intention: intentionSafe,
    intentionNotes:
      process.env.SYNTHESIS_SUBMISSION_INTENTION_NOTES?.trim() ||
      "Maintain agent + contracts; extend tracks and game integrations.",
  };
  if (agentFrameworkOther) submissionMetadata.agentFrameworkOther = agentFrameworkOther;
  if (agentHarnessOther) submissionMetadata.agentHarnessOther = agentHarnessOther;

  const molt = process.env.SYNTHESIS_MOLTBOOK_POST_URL?.trim();
  if (molt) submissionMetadata.moltbookPostURL = molt;

  const helpfulSkillsRaw = process.env.SYNTHESIS_SUBMISSION_HELPFUL_SKILLS_JSON?.trim();
  if (helpfulSkillsRaw) {
    try {
      submissionMetadata.helpfulSkills = JSON.parse(helpfulSkillsRaw) as unknown;
    } catch {
      missing.push("SYNTHESIS_SUBMISSION_HELPFUL_SKILLS_JSON (invalid JSON)");
    }
  }

  if (missing.length > 0) return { body: null, missing };

  const trackUUIDs = parseTrackUuids();
  if (trackUUIDs.length < 1) missing.push("SYNTHESIS_PROJECT_TRACK_UUIDS");

  if (missing.length > 0) return { body: null, missing };

  const body: Record<string, unknown> = {
    teamUUID,
    name,
    description,
    problemStatement,
    repoURL,
    trackUUIDs,
    conversationLog,
    submissionMetadata,
  };

  const deployedURL = process.env.SYNTHESIS_PROJECT_DEPLOYED_URL?.trim();
  if (deployedURL) body.deployedURL = deployedURL;
  const videoURL = process.env.SYNTHESIS_PROJECT_VIDEO_URL?.trim();
  if (videoURL) body.videoURL = videoURL;
  const coverImageURL = process.env.SYNTHESIS_PROJECT_COVER_IMAGE_URL?.trim();
  if (coverImageURL) body.coverImageURL = coverImageURL;

  return { body, missing: [] };
}

export type SubmissionAdvanceResult =
  | { phase: "missing_env"; missing: string[] }
  | { phase: "missing_api_key" }
  | { phase: "participants_me_failed"; status: number; detail: string }
  | { phase: "no_team" }
  | { phase: "already_published"; projectUuid: string; slug?: string }
  | { phase: "draft_exists"; projectUuid: string }
  | { phase: "create_failed"; status: number; detail: string }
  | { phase: "transfer_init_failed"; status: number; detail: string }
  | { phase: "transfer_confirm_failed"; status: number; detail: string }
  /** Target wallet is already the on-chain owner for a different Synthesis participant — pick another EOA. */
  | { phase: "transfer_owner_address_in_use"; detail: string }
  | { phase: "publish_failed"; status: number; detail: string }
  | { phase: "publish_forbidden"; detail: string }
  | { phase: "complete"; projectUuid: string; status: string; slug?: string };

/**
 * Create draft (if needed) → self-custody transfer → publish.
 * Set SYNTHESIS_PROJECT_REPO_URL to a public GitHub HTTPS URL before running.
 */
export async function advanceSynthesisSubmission(opts?: {
  /** Create POST /projects when team has no draft */
  createDraft?: boolean;
  /** Run transfer init+confirm when custody is custodial */
  transferSelfCustody?: boolean;
  /** POST /projects/:uuid/publish */
  publish?: boolean;
}): Promise<SubmissionAdvanceResult> {
  loadProjectEnv();
  const createDraft = opts?.createDraft !== false;
  const transferSelfCustody = opts?.transferSelfCustody !== false;
  const publish = opts?.publish !== false;

  if (!loadSynthesisApiKey()) return { phase: "missing_api_key" };

  const me = await synthesisRequest("GET", "/participants/me");
  if (!me.ok) {
    return { phase: "participants_me_failed", status: me.status, detail: me.text };
  }
  const mj = me.json as {
    uuid?: string;
    custodyType?: string;
    team?: { uuid?: string; role?: string; projects?: { uuid?: string; status?: string }[] } | null;
    walletAddress?: string;
  };
  const team = mj.team;
  if (!team?.uuid) return { phase: "no_team" };

  const teamUUID = team.uuid;
  const projects = team.projects ?? [];
  const published = projects.find(
    (p) => p.status === "publish" || p.status === "published" || p.status === "Publish"
  );
  if (published?.uuid) {
    return {
      phase: "already_published",
      projectUuid: published.uuid,
      slug: (published as { slug?: string }).slug,
    };
  }

  let projectUuid: string | undefined =
    projects.find((p) => p.status === "draft")?.uuid ?? loadSynthesisProjectRecord()?.projectUuid;

  if (!projectUuid && createDraft) {
    const { body, missing } = buildCreateProjectBody(teamUUID);
    if (!body || missing.length > 0) return { phase: "missing_env", missing };

    const created = await synthesisRequest("POST", "/projects", JSON.stringify(body));
    if (!created.ok) {
      return { phase: "create_failed", status: created.status, detail: created.text };
    }
    const cj = created.json as { uuid?: string };
    if (!cj.uuid) {
      return { phase: "create_failed", status: created.status, detail: "No uuid in response: " + created.text };
    }
    projectUuid = cj.uuid;
    saveSynthesisProjectRecord({ projectUuid, teamUuid: teamUUID, savedAt: new Date().toISOString() });
  }

  if (!projectUuid) {
    return { phase: "missing_env", missing: ["Could not resolve project UUID — create draft failed or disabled"] };
  }

  if (mj.custodyType === "custodial" && transferSelfCustody) {
    const target =
      process.env.SYNTHESIS_SELF_CUSTODY_ADDRESS?.trim() ||
      mj.walletAddress ||
      process.env.AGENT_WALLET_ADDRESS?.trim();
    if (!target?.startsWith("0x")) {
      return {
        phase: "missing_env",
        missing: [
          "SYNTHESIS_SELF_CUSTODY_ADDRESS or AGENT_WALLET_ADDRESS (0x...) for /participants/me/transfer/*",
        ],
      };
    }

    const init = await synthesisRequest(
      "POST",
      "/participants/me/transfer/init",
      JSON.stringify({ targetOwnerAddress: target })
    );
    if (!init.ok) {
      if (init.status === 409 && /Another participant already uses this owner address/i.test(init.text)) {
        return { phase: "transfer_owner_address_in_use", detail: init.text };
      }
      if (init.status === 409 && /self.custody|already/i.test(init.text)) {
        /* already transferred — continue to publish */
      } else {
        return { phase: "transfer_init_failed", status: init.status, detail: init.text };
      }
    } else {
      const ij = init.json as { transferToken?: string; targetOwnerAddress?: string };
      if (!ij.transferToken) {
        return { phase: "transfer_init_failed", status: init.status, detail: "No transferToken: " + init.text };
      }

      const confirm = await synthesisRequest(
        "POST",
        "/participants/me/transfer/confirm",
        JSON.stringify({
          transferToken: ij.transferToken,
          targetOwnerAddress: ij.targetOwnerAddress ?? target,
        })
      );
      if (!confirm.ok) {
        if (confirm.status === 409 && /Another participant already uses this owner address/i.test(confirm.text)) {
          return { phase: "transfer_owner_address_in_use", detail: confirm.text };
        }
        return { phase: "transfer_confirm_failed", status: confirm.status, detail: confirm.text };
      }
    }
  }

  if (publish) {
    const pub = await synthesisRequest("POST", `/projects/${projectUuid}/publish`, "");
    if (pub.status === 403) {
      return {
        phase: "publish_forbidden",
        detail: pub.text.slice(0, 2000),
      };
    }
    if (!pub.ok) {
      return { phase: "publish_failed", status: pub.status, detail: pub.text };
    }
    const pj = pub.json as { status?: string; slug?: string };
    return {
      phase: "complete",
      projectUuid,
      status: pj.status ?? "publish",
      slug: pj.slug,
    };
  }

  return { phase: "draft_exists", projectUuid };
}

export function describeSubmissionNextStep(r: SubmissionAdvanceResult): string {
  switch (r.phase) {
    case "missing_env":
      return `Set: ${r.missing.join(", ")}`;
    case "missing_api_key":
      return "Configure SYNTHESIS_API_KEY or .synthesis-credentials.";
    case "participants_me_failed":
      return "GET /participants/me failed — check token.";
    case "no_team":
      return "No team on profile.";
    case "already_published":
      return `Already published (project ${r.projectUuid}).`;
    case "draft_exists":
      return `Draft ${r.projectUuid} — re-run with publish enabled or use synthesis-api-request.`;
    case "create_failed":
      return "POST /projects failed — check repo URL (public GitHub), tracks, and body.";
    case "transfer_init_failed":
      return "Self-custody transfer init failed.";
    case "transfer_confirm_failed":
      return "Self-custody transfer confirm failed.";
    case "transfer_owner_address_in_use":
      return (
        "That wallet is already Synthesis owner for another participant. " +
        "Set SYNTHESIS_SELF_CUSTODY_ADDRESS to a fresh 0x address (not used by any other agent registration), then run again."
      );
    case "publish_failed":
      return "Publish failed — all members must be self-custody; must be team admin.";
    case "publish_forbidden":
      return `403: ${r.detail}`;
    case "complete":
      return `Published — project ${r.projectUuid}${r.slug ? ` slug ${r.slug}` : ""}`;
    default:
      return "";
  }
}
