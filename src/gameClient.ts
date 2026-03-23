import { setDefaultResultOrder } from "node:dns";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Prefer A records over AAAA so `fetch` does not fail with `AggregateError` when IPv6 is broken
 * but IPv4 works (common on some LANs / VPNs). Set `GAME_DNS_IPV4_FIRST=0` to use Node default.
 */
if (process.env.GAME_DNS_IPV4_FIRST !== "0" && process.env.GAME_DNS_IPV4_FIRST !== "false") {
  setDefaultResultOrder("ipv4first");
}

/** Default [x402 games](https://play.0000402.xyz/) origin — public TLS; use default Node `fetch`. */
const DEFAULT_GAME_API_BASE = "https://play.0000402.xyz";

/**
 * Trim, strip optional quotes from `.env`, validate with WHATWG URL, normalize (no trailing slash).
 * Avoids `Invalid URL` / broken `Request` when env has stray whitespace or quotes.
 */
export function normalizeGameApiBaseUrl(raw: string | undefined): string {
  let s = (raw ?? DEFAULT_GAME_API_BASE).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (!s) {
    throw new Error("GAME_API_BASE_URL is empty after trimming");
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(
      `GAME_API_BASE_URL must be an absolute http(s) URL (got ${JSON.stringify(raw)}). Example: ${DEFAULT_GAME_API_BASE}`
    );
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`GAME_API_BASE_URL must use http or https (got ${u.protocol})`);
  }
  const path = u.pathname.replace(/\/+$/, "");
  return path && path !== "/" ? `${u.origin}${path}` : u.origin;
}

/**
 * Game HTTP uses **undici** by default (more reliable DNS/TLS with Node 18 than `globalThis.fetch` on some networks).
 * Set `GAME_USE_NODE_FETCH=1` to use the runtime's native fetch instead.
 *
 * `GAME_TLS_INSECURE=1` — only for a custom host with a bad cert.
 */
function createUnderlyingFetch(): typeof globalThis.fetch {
  if (process.env.GAME_USE_NODE_FETCH === "1" || process.env.GAME_USE_NODE_FETCH === "true") {
    return globalThis.fetch.bind(globalThis);
  }
  const insecure =
    process.env.GAME_TLS_INSECURE === "1" || process.env.GAME_TLS_INSECURE === "true";
  const dispatcher = new Agent({
    connect: {
      rejectUnauthorized: !insecure,
    },
  });
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1])) as unknown as typeof globalThis.fetch;
}

function createX402Client(agentPrivateKey: `0x${string}`): x402Client {
  const account = privateKeyToAccount(agentPrivateKey);
  const rpc = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpc),
  });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer,
    schemeOptions: { 8453: { rpcUrl: rpc } },
  });
  return client;
}

export interface PlayRequest {
  /** Payout recipient — always set by GameClient from the agent key; do not omit. */
  address?: `0x${string}`;
  betAmount?: string;
  choice?: string;
  [key: string]: unknown;
}

export interface PlayResult {
  won: boolean;
  payout?: string;
  outcome?: string;
  [key: string]: unknown;
}

function formatGameFetchError(e: unknown, url: string): string {
  const sub =
    e instanceof AggregateError && Array.isArray(e.errors) && e.errors.length > 0
      ? e.errors.map((x) => (x instanceof Error ? x.message : String(x))).join("; ")
      : "";
  const err = e as Error & { cause?: unknown };
  const base = err instanceof Error ? err.message : String(e);
  const cause = err.cause != null ? ` (${String(err.cause)})` : "";
  const extra = sub ? ` — ${sub}` : "";
  return `Game API request failed for ${url}: ${base}${cause}${extra}. Browser can work while Node fails (e.g. IPv6); this app prefers IPv4 DNS order by default (GAME_DNS_IPV4_FIRST). Check VPN/firewall; for a custom host with TLS issues set GAME_TLS_INSECURE=1.`;
}

/**
 * GameClient: x402 payment-enabled fetch + optional TLS override for the game origin.
 */
export class GameClient {
  private fetch: typeof globalThis.fetch;
  private rawFetch: typeof globalThis.fetch;
  private baseUrl: string;
  /** Same EOA as the x402 signer — required by POST /play and /rps (`address` in JSON body). */
  private readonly payerAddress: `0x${string}`;

  constructor(agentPrivateKey: `0x${string}`) {
    this.payerAddress = privateKeyToAccount(agentPrivateKey).address;
    this.baseUrl = normalizeGameApiBaseUrl(process.env.GAME_API_BASE_URL);
    this.rawFetch = createUnderlyingFetch();
    const x402 = createX402Client(agentPrivateKey);
    this.fetch = wrapFetchWithPayment(this.rawFetch, x402);
  }

  async play(request: PlayRequest = {}): Promise<PlayResult> {
    console.log("\n🎲 Sending play request via x402...");

    const url = `${this.baseUrl}/play`;
    const body = { ...request, address: this.payerAddress };
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(formatGameFetchError(e, url));
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Game server error ${response.status}: ${error}`);
    }

    const raw = (await response.json()) as PlayResult & { result?: string };
    return {
      ...raw,
      won: raw.result === "win" || raw.won === true,
    };
  }

  /**
   * POST /play without paying — expect 402 and PAYMENT-REQUIRED header (x402 v1/v2).
   */
  async getPaymentRequirements(): Promise<unknown> {
    let response: Response;
    try {
      response = await this.rawFetch(`${this.baseUrl}/play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: this.payerAddress }),
      });
    } catch (e) {
      throw new Error(formatGameFetchError(e, `${this.baseUrl}/play`));
    }

    if (response.status === 402) {
      const paymentRequired =
        response.headers.get("PAYMENT-REQUIRED") ??
        response.headers.get("payment-required");
      if (paymentRequired) {
        return JSON.parse(Buffer.from(paymentRequired, "base64").toString("utf8"));
      }
    }

    return {
      httpStatus: response.status,
      note:
        "Expected 402 with PAYMENT-REQUIRED header for x402 discovery; got a different response.",
    };
  }
}
