import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "./loadEnv";
import {
  SYNTHESIS_API_BASE,
  completeSynthesisRegistration,
  loadSynthesisApiKey,
  loadSynthesisRegistration,
} from "./synthesisClient";

/** In-flight registration (gitignored). */
export interface SynthesisPendingState {
  pendingId: string;
  verifyMethod: "email" | "social";
  createdAt: string;
  /** Email path: set after first /register/verify/email/send to avoid spamming resends. */
  emailOtpSent?: boolean;
}

function pendingPath(): string {
  return resolve(process.cwd(), ".synthesis-pending.json");
}

export function loadPendingState(): SynthesisPendingState | null {
  const p = pendingPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SynthesisPendingState;
  } catch {
    return null;
  }
}

function savePendingState(s: SynthesisPendingState): void {
  writeFileSync(pendingPath(), JSON.stringify(s, null, 2), "utf8");
}

export function clearPendingState(): void {
  const p = pendingPath();
  if (existsSync(p)) unlinkSync(p);
}

async function jsonNoAuth(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; json?: unknown; text: string }> {
  const url = `${SYNTHESIS_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { ok: res.ok, status: res.status, json, text: text.slice(0, 8000) };
}

/** API expects `yes` | `no` | `a little` (see synthesis skill). */
function normalizeCryptoExperience(raw: string): string {
  const t = raw.toLowerCase().trim();
  if (t === "yes" || t === "no" || t === "a little") return t;
  if (t === "a lot" || t === "lots" || t === "extensive" || t === "expert") return "yes";
  if (t === "some") return "a little";
  if (t === "none") return "no";
  return "a little";
}

/** Skill enums; API example uses lowercase (e.g. `background: "builder"`). */
function normalizeBackground(raw: string): string {
  const t = raw.toLowerCase().trim();
  if (t === "developer" || t === "dev" || t === "engineer") return "builder";
  const allowed = ["builder", "product", "designer", "student", "founder", "others"];
  if (allowed.includes(t)) return t;
  if (t === "other") return "others";
  return "others";
}

/**
 * Build POST /register/init body from env (https://synthesis.md/skill.md).
 * Human fills .env once; only OTP / tweet URL need a second step.
 */
export function buildRegisterInitFromEnv(): {
  body: Record<string, unknown> | null;
  missing: string[];
} {
  loadProjectEnv();

  const missing: string[] = [];
  const req = (k: string, v: string | undefined): string => {
    if (v == null || !String(v).trim()) {
      missing.push(k);
      return "";
    }
    return String(v).trim();
  };

  /** Empty string in .env must not wipe defaults (?? only skips null/undefined). */
  const def = (k: string, raw: string | undefined, fallback: string): string =>
    req(k, raw?.trim() || fallback);

  const name = req("SYNTHESIS_AGENT_NAME", process.env.SYNTHESIS_AGENT_NAME);
  const description = def(
    "SYNTHESIS_AGENT_DESCRIPTION",
    process.env.SYNTHESIS_AGENT_DESCRIPTION,
    "Yield → USDC → x402 agent (dripagent)."
  );
  const agentHarness = def(
    "SYNTHESIS_AGENT_HARNESS",
    process.env.SYNTHESIS_AGENT_HARNESS,
    "cursor"
  );
  const model = def(
    "SYNTHESIS_AGENT_MODEL",
    process.env.SYNTHESIS_AGENT_MODEL,
    "claude-sonnet-4-5"
  );

  const humanName = req("SYNTHESIS_HUMAN_NAME", process.env.SYNTHESIS_HUMAN_NAME);
  const humanEmail = req("SYNTHESIS_HUMAN_EMAIL", process.env.SYNTHESIS_HUMAN_EMAIL);
  const backgroundRaw = normalizeBackground(
    process.env.SYNTHESIS_HUMAN_BACKGROUND?.trim() || "Builder"
  );
  const background = req("SYNTHESIS_HUMAN_BACKGROUND", backgroundRaw);
  const cryptoExperience = normalizeCryptoExperience(
    process.env.SYNTHESIS_HUMAN_CRYPTO_EXPERIENCE?.trim() || "a little"
  );
  const aiAgentExperience = def(
    "SYNTHESIS_HUMAN_AI_AGENT_EXPERIENCE",
    process.env.SYNTHESIS_HUMAN_AI_AGENT_EXPERIENCE,
    "yes"
  );
  const codingRaw = def(
    "SYNTHESIS_HUMAN_CODING_COMFORT",
    process.env.SYNTHESIS_HUMAN_CODING_COMFORT,
    "7"
  );
  const codingComfort = Number.parseInt(codingRaw, 10);
  if (Number.isNaN(codingComfort) || codingComfort < 1 || codingComfort > 10) {
    missing.push("SYNTHESIS_HUMAN_CODING_COMFORT (1–10)");
  }
  const problemToSolve = req(
    "SYNTHESIS_HUMAN_PROBLEM_TO_SOLVE",
    process.env.SYNTHESIS_HUMAN_PROBLEM_TO_SOLVE
  );

  if (missing.length > 0) {
    return { body: null, missing };
  }

  const humanInfo: Record<string, unknown> = {
    name: humanName,
    email: humanEmail,
    background,
    cryptoExperience,
    aiAgentExperience,
    codingComfort,
    problemToSolve,
  };
  const social = process.env.SYNTHESIS_HUMAN_SOCIAL_MEDIA_HANDLE?.trim();
  if (social) humanInfo.socialMediaHandle = social;

  const body: Record<string, unknown> = {
    name,
    description,
    agentHarness,
    model,
    humanInfo,
  };

  const image = process.env.SYNTHESIS_AGENT_IMAGE?.trim();
  if (image) body.image = image;
  const teamCode = process.env.SYNTHESIS_TEAM_CODE?.trim();
  if (teamCode) body.teamCode = teamCode;
  if (agentHarness === "other") {
    const o = process.env.SYNTHESIS_AGENT_HARNESS_OTHER?.trim();
    if (o) body.agentHarnessOther = o;
  }

  return { body, missing: [] };
}

export type AdvanceResult =
  | { phase: "already_registered"; record: NonNullable<ReturnType<typeof loadSynthesisRegistration>> }
  | { phase: "missing_env"; missing: string[] }
  | { phase: "init_failed"; status: number; detail: string }
  | { phase: "pending_email_otp"; pendingId: string; message: string }
  | { phase: "pending_social_tweet"; pendingId: string; verificationCode?: string; message: string }
  | { phase: "verify_failed"; status: number; detail: string }
  | { phase: "complete_failed"; status: number; detail: string }
  | { phase: "registration_complete"; result: Awaited<ReturnType<typeof completeSynthesisRegistration>> };

/**
 * One-shot advance: init from env → send verification → confirm OTP/tweet from args or env → /register/complete.
 * Human work: fill SYNTHESIS_* once; paste OTP into SYNTHESIS_EMAIL_OTP or pass `emailOtp`; or tweet + SYNTHESIS_SOCIAL_TWEET_URL / tweetUrl.
 */
export async function advanceSynthesisRegistration(opts: {
  emailOtp?: string;
  tweetUrl?: string;
  /** New /register/init even if .synthesis-pending.json exists */
  forceNewInit?: boolean;
}): Promise<AdvanceResult> {
  const existing = loadSynthesisRegistration();
  if (existing && loadSynthesisApiKey()) {
    return { phase: "already_registered", record: existing };
  }

  const verifyMethod = (
    process.env.SYNTHESIS_VERIFY_METHOD ?? "email"
  ).toLowerCase() === "social"
    ? "social"
    : "email";

  let pending = loadPendingState();
  if (opts.forceNewInit) {
    clearPendingState();
    pending = null;
  }
  if (!pending) {
    const { body, missing } = buildRegisterInitFromEnv();
    if (!body || missing.length > 0) {
      return { phase: "missing_env", missing };
    }
    const init = await jsonNoAuth("POST", "/register/init", body);
    if (!init.ok) {
      return { phase: "init_failed", status: init.status, detail: init.text };
    }
    const pid = (init.json as { pendingId?: string })?.pendingId;
    if (!pid) {
      return { phase: "init_failed", status: init.status, detail: "No pendingId in response: " + init.text };
    }
    pending = {
      pendingId: pid,
      verifyMethod,
      createdAt: new Date().toISOString(),
    };
    savePendingState(pending);
  }

  const pendingId = pending!.pendingId;

  const statusRes = await jsonNoAuth(
    "GET",
    `/register/verify/status?pendingId=${encodeURIComponent(pendingId)}`
  );
  const st = statusRes.json as
    | { verified?: boolean; emailVerified?: boolean; socialVerified?: boolean }
    | undefined;
  const verified = st?.verified === true;

  if (verified) {
    clearPendingState();
    const done = await completeSynthesisRegistration(pendingId);
    if (!done.ok) {
      return { phase: "complete_failed", status: done.status, detail: done.error ?? done.rawText ?? "" };
    }
    return { phase: "registration_complete", result: done };
  }

  const pend = pending!;
  if (pend.verifyMethod === "email") {
    const otp =
      (opts.emailOtp ?? process.env.SYNTHESIS_EMAIL_OTP ?? "").trim().replace(/\s/g, "") ||
      undefined;
    if (otp && /^\d{6}$/.test(otp)) {
      const conf = await jsonNoAuth("POST", "/register/verify/email/confirm", {
        pendingId,
        otp,
      });
      if (!conf.ok) {
        return { phase: "verify_failed", status: conf.status, detail: conf.text };
      }
      const after = await jsonNoAuth(
        "GET",
        `/register/verify/status?pendingId=${encodeURIComponent(pendingId)}`
      );
      const st2 = after.json as { verified?: boolean } | undefined;
      if (st2?.verified) {
        clearPendingState();
        const done = await completeSynthesisRegistration(pendingId);
        if (!done.ok) {
          return { phase: "complete_failed", status: done.status, detail: done.error ?? "" };
        }
        return { phase: "registration_complete", result: done };
      }
      return {
        phase: "pending_email_otp",
        pendingId,
        message: "OTP accepted but not yet verified — check status or retry.",
      };
    }

    if (pend.emailOtpSent && process.env.SYNTHESIS_RESEND_EMAIL_OTP !== "1") {
      return {
        phase: "pending_email_otp",
        pendingId,
        message:
          "OTP already sent — set SYNTHESIS_EMAIL_OTP or pass emailOtp, then run synthesis-registration-advance again. Use SYNTHESIS_RESEND_EMAIL_OTP=1 to request a new code.",
      };
    }
    const send = await jsonNoAuth("POST", "/register/verify/email/send", { pendingId });
    if (!send.ok) {
      return { phase: "verify_failed", status: send.status, detail: send.text };
    }
    savePendingState({ ...pend, emailOtpSent: true });
    return {
      phase: "pending_email_otp",
      pendingId,
      message:
        "Email OTP sent. Set SYNTHESIS_EMAIL_OTP in .env or call again with emailOtp, then re-run synthesis-registration-advance.",
    };
  }

  const handle = process.env.SYNTHESIS_SOCIAL_HANDLE?.trim();
  if (!handle) {
    return {
      phase: "missing_env",
      missing: ["SYNTHESIS_SOCIAL_HANDLE (Twitter/X handle for verification)"],
    };
  }

  const tweet =
    (opts.tweetUrl ?? process.env.SYNTHESIS_SOCIAL_TWEET_URL ?? "").trim() || undefined;
  if (tweet) {
    const conf = await jsonNoAuth("POST", "/register/verify/social/confirm", {
      pendingId,
      tweetURL: tweet,
    });
    if (!conf.ok) {
      return { phase: "verify_failed", status: conf.status, detail: conf.text };
    }
    const after = await jsonNoAuth(
      "GET",
      `/register/verify/status?pendingId=${encodeURIComponent(pendingId)}`
    );
    const st3 = after.json as { verified?: boolean } | undefined;
    if (st3?.verified) {
      clearPendingState();
      const done = await completeSynthesisRegistration(pendingId);
      if (!done.ok) {
        return { phase: "complete_failed", status: done.status, detail: done.error ?? "" };
      }
      return { phase: "registration_complete", result: done };
    }
    return {
      phase: "pending_social_tweet",
      pendingId,
      message: "Tweet submitted; verification not complete yet.",
    };
  }

  const soc = await jsonNoAuth("POST", "/register/verify/social/send", {
    pendingId,
    handle,
  });
  if (!soc.ok) {
    return { phase: "verify_failed", status: soc.status, detail: soc.text };
  }
  const code = (soc.json as { verificationCode?: string })?.verificationCode;
  return {
    phase: "pending_social_tweet",
    pendingId,
    verificationCode: code,
    message:
      (soc.json as { message?: string })?.message ??
      `Tweet the verification code from @${handle}, then set SYNTHESIS_SOCIAL_TWEET_URL or pass tweetUrl.`,
  };
}
