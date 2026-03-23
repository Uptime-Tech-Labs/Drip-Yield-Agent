import { loadProjectEnv } from "./loadEnv";
loadProjectEnv();

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Mastra } from "@mastra/core";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { MainnetYieldVaultClient } from "./mainnetVaultClient";
import { MainnetSwapClient } from "./mainnetSwapClient";
import { AcrossBridgeClient } from "./acrossBridgeClient";
import { GameClient } from "./gameClient";
import { SwapClient } from "./swapClient";
import { agentMemory, MEMORY_RESOURCE_ID, MEMORY_THREAD_ID } from "./agentMemory";
import {
  completeSynthesisRegistration,
  loadSynthesisApiKey,
  loadSynthesisRegistration,
  synthesisRequest,
} from "./synthesisClient";
import { advanceSynthesisRegistration } from "./synthesisRegistration";
import { advanceSynthesisSubmission, describeSubmissionNextStep } from "./synthesisSubmission";

// ─── Config ───────────────────────────────────────────────────────────────────

const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY! as `0x${string}`;
const AGENT_WALLET_ADDRESS = process.env.AGENT_WALLET_ADDRESS! as `0x${string}`;
/** Mainnet `drawYield` recipient — defaults to the agent EOA (must be whitelisted on the vault). */
const MAINNET_DRAW_RECIPIENT = (process.env.MAINNET_DRAW_RECIPIENT ?? process.env.AGENT_WALLET_ADDRESS ?? "").trim() as `0x${string}`;

// ─── Clients ──────────────────────────────────────────────────────────────────

const mainnetVault = new MainnetYieldVaultClient(AGENT_PRIVATE_KEY);
const mainnetSwapper = new MainnetSwapClient(AGENT_PRIVATE_KEY, 50);
/** Base chain only — USDC balance for x402 after you bridge USDC here. */
const baseBalances = new SwapClient(AGENT_PRIVATE_KEY, 50);
/** [Across](https://github.com/across-protocol/skills) — `GET /swap/approval`: USDC→USDC bridge or wstETH→Base USDC (`anyToBridgeable`). */
const across = new AcrossBridgeClient(AGENT_PRIVATE_KEY, AGENT_WALLET_ADDRESS);
const game = new GameClient(AGENT_PRIVATE_KEY);

// ─── Tools ────────────────────────────────────────────────────────────────────

const checkMainnetYieldTool = createTool({
  id: "check-mainnet-yield",
  description:
    "Read Ethereum mainnet MainnetYieldVault (availableYieldWstETH, maxDrawPerTx, vaultStatus).",
  inputSchema: z.object({}),
  execute: async () => {
    if (!mainnetVault.isConfigured()) {
      return {
        configured: false,
        note: "Set MAINNET_RPC_URL and MAINNET_VAULT_ADDRESS in .env.",
      };
    }
    const s = await mainnetVault.getSnapshot();
    const avail = formatEther(s.availableYieldWstETH);
    const cap = formatEther(s.maxDrawPerTx);
    return {
      configured: true,
      availableYieldWstETH: avail,
      maxDrawPerTxWstETH: cap,
      yieldStETH: formatEther(s.yieldStETH),
      note:
        s.availableYieldWstETH === 0n
          ? "No drawable yield on mainnet yet."
          : `Up to ${cap} wstETH per drawYield tx; ${avail} wstETH yield available. Draw to agent, swap on mainnet, bridge USDC to Base, then play.`,
    };
  },
});

const drawMainnetYieldTool = createTool({
  id: "draw-mainnet-yield",
  description:
    "MainnetYieldVault.drawYield → sends wstETH yield to MAINNET_DRAW_RECIPIENT (default: agent EOA on Ethereum). " +
    "That address must be whitelisted. Costs ETH gas. Then swap wstETH→USDC on mainnet, bridge USDC to Base, play.",
  inputSchema: z.object({
    amountWstETH: z
      .string()
      .describe('wstETH amount e.g. "0.001", or "max" for min(availableYield, maxDrawPerTx)'),
  }),
  execute: async ({ amountWstETH }) => {
    if (!mainnetVault.isConfigured()) {
      return {
        success: false,
        error: "Mainnet vault not configured (MAINNET_RPC_URL, MAINNET_VAULT_ADDRESS).",
      };
    }
    if (!MAINNET_DRAW_RECIPIENT.startsWith("0x")) {
      return {
        success: false,
        error: "Set AGENT_WALLET_ADDRESS or MAINNET_DRAW_RECIPIENT to a 0x address whitelisted on the vault.",
      };
    }

    const ok = await mainnetVault.isRecipientWhitelisted(MAINNET_DRAW_RECIPIENT);
    if (!ok) {
      return {
        success: false,
        error: `Recipient ${MAINNET_DRAW_RECIPIENT} is not whitelisted on MainnetYieldVault.`,
      };
    }

    const snap = await mainnetVault.getSnapshot();
    const cap = snap.maxDrawPerTx < snap.availableYieldWstETH ? snap.maxDrawPerTx : snap.availableYieldWstETH;

    let amount: bigint;
    if (amountWstETH.trim().toLowerCase() === "max") {
      amount = cap;
    } else {
      amount = parseEther(amountWstETH);
    }

    if (amount === 0n) {
      return { success: false, error: "Amount is zero." };
    }
    if (amount > snap.availableYieldWstETH) {
      return {
        success: false,
        error: `Only ${formatEther(snap.availableYieldWstETH)} wstETH yield available.`,
      };
    }
    if (amount > snap.maxDrawPerTx) {
      return {
        success: false,
        error: `Per-tx cap is ${formatEther(snap.maxDrawPerTx)} wstETH.`,
      };
    }

    const txHash = await mainnetVault.drawYield(amount, MAINNET_DRAW_RECIPIENT);
    return {
      success: true,
      txHash,
      amountWstETH: formatEther(amount),
      recipient: MAINNET_DRAW_RECIPIENT,
      message: `Yield sent on Ethereum. Next: quote-across-wsteth-to-base-usdc → bridge-wsteth-to-base-usdc-across (preferred), or Uniswap swap + bridge-usdc-to-base, then play on Base.`,
    };
  },
});

const getMainnetSwapQuoteTool = createTool({
  id: "get-mainnet-swap-quote",
  description:
    "Quote wstETH → USDC on Ethereum mainnet (Uniswap V3). Use after drawing yield to the agent wallet on mainnet.",
  inputSchema: z.object({
    amountEther: z.string().describe('wstETH amount to quote, e.g. "0.001"'),
  }),
  execute: async ({ amountEther }) => {
    const amount = parseEther(amountEther);
    const quote = await mainnetSwapper.getQuote(amount);
    return {
      chain: "ethereum",
      wstETHIn: amountEther,
      expectedUSDC: quote.expectedUSDCOutFormatted,
      minUSDCAfterSlippage: formatUnits(quote.minUSDCOut, 6),
      route: "wstETH → WETH → USDC (Uniswap V3 on Ethereum)",
    };
  },
});

const swapMainnetWstethTool = createTool({
  id: "swap-mainnet-wsteth-to-usdc",
  description:
    "Swap wstETH in the agent's Ethereum wallet to USDC via Uniswap V3 (mainnet). Requires ETH for gas. Then bridge USDC to Base.",
  inputSchema: z.object({
    amountEther: z.string().describe('wstETH to swap, e.g. "0.001"'),
  }),
  execute: async ({ amountEther }) => {
    const amount = parseEther(amountEther);
    const wst = await mainnetSwapper.getWstETHBalance();
    if (wst.raw < amount) {
      return {
        success: false,
        error: `Ethereum wallet has only ${wst.formatted} wstETH. Draw yield first.`,
      };
    }
    const result = await mainnetSwapper.swap(amount);
    const usdc = await mainnetSwapper.getUSDCBalance();
    return {
      success: true,
      txHash: result.txHash,
      wstETHSwapped: amountEther,
      usdcOnEthereum: usdc.formatted,
      message: `USDC on Ethereum: ${usdc.formatted}. Bridge to Base (bridge-usdc-to-base), then check-usdc-balance and play-game.`,
    };
  },
});

const quoteAcrossUsdcBridgeTool = createTool({
  id: "quote-across-usdc-bridge",
  description:
    "Quote USDC (Ethereum) → USDC (Base) via Across Swap API — no transaction. " +
    "See https://github.com/across-protocol/skills (swap/approval).",
  inputSchema: z.object({
    amountUSDC: z.string().describe('USDC amount on Ethereum to bridge, e.g. "10.5"'),
  }),
  execute: async ({ amountUSDC }) => {
    try {
      const raw = parseUnits(amountUSDC, 6);
      const q = await across.getQuoteUsdcBridge(raw);
      const out =
        q.expectedOutputAmount != null
          ? formatUnits(BigInt(q.expectedOutputAmount), 6)
          : undefined;
      return {
        ...q,
        expectedOutputUSDC: out,
        note: "Quotes are not cached; re-fetch before bridging.",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: msg };
    }
  },
});

const quoteAcrossWstethToBaseUsdcTool = createTool({
  id: "quote-across-wsteth-to-base-usdc",
  description:
    "Quote wstETH (Ethereum) → USDC (Base) in one Across flow — origin swap + bridge (anyToBridgeable). " +
    "No transaction. Prefer this over Uniswap + USDC bridge when you want fewer mainnet steps.",
  inputSchema: z.object({
    amountWstETH: z.string().describe('wstETH amount on Ethereum, e.g. "0.001"'),
  }),
  execute: async ({ amountWstETH }) => {
    try {
      const raw = parseEther(amountWstETH);
      const q = await across.getQuoteWstethToBaseUsdc(raw);
      const out =
        q.expectedOutputAmount != null
          ? formatUnits(BigInt(q.expectedOutputAmount), 6)
          : undefined;
      return {
        ...q,
        expectedOutputUSDCOnBase: out,
        crossSwapType: q.crossSwapType,
        note: "Quotes are not cached; re-fetch before bridging. Executes on mainnet (approvals + deposit tx).",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: msg };
    }
  },
});

const bridgeWstethToBaseUsdcAcrossTool = createTool({
  id: "bridge-wsteth-to-base-usdc-across",
  description:
    "Swap + bridge wstETH on Ethereum to USDC on Base via Across (single origin deposit: approvals + swapTx). " +
    "Requires ETH for gas on mainnet. Skips separate Uniswap + USDC bridge — use after draw-mainnet-yield.",
  inputSchema: z.object({
    amountWstETH: z.string().describe('wstETH to send from Ethereum wallet, e.g. "0.001"'),
  }),
  execute: async ({ amountWstETH }) => {
    try {
      const raw = parseEther(amountWstETH);
      const wst = await mainnetSwapper.getWstETHBalance();
      if (wst.raw < raw) {
        return {
          success: false,
          error: `Ethereum wallet has only ${wst.formatted} wstETH — draw yield or reduce amount.`,
        };
      }
      const result = await across.bridgeWstethToBaseUsdc(raw);
      const baseUsdc = await baseBalances.getUSDCBalance();
      return {
        success: true,
        depositTxHash: result.depositTxHash,
        acrossStatus: result.status,
        crossSwapType: result.crossSwapType,
        fillTxnRef: result.fillTxnRef,
        expectedUsdcOutRaw: result.expectedOutput,
        baseUsdcBalanceAfter: baseUsdc.formatted,
        message:
          result.status === "filled"
            ? `Across fill complete. Base USDC: ${baseUsdc.formatted}.`
            : `Deposit tx ${result.depositTxHash} submitted; status=${result.status}.`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  },
});

const bridgeUsdcToBaseTool = createTool({
  id: "bridge-usdc-to-base",
  description:
    "Bridge USDC from Ethereum mainnet to Base using Across (app.across.to/api/swap/approval). " +
    "Submits approval txs if needed, then the deposit tx on Ethereum — requires ETH for gas. " +
    "Recipient on Base defaults to the same agent address.",
  inputSchema: z.object({
    amountUSDC: z.string().describe('USDC amount to send from Ethereum wallet, e.g. "5.0"'),
  }),
  execute: async ({ amountUSDC }) => {
    try {
      const raw = parseUnits(amountUSDC, 6);
      const ethUsdc = await mainnetSwapper.getUSDCBalance();
      if (ethUsdc.raw < raw) {
        return {
          success: false,
          error: `Only ${ethUsdc.formatted} USDC on Ethereum — reduce amount or swap more wstETH first.`,
        };
      }
      const result = await across.bridgeUsdcToBase(raw);
      const baseUsdc = await baseBalances.getUSDCBalance();
      return {
        success: true,
        depositTxHash: result.depositTxHash,
        acrossStatus: result.status,
        fillTxnRef: result.fillTxnRef,
        expectedUsdcOutRaw: result.expectedOutput,
        baseUsdcBalanceAfter: baseUsdc.formatted,
        message:
          result.status === "filled"
            ? `Across fill complete. Base USDC balance (may reflect next block): ${baseUsdc.formatted}.`
            : `Deposit tx ${result.depositTxHash} submitted; status=${result.status}. Use check-wallet-balances or a block explorer.`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  },
});

const checkWalletBalancesTool = createTool({
  id: "check-wallet-balances",
  description:
    "Show agent wstETH/USDC on Ethereum and wstETH/USDC on Base. x402 play uses USDC on Base.",
  inputSchema: z.object({}),
  execute: async () => {
    const [ethWst, ethUsdc, baseWst, baseUsdc] = await Promise.all([
      mainnetSwapper.getWstETHBalance(),
      mainnetSwapper.getUSDCBalance(),
      baseBalances.getWstETHBalance(),
      baseBalances.getUSDCBalance(),
    ]);
    return {
      ethereum: {
        wstETH: ethWst.formatted,
        USDC: ethUsdc.formatted,
      },
      base: {
        wstETH: baseWst.formatted,
        USDC: baseUsdc.formatted,
      },
      note:
        baseUsdc.raw > 0n
          ? `${baseUsdc.formatted} USDC on Base — can try play-game if that covers x402 cost.`
          : "Fund Base USDC via bridge after mainnet swap, then play-game.",
    };
  },
});

const checkGameCostTool = createTool({
  id: "check-game-cost",
  description: "Probe the game API for x402 payment requirements (price, token, facilitator).",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const paymentRequirements = await game.getPaymentRequirements();
      return { paymentRequirements };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        error: msg,
        hint: "BASE_RPC_URL needed for x402; GAME_API_BASE_URL must be a valid https URL. GAME_TLS_INSECURE only for broken certs on custom hosts.",
      };
    }
  },
});

const playGameTool = createTool({
  id: "play-game",
  description:
    "Play one round (POST /play). Pays with USDC on Base via x402; payout address is the agent wallet (set automatically). Ensure Base USDC first.",
  inputSchema: z.object({
    choice: z.string().optional().describe("Game choice if applicable"),
  }),
  execute: async ({ choice }) => {
    if (process.env.DRIPAGENT_SKIP_PLAY === "1" || process.env.DRIPAGENT_SKIP_PLAY === "true") {
      return {
        skipped: true,
        note: "DRIPAGENT_SKIP_PLAY is set — unset it to run play-game.",
      };
    }
    try {
      const result = await game.play({ choice });
      const usdcBal = await baseBalances.getUSDCBalance();
      return {
        won: result.won,
        outcome: result.outcome ?? "unknown",
        payout: result.payout ?? "0",
        remainingUSDC: usdcBal.formatted,
        message: result.won
          ? `Won. Payout: ${result.payout}. USDC on Base: ${usdcBal.formatted}`
          : `Lost. USDC on Base: ${usdcBal.formatted}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cause = e instanceof Error && e.cause != null ? String(e.cause) : "";
      return {
        success: false,
        error: msg + (cause ? ` ${cause}` : ""),
        hint: "Often missing Base USDC, bad BASE_RPC_URL, or GAME_API_BASE_URL. TLS override only if a custom game host has cert issues.",
      };
    }
  },
});

const synthesisAuthStatusTool = createTool({
  id: "synthesis-auth-status",
  description:
    "Whether The Synthesis API key (sk-synth-...) is configured — does not expose the key. See https://synthesis.md/skill.md",
  inputSchema: z.object({}),
  execute: async () => {
    const ok = loadSynthesisApiKey() != null;
    return {
      synthesisApiKeyConfigured: ok,
      note: ok
        ? "Bearer token available for synthesis-api-request."
        : "Set SYNTHESIS_API_KEY or put sk-synth-... on the first line of .synthesis-credentials (gitignored).",
    };
  },
});

const synthesisCompleteRegistrationTool = createTool({
  id: "synthesis-complete-registration",
  description:
    "Finish Synthesis signup: POST /register/complete with pendingId (after human verified email or social). " +
    "Saves sk-synth API key to .synthesis-credentials and writes participant/team metadata to .synthesis-registration.json; prints registration to stdout. See https://synthesis.md/skill.md",
  inputSchema: z.object({
    pendingId: z.string().describe("pendingId from POST /register/init after verification"),
  }),
  execute: async ({ pendingId }) => {
    const r = await completeSynthesisRegistration(pendingId);
    if (!r.ok) {
      return {
        success: false,
        httpStatus: r.status,
        error: r.error,
        hint: "Ensure pendingId is valid and verification completed (email OTP or social).",
      };
    }
    return {
      success: true,
      name: r.record!.name,
      participantId: r.record!.participantId,
      teamId: r.record!.teamId,
      registrationTxn: r.record!.registrationTxn,
      savedAt: r.record!.savedAt,
      apiKeySavedTo: r.apiKeySavedTo,
      registrationSavedTo: r.registrationSavedTo,
      note: "API key is only on disk in the credentials file — not echoed here. Registration details above are safe to report to your human.",
    };
  },
});

const synthesisShowRegistrationTool = createTool({
  id: "synthesis-show-registration",
  description:
    "Output saved Synthesis registration metadata from .synthesis-registration.json (name, participantId, teamId, basescan link). No API key.",
  inputSchema: z.object({}),
  execute: async () => {
    const rec = loadSynthesisRegistration();
    if (!rec) {
      return {
        saved: false,
        note: "No registration file yet — run synthesis-registration-advance or synthesis-complete-registration.",
      };
    }
    return {
      saved: true,
      registration: rec,
      summary: `${rec.name} | participant ${rec.participantId} | team ${rec.teamId}${rec.registrationTxn ? ` | ${rec.registrationTxn}` : ""}`,
    };
  },
});

const synthesisRegistrationAdvanceTool = createTool({
  id: "synthesis-registration-advance",
  description:
    "Drive The Synthesis registration with minimal human steps (https://synthesis.md/skill.md). " +
    "Uses SYNTHESIS_* env for agent + human profile. Flow: POST /register/init → email or social verify → /register/complete. " +
    "If phase is pending_email_otp, human sets SYNTHESIS_EMAIL_OTP or passes emailOtp and calls again. " +
    "If social, set SYNTHESIS_VERIFY_METHOD=social and SYNTHESIS_SOCIAL_HANDLE, then tweet the code and pass tweetUrl or SYNTHESIS_SOCIAL_TWEET_URL. " +
    "Use forceNewInit to start over.",
  inputSchema: z.object({
    emailOtp: z.string().optional().describe("6-digit email OTP if not in SYNTHESIS_EMAIL_OTP"),
    tweetUrl: z.string().optional().describe("Tweet URL for social verification"),
    forceNewInit: z.boolean().optional().describe("Clear .synthesis-pending.json and POST /register/init again"),
  }),
  execute: async ({ emailOtp, tweetUrl, forceNewInit }) => {
    try {
      const r = await advanceSynthesisRegistration({
        emailOtp,
        tweetUrl,
        forceNewInit: forceNewInit === true,
      });
      return { ...r, nextStep: describeSynthesisNextStep(r) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
});

const synthesisSubmissionAdvanceTool = createTool({
  id: "synthesis-submission-advance",
  description:
    "Create Synthesis hackathon project draft, transfer agent NFT to self-custody, and publish. " +
    "Requires public GitHub SYNTHESIS_PROJECT_REPO_URL and optional track/tools env (see .env.example). " +
    "https://synthesis.devfolio.co/submission/skill.md",
  inputSchema: z.object({
    createDraft: z.boolean().optional().describe("POST /projects if no draft (default true)"),
    transferSelfCustody: z
      .boolean()
      .optional()
      .describe("POST /participants/me/transfer/* when custodial (default true)"),
    publish: z.boolean().optional().describe("POST /projects/:uuid/publish (default true)"),
  }),
  execute: async ({ createDraft, transferSelfCustody, publish }) => {
    try {
      const r = await advanceSynthesisSubmission({
        createDraft: createDraft !== false,
        transferSelfCustody: transferSelfCustody !== false,
        publish: publish !== false,
      });
      return { ...r, nextStep: describeSubmissionNextStep(r) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
});

function describeSynthesisNextStep(
  r: Awaited<ReturnType<typeof advanceSynthesisRegistration>>
): string {
  switch (r.phase) {
    case "already_registered":
      return "Registered — use synthesis-auth-status / synthesis-api-request.";
    case "missing_env":
      return `Set env vars: ${r.missing.join(", ")}`;
    case "init_failed":
      return "Fix init payload or try again.";
    case "pending_email_otp":
      return "Set SYNTHESIS_EMAIL_OTP (or pass emailOtp) and call synthesis-registration-advance again.";
    case "pending_social_tweet":
      return "Post the tweet, then set SYNTHESIS_SOCIAL_TWEET_URL or pass tweetUrl.";
    case "verify_failed":
      return "Verification request failed — check API error detail.";
    case "complete_failed":
      return "Verified but /register/complete failed — see detail.";
    case "registration_complete":
      return "Done — API key saved to .synthesis-credentials";
    default:
      return "";
  }
}

const synthesisApiRequestTool = createTool({
  id: "synthesis-api-request",
  description:
    "Call The Synthesis hackathon API (https://synthesis.devfolio.co) with Bearer auth. " +
    "path must start with / (e.g. /teams/<uuid>). Do not paste UUIDs into user-visible text unless they asked.",
  inputSchema: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    path: z.string().describe('API path starting with /, e.g. "/teams/..."'),
    bodyJson: z.string().optional().describe("Optional JSON body string for POST/PATCH/PUT"),
  }),
  execute: async ({ method, path, bodyJson }) => {
    try {
      return await synthesisRequest(method ?? "GET", path, bodyJson);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// ─── Agent ────────────────────────────────────────────────────────────────────

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
});

export const yieldMaximizingDegeneracyAgent = new Agent({
  id: "yield-maximizing-degeneracy-agent",
  name: "Yield Maximizing Degeneracy Agent",
  instructions: `You automate: earn yield on Ethereum → USDC on Base → x402 game, and track [The Synthesis](https://synthesis.md/skill.md) hackathon registration.

You have **persistent memory** (conversation + working memory). Use it for Synthesis: goals, tracks, prizes — **never** store API keys in working memory; use synthesis-auth-status / .synthesis-credentials only.

**Full report pipeline** (do not skip Synthesis when the user asks for a pipeline or status report):
  0. **Synthesis:** synthesis-show-registration + synthesis-auth-status. If not registered, run **synthesis-registration-advance** (SYNTHESIS_* in .env — see .env.example). On phase pending_email_otp, human sets SYNTHESIS_EMAIL_OTP or passes emailOtp and you call advance again; on phase registration_complete, done. Only use synthesis-complete-registration(pendingId) if advance is not suitable. To **submit the project** (draft → self-custody → publish), use **synthesis-submission-advance** after setting **SYNTHESIS_PROJECT_REPO_URL** (public GitHub) per https://synthesis.devfolio.co/submission/skill.md
  1. check-mainnet-yield — yield available on MainnetYieldVault
  2. draw-mainnet-yield — wstETH to the agent EOA on Ethereum (must be whitelisted)
  3a. **Preferred:** quote-across-wsteth-to-base-usdc then bridge-wsteth-to-base-usdc-across — one Across cross-chain intent (wstETH eth → USDC Base)
  3b. **Alternative:** get-mainnet-swap-quote → swap-mainnet-wsteth-to-usdc (Uniswap) → quote-across-usdc-bridge → bridge-usdc-to-base
  4. check-wallet-balances — confirm USDC on Base
  5. check-game-cost — x402 price
  6. **play-game** — if Base USDC ≥ game cost and DRIPAGENT_SKIP_PLAY is not set, call play-game once to actually play (not only quote cost). If play fails with network error, report the error and suggest GAME_USE_NODE_FETCH=0 vs default, GAME_DNS_IPV4_FIRST, VPN.

There is no Base spending vault in this flow. Same private key controls Ethereum + Base EOAs.
Rules: mainnet txs cost ETH gas; be concise in reports.`,
  model: openrouter("anthropic/claude-sonnet-4-5"),
  memory: agentMemory,
  tools: {
    checkMainnetYieldTool,
    drawMainnetYieldTool,
    getMainnetSwapQuoteTool,
    swapMainnetWstethTool,
    quoteAcrossUsdcBridgeTool,
    quoteAcrossWstethToBaseUsdcTool,
    bridgeWstethToBaseUsdcAcrossTool,
    bridgeUsdcToBaseTool,
    checkWalletBalancesTool,
    checkGameCostTool,
    playGameTool,
    synthesisAuthStatusTool,
    synthesisCompleteRegistrationTool,
    synthesisShowRegistrationTool,
    synthesisRegistrationAdvanceTool,
    synthesisSubmissionAdvanceTool,
    synthesisApiRequestTool,
  },
});

const mastra = new Mastra({ agents: { yieldMaximizingDegeneracyAgent } });

async function main() {
  console.log("🎰 Yield Maximizing Degeneracy Agent starting...\n");
  await mainnetVault.logSnapshot();

  const reg = loadSynthesisRegistration();
  const synthKey = loadSynthesisApiKey();
  console.log("📝 The Synthesis (hackathon)");
  if (reg) {
    console.log(`   Saved registration: ${reg.name} | team ${reg.teamId}`);
    console.log(`   Registration tx: ${reg.registrationTxn ?? "(none)"}`);
  } else {
    console.log(
      "   No local registration file — set SYNTHESIS_* in .env and run synthesis-registration-advance (or let this script try above)."
    );
  }
  console.log(`   API key (sk-synth): ${synthKey ? "loaded" : "missing"}\n`);

  const adv = await advanceSynthesisRegistration({});
  console.log(`   Registration advance: ${adv.phase}`);
  if (adv.phase === "missing_env") {
    console.log(`   (missing env: ${adv.missing.join(", ")})`);
  }
  if (adv.phase === "pending_email_otp" && process.env.SYNTHESIS_EMAIL_OTP?.trim()) {
    const adv2 = await advanceSynthesisRegistration({
      emailOtp: process.env.SYNTHESIS_EMAIL_OTP.trim(),
    });
    console.log(`   Registration advance (OTP from env): ${adv2.phase}`);
  }

  const result = await mastra.getAgent("yieldMaximizingDegeneracyAgent").generateLegacy(
    `Run the FULL pipeline report:
     0) If not registered: synthesis-registration-advance (or synthesis-show-registration + synthesis-auth-status). Report Synthesis state.
     1–4) mainnet yield, draw if yield available, else note balances; Across or Uniswap path only if needed to fund Base.
     5) check-wallet-balances and check-game-cost.
     6) If Base USDC is enough for at least one play and DRIPAGENT_SKIP_PLAY is not set, call play-game once. If play fails, report the exact error.
     Be concise; include Synthesis section and game play result or skip reason.`,
    {
      memory: {
        resource: MEMORY_RESOURCE_ID,
        thread: MEMORY_THREAD_ID,
      },
    }
  );

  console.log("\n🤖 Agent Report:");
  console.log(result.text);
}

main().catch(console.error);
