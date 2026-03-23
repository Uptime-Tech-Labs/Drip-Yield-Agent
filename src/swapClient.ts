import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodePacked,
  formatEther,
  formatUnits,
  type PublicClient,
  type WalletClient,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ─── Addresses (Base Mainnet) ─────────────────────────────────────────────────

const ADDRESSES = {
  // Aerodrome SlipStream (CL) swap router — confirmed on Basescan
  SLIPSTREAM_ROUTER: "0xBe6D8f0d05cC4be24d5167a3eF062215bE6D18a5" as const,
  // Aerodrome SlipStream quoter — for getting swap quotes off-chain
  SLIPSTREAM_QUOTER: "0x254cF9e1E6e233aa1AC962CB9B05b2CfeaAE15b0" as const,
  // Tokens
  WSTETH: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as const,
  WETH:   "0x4200000000000000000000000000000000000006" as const,
  USDC:   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
} as const;

/**
 * Tick spacings for Aerodrome SlipStream pools.
 *
 * wstETH/WETH: tickSpacing=1 (correlated assets, tight range, ~0.01% effective fee)
 * WETH/USDC:   tickSpacing=100 (volatile pair, ~0.05% effective fee, deepest liquidity)
 *
 * These encode the pool to route through in the multihop path bytes.
 */
const TICK_SPACINGS = {
  WSTETH_WETH: 1,
  WETH_USDC: 100,
} as const;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const ROUTER_ABI = parseAbi([
  // exactInput(ExactInputParams): tuple must be anonymous for parseAbi (order: path, recipient, deadline, amountIn, amountOutMinimum)
  "function exactInput((bytes,address,uint256,uint256,uint256)) external payable returns (uint256 amountOut)",
]);

const QUOTER_ABI = parseAbi([
  // quoteExactInput: multi-line human-readable ABI is rejected by abitype; keep on one line
  "function quoteExactInput(bytes path,uint256 amountIn) external returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Encode a multi-hop swap path for Aerodrome SlipStream.
 * Format: tokenA ++ tickSpacing ++ tokenB ++ tickSpacing ++ tokenC
 *
 * For wstETH → WETH → USDC:
 *   wstETH (20 bytes) | tickSpacing=1 (3 bytes) | WETH (20 bytes) | tickSpacing=100 (3 bytes) | USDC (20 bytes)
 */
function encodeSwapPath(
  tokenA: `0x${string}`,
  tickSpacingAB: number,
  tokenB: `0x${string}`,
  tickSpacingBC: number,
  tokenC: `0x${string}`
): `0x${string}` {
  return encodePacked(
    ["address", "int24", "address", "int24", "address"],
    [tokenA, tickSpacingAB, tokenB, tickSpacingBC, tokenC]
  );
}

// ─── SwapClient ───────────────────────────────────────────────────────────────

export interface SwapQuote {
  wstETHIn: bigint;
  expectedUSDCOut: bigint;
  expectedUSDCOutFormatted: string; // human-readable, e.g. "12.50"
  minUSDCOut: bigint;               // after slippage tolerance
  path: `0x${string}`;
}

export interface SwapResult {
  txHash: `0x${string}`;
  wstETHIn: bigint;
  usdcOut: bigint;
  usdcOutFormatted: string;
}

export class SwapClient {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private account: ReturnType<typeof privateKeyToAccount>;

  /** Slippage tolerance in basis points (default: 50 = 0.5%) */
  private slippageBps: number;

  constructor(agentPrivateKey: `0x${string}`, slippageBps = 50) {
    this.account = privateKeyToAccount(agentPrivateKey);
    this.slippageBps = slippageBps;

    this.publicClient = createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL),
    }) as PublicClient;

    this.walletClient = createWalletClient({
      account: this.account,
      chain: base,
      transport: http(process.env.BASE_RPC_URL),
    });
  }

  /**
   * Get a quote for swapping wstETH → WETH → USDC.
   * Uses the Aerodrome SlipStream Quoter (off-chain simulation, no gas cost).
   */
  async getQuote(wstETHAmount: bigint): Promise<SwapQuote> {
    const path = encodeSwapPath(
      ADDRESSES.WSTETH,
      TICK_SPACINGS.WSTETH_WETH,
      ADDRESSES.WETH,
      TICK_SPACINGS.WETH_USDC,
      ADDRESSES.USDC
    );

    const [expectedUSDCOut] = await this.publicClient.readContract({
      address: ADDRESSES.SLIPSTREAM_QUOTER,
      abi: QUOTER_ABI,
      functionName: "quoteExactInput",
      args: [path, wstETHAmount],
    }) as [bigint, ...unknown[]];

    // Apply slippage: minOut = expectedOut * (10000 - slippageBps) / 10000
    const minUSDCOut = (expectedUSDCOut * BigInt(10000 - this.slippageBps)) / 10000n;

    return {
      wstETHIn: wstETHAmount,
      expectedUSDCOut,
      expectedUSDCOutFormatted: formatUnits(expectedUSDCOut, 6), // USDC has 6 decimals
      minUSDCOut,
      path,
    };
  }

  /**
   * Execute the wstETH → WETH → USDC swap via Aerodrome SlipStream exactInput.
   *
   * Steps:
   *   1. Check and set wstETH allowance for the router
   *   2. Call exactInput with the multi-hop path
   *   3. USDC lands in the agent wallet, ready for x402 payments
   */
  async swap(wstETHAmount: bigint): Promise<SwapResult> {
    console.log(`\n🔄 Swapping ${formatEther(wstETHAmount)} wstETH → USDC via Aerodrome SlipStream...`);

    // Step 1: Get quote to compute minAmountOut
    const quote = await this.getQuote(wstETHAmount);
    console.log(`   Expected USDC out: ${quote.expectedUSDCOutFormatted} USDC`);
    console.log(`   Min USDC out (${this.slippageBps / 100}% slippage): ${formatUnits(quote.minUSDCOut, 6)} USDC`);

    // Step 2: Ensure router has approval to spend wstETH
    await this.ensureApproval(
      ADDRESSES.WSTETH,
      ADDRESSES.SLIPSTREAM_ROUTER,
      wstETHAmount
    );

    // Step 3: Execute swap — exactInput multi-hop
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min deadline

    const hash = await this.walletClient.writeContract({
      address: ADDRESSES.SLIPSTREAM_ROUTER,
      abi: ROUTER_ABI,
      functionName: "exactInput",
      args: [
        [
          quote.path,
          this.account.address,
          deadline,
          wstETHAmount,
          quote.minUSDCOut,
        ],
      ],
      account: this.account,
      chain: base,
    });

    console.log(`   Swap tx submitted: ${hash}`);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`   ✅ Swap confirmed in block ${receipt.blockNumber}`);

    // Read actual USDC balance delta by re-reading balance
    // (In production you'd parse the Transfer event from receipt.logs)
    const usdcBalance = await this.publicClient.readContract({
      address: ADDRESSES.USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.account.address],
    }) as bigint;

    return {
      txHash: hash,
      wstETHIn: wstETHAmount,
      usdcOut: quote.expectedUSDCOut, // approximate; parse logs for exact
      usdcOutFormatted: quote.expectedUSDCOutFormatted,
    };
  }

  /**
   * Check the agent wallet's current USDC balance.
   */
  async getUSDCBalance(): Promise<{ raw: bigint; formatted: string }> {
    const raw = await this.publicClient.readContract({
      address: ADDRESSES.USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.account.address],
    }) as bigint;

    return { raw, formatted: formatUnits(raw, 6) };
  }

  /**
   * Check the agent wallet's current wstETH balance.
   */
  async getWstETHBalance(): Promise<{ raw: bigint; formatted: string }> {
    const raw = await this.publicClient.readContract({
      address: ADDRESSES.WSTETH,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.account.address],
    }) as bigint;

    return { raw, formatted: formatEther(raw) };
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  /**
   * Approve the spender if current allowance is insufficient.
   * Uses exact amount (not max) to minimize approval surface.
   */
  private async ensureApproval(
    token: `0x${string}`,
    spender: `0x${string}`,
    amount: bigint
  ): Promise<void> {
    const allowance = await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.account.address, spender],
    }) as bigint;

    if (allowance >= amount) {
      console.log(`   Allowance sufficient (${formatEther(allowance)} wstETH), skipping approve`);
      return;
    }

    console.log(`   Approving router to spend ${formatEther(amount)} wstETH...`);
    const hash = await this.walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount],
      account: this.account,
      chain: base,
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`   ✅ Approval confirmed`);
  }
}
