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
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ─── Ethereum mainnet (canonical) ─────────────────────────────────────────────

const ADDRESSES = {
  /** Uniswap V3 SwapRouter02 */
  SWAP_ROUTER: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as const,
  /** QuoterV2 */
  QUOTER: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as const,
  WSTETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" as const,
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const,
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const,
} as const;

const QUOTER_ABI = parseAbi([
  "function quoteExactInput(bytes path,uint256 amountIn) external returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);

const ROUTER_ABI = parseAbi([
  "function exactInput((bytes,address,uint256,uint256,uint256)) external payable returns (uint256 amountOut)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
]);

function feeFromEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return Number.parseInt(v, 10);
}

/** Uniswap V3 path: token0 + fee + token1 + fee + token2 (fees are uint24, e.g. 500 = 0.05%). */
function encodeUniswapV3Path(
  a: `0x${string}`,
  feeAB: number,
  b: `0x${string}`,
  feeBC: number,
  c: `0x${string}`
): `0x${string}` {
  return encodePacked(
    ["address", "uint24", "address", "uint24", "address"],
    [a, feeAB, b, feeBC, c]
  );
}

export interface MainnetSwapQuote {
  wstETHIn: bigint;
  expectedUSDCOut: bigint;
  expectedUSDCOutFormatted: string;
  minUSDCOut: bigint;
  path: `0x${string}`;
}

export interface MainnetSwapResult {
  txHash: `0x${string}`;
  wstETHIn: bigint;
  usdcOutFormatted: string;
}

/**
 * wstETH → WETH → USDC on Ethereum mainnet via Uniswap V3 (same EOA as Base).
 */
export class MainnetSwapClient {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private account: ReturnType<typeof privateKeyToAccount>;
  private slippageBps: number;
  private feeWstEthWeth: number;
  private feeWethUsdc: number;

  constructor(agentPrivateKey: `0x${string}`, slippageBps = 50) {
    this.account = privateKeyToAccount(agentPrivateKey);
    this.slippageBps = slippageBps;
    this.feeWstEthWeth = feeFromEnv("MAINNET_UNISWAP_FEE_WSTETH_WETH", 500);
    this.feeWethUsdc = feeFromEnv("MAINNET_UNISWAP_FEE_WETH_USDC", 500);

    const transport = http(process.env.MAINNET_RPC_URL);
    this.publicClient = createPublicClient({
      chain: mainnet,
      transport,
    }) as PublicClient;

    this.walletClient = createWalletClient({
      account: this.account,
      chain: mainnet,
      transport,
    });
  }

  private encodePath(): `0x${string}` {
    return encodeUniswapV3Path(
      ADDRESSES.WSTETH,
      this.feeWstEthWeth,
      ADDRESSES.WETH,
      this.feeWethUsdc,
      ADDRESSES.USDC
    );
  }

  /**
   * For tiny USDC outputs, static quote vs execution can differ by a few wei — a strict 0.5% floor often reverts with `Too little received`.
   */
  private minUsdcOut(expectedUSDCOut: bigint): bigint {
    const tight = (expectedUSDCOut * BigInt(10000 - this.slippageBps)) / 10000n;
    if (expectedUSDCOut < 10_000n) {
      // < 0.01 USDC: allow extra headroom (still bounded by quoted expected)
      const loose = (expectedUSDCOut * 90n) / 100n; // 10% max slip for dust
      return tight < loose ? tight : loose;
    }
    return tight;
  }

  async getQuote(wstETHAmount: bigint): Promise<MainnetSwapQuote> {
    const path = this.encodePath();
    const [expectedUSDCOut] = (await this.publicClient.readContract({
      address: ADDRESSES.QUOTER,
      abi: QUOTER_ABI,
      functionName: "quoteExactInput",
      args: [path, wstETHAmount],
    })) as [bigint, ...unknown[]];

    const minUSDCOut = this.minUsdcOut(expectedUSDCOut);

    return {
      wstETHIn: wstETHAmount,
      expectedUSDCOut,
      expectedUSDCOutFormatted: formatUnits(expectedUSDCOut, 6),
      minUSDCOut,
      path,
    };
  }

  async swap(wstETHAmount: bigint): Promise<MainnetSwapResult> {
    console.log(`\n🔄 [Ethereum] Swapping ${formatEther(wstETHAmount)} wstETH → USDC (Uniswap V3)...`);

    const quote = await this.getQuote(wstETHAmount);
    console.log(`   Expected USDC out: ${quote.expectedUSDCOutFormatted} USDC`);

    await this.ensureApproval(ADDRESSES.WSTETH, ADDRESSES.SWAP_ROUTER, wstETHAmount);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

    const hash = await this.walletClient.writeContract({
      address: ADDRESSES.SWAP_ROUTER,
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
      chain: mainnet,
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`   ✅ Mainnet swap confirmed: ${hash}`);

    return {
      txHash: hash,
      wstETHIn: wstETHAmount,
      usdcOutFormatted: quote.expectedUSDCOutFormatted,
    };
  }

  async getWstETHBalance(): Promise<{ raw: bigint; formatted: string }> {
    const raw = (await this.publicClient.readContract({
      address: ADDRESSES.WSTETH,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.account.address],
    })) as bigint;
    return { raw, formatted: formatEther(raw) };
  }

  async getUSDCBalance(): Promise<{ raw: bigint; formatted: string }> {
    const raw = (await this.publicClient.readContract({
      address: ADDRESSES.USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.account.address],
    })) as bigint;
    return { raw, formatted: formatUnits(raw, 6) };
  }

  private async ensureApproval(
    token: `0x${string}`,
    spender: `0x${string}`,
    amount: bigint
  ): Promise<void> {
    const allowance = (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.account.address, spender],
    })) as bigint;

    if (allowance >= amount) return;

    const hash = await this.walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount],
      account: this.account,
      chain: mainnet,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
  }
}
