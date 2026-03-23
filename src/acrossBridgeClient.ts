import { createPublicClient, createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

/** See [Across Swap API](https://github.com/across-protocol/skills/blob/master/skills/swap/SKILL.md) */
const ACROSS_API = "https://app.across.to/api";

/** Canonical mainnet wstETH */
const WSTETH_ETHEREUM = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" as const;
const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const ORIGIN_CHAIN_ID = 1;
const DESTINATION_CHAIN_ID = 8453;

export interface AcrossQuoteSummary {
  inputAmount: string;
  expectedOutputAmount?: string;
  minOutputAmount?: string;
  feesTotal?: string;
  crossSwapType?: string;
}

interface SwapApprovalResponse {
  approvalTxns?: Array<{
    chainId: number;
    to: `0x${string}`;
    data: `0x${string}`;
    gas?: string;
  }>;
  swapTx?: {
    chainId: number;
    to: `0x${string}`;
    data: `0x${string}`;
    gas?: string;
  };
  inputAmount?: string;
  expectedOutputAmount?: string;
  minOutputAmount?: string;
  fees?: { total?: { amount?: string } };
  crossSwapType?: string;
  message?: string;
}

interface DepositStatusResponse {
  status?: string;
  fillTxnRef?: string;
  depositTxnRef?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * [Across](https://app.across.to/) Swap API — same-asset bridge or **any-to-any** (e.g. wstETH on Ethereum → USDC on Base).
 */
export class AcrossBridgeClient {
  private publicClient;
  private walletClient;
  private account: ReturnType<typeof privateKeyToAccount>;
  private depositor: `0x${string}`;

  constructor(agentPrivateKey: `0x${string}`, depositorAddress: `0x${string}`) {
    this.account = privateKeyToAccount(agentPrivateKey);
    this.depositor = depositorAddress;
    const rpc = process.env.MAINNET_RPC_URL;
    if (!rpc?.trim()) {
      throw new Error("AcrossBridgeClient: MAINNET_RPC_URL is required");
    }
    const transport = http(rpc);
    this.publicClient = createPublicClient({ chain: mainnet, transport });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: mainnet,
      transport,
    });
  }

  private buildApprovalUrl(
    inputToken: string,
    outputToken: string,
    amountRaw: bigint
  ): string {
    const p = new URLSearchParams({
      tradeType: "exactInput",
      amount: amountRaw.toString(),
      inputToken: inputToken.toLowerCase(),
      outputToken: outputToken.toLowerCase(),
      originChainId: String(ORIGIN_CHAIN_ID),
      destinationChainId: String(DESTINATION_CHAIN_ID),
      depositor: this.depositor,
      slippage: "auto",
    });
    const integrator = process.env.ACROSS_INTEGRATOR_ID?.trim();
    if (integrator) p.set("integratorId", integrator);
    return `${ACROSS_API}/swap/approval?${p.toString()}`;
  }

  private async fetchApproval(
    inputToken: string,
    outputToken: string,
    amountRaw: bigint
  ): Promise<SwapApprovalResponse> {
    const res = await fetch(this.buildApprovalUrl(inputToken, outputToken, amountRaw));
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Across swap/approval failed ${res.status}: ${t.slice(0, 500)}`);
    }
    return (await res.json()) as SwapApprovalResponse;
  }

  /** USDC (Ethereum) → USDC (Base), amount in USDC (6 decimals). */
  async getQuoteUsdcBridge(amountUsdcRaw: bigint): Promise<AcrossQuoteSummary> {
    return this.quoteToSummary(
      await this.fetchApproval(USDC_ETHEREUM, USDC_BASE, amountUsdcRaw),
      amountUsdcRaw
    );
  }

  /** wstETH (Ethereum) → USDC (Base), amount in wei (18 decimals). Uses origin swap + bridge (`anyToBridgeable`). */
  async getQuoteWstethToBaseUsdc(amountWstWei: bigint): Promise<AcrossQuoteSummary> {
    return this.quoteToSummary(
      await this.fetchApproval(WSTETH_ETHEREUM, USDC_BASE, amountWstWei),
      amountWstWei
    );
  }

  private quoteToSummary(
    j: SwapApprovalResponse,
    amountRaw: bigint
  ): AcrossQuoteSummary {
    return {
      inputAmount: j.inputAmount ?? amountRaw.toString(),
      expectedOutputAmount: j.expectedOutputAmount,
      minOutputAmount: j.minOutputAmount,
      feesTotal: j.fees?.total?.amount,
      crossSwapType: j.crossSwapType,
    };
  }

  private async executeOriginTx(j: SwapApprovalResponse): Promise<`0x${string}`> {
    if (!j.swapTx?.to || !j.swapTx?.data) {
      throw new Error("Across response missing swapTx");
    }

    for (const approval of j.approvalTxns ?? []) {
      if (approval.chainId !== ORIGIN_CHAIN_ID) {
        throw new Error(`Unexpected approval chainId ${approval.chainId}`);
      }
      const gas =
        approval.gas != null && BigInt(String(approval.gas)) > 0n
          ? BigInt(String(approval.gas))
          : await this.publicClient.estimateGas({
              account: this.account.address,
              to: approval.to,
              data: approval.data,
            });

      const hash = await this.walletClient.sendTransaction({
        to: approval.to,
        data: approval.data,
        gas,
        chain: mainnet,
        account: this.account,
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
    }

    const st = j.swapTx;
    const gasLimit =
      st.gas != null && BigInt(String(st.gas)) > 0n
        ? BigInt(String(st.gas))
        : await this.publicClient.estimateGas({
            account: this.account.address,
            to: st.to,
            data: st.data,
          });

    const depositTxHash = await this.walletClient.sendTransaction({
      to: st.to,
      data: st.data,
      gas: gasLimit,
      chain: mainnet,
      account: this.account,
    });

    await this.publicClient.waitForTransactionReceipt({ hash: depositTxHash });
    return depositTxHash;
  }

  /** Bridge USDC eth → USDC Base (same-asset). */
  async bridgeUsdcToBase(amountUsdcRaw: bigint): Promise<{
    depositTxHash: `0x${string}`;
    expectedOutput?: string;
    fillTxnRef?: `0x${string}`;
    status: string;
  }> {
    const j = await this.fetchApproval(USDC_ETHEREUM, USDC_BASE, amountUsdcRaw);
    const depositTxHash = await this.executeOriginTx(j);
    const { status, fillTxnRef } = await this.pollDepositStatus(depositTxHash);
    return {
      depositTxHash,
      expectedOutput: j.expectedOutputAmount,
      fillTxnRef: fillTxnRef as `0x${string}` | undefined,
      status,
    };
  }

  /** Cross-chain swap: wstETH on Ethereum → USDC on Base (Across aggregates origin DEX + bridge). */
  async bridgeWstethToBaseUsdc(amountWstWei: bigint): Promise<{
    depositTxHash: `0x${string}`;
    expectedOutput?: string;
    fillTxnRef?: `0x${string}`;
    status: string;
    crossSwapType?: string;
  }> {
    const j = await this.fetchApproval(WSTETH_ETHEREUM, USDC_BASE, amountWstWei);
    const depositTxHash = await this.executeOriginTx(j);
    const { status, fillTxnRef } = await this.pollDepositStatus(depositTxHash);
    return {
      depositTxHash,
      expectedOutput: j.expectedOutputAmount,
      fillTxnRef: fillTxnRef as `0x${string}` | undefined,
      status,
      crossSwapType: j.crossSwapType,
    };
  }

  private async pollDepositStatus(
    depositTxHash: `0x${string}`,
    maxWaitMs = 120_000
  ): Promise<{ status: string; fillTxnRef?: string }> {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < maxWaitMs) {
      if (attempt > 0) await sleep(10_000);
      else await sleep(3_000);
      attempt++;

      const r = await fetch(
        `${ACROSS_API}/deposit/status?depositTxnRef=${depositTxHash}`
      );
      if (!r.ok) {
        await sleep(10_000);
        continue;
      }
      const s = (await r.json()) as DepositStatusResponse;
      const st = s.status ?? "unknown";
      if (st === "filled") {
        return { status: st, fillTxnRef: s.fillTxnRef };
      }
      if (st === "expired" || st === "refunded") {
        throw new Error(`Across deposit ${st}: ${depositTxHash}`);
      }
    }
    return { status: "pending" };
  }
}
