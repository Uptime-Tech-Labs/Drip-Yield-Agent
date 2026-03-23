import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatEther,
} from "viem";
import { mainnet } from "viem/chains";
import type { PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Matches `MainnetYieldVault.sol` on Ethereum mainnet. */
const MAINNET_YIELD_VAULT_ABI = parseAbi([
  "function availableYieldWstETH() external view returns (uint256)",
  "function maxDrawPerTx() external view returns (uint256)",
  "function vaultStatus() external view returns (uint256 totalWstETH, uint256 principalStETH, uint256 currentStETH, uint256 yieldStETH, uint256 drawableWstETH, uint256 exchangeRate)",
  "function drawYield(uint256 amount, address recipient) external",
  "function recipientWhitelist(address recipient) external view returns (bool)",
]);

export interface MainnetYieldSnapshot {
  /** Same as `vaultStatus.drawableWstETH` — wstETH the agent could draw as yield right now. */
  availableYieldWstETH: bigint;
  maxDrawPerTx: bigint;
  totalWstETH: bigint;
  principalStETH: bigint;
  currentStETH: bigint;
  yieldStETH: bigint;
  drawableWstETH: bigint;
  exchangeRate: bigint;
}

/**
 * Read + write MainnetYieldVault on Ethereum (agent-signed `drawYield`).
 * Draw recipient must be whitelisted (typically `MAINNET_BRIDGE_RECIPIENT` in `.env`).
 */
export class MainnetYieldVaultClient {
  private publicClient: PublicClient | undefined;
  private walletClient: WalletClient | undefined;
  private vaultAddress: `0x${string}` | undefined;

  constructor(agentPrivateKey: `0x${string}`) {
    const rpc = process.env.MAINNET_RPC_URL;
    const addr = process.env.MAINNET_VAULT_ADDRESS;
    if (!rpc?.trim() || !addr?.trim()) return;

    this.vaultAddress = addr as `0x${string}`;
    const transport = http(rpc);
    this.publicClient = createPublicClient({
      chain: mainnet,
      transport,
    });

    const account = privateKeyToAccount(agentPrivateKey);
    this.walletClient = createWalletClient({
      account,
      chain: mainnet,
      transport,
    });
  }

  isConfigured(): boolean {
    return (
      this.publicClient !== undefined &&
      this.walletClient !== undefined &&
      this.vaultAddress !== undefined
    );
  }

  /**
   * Calls `availableYieldWstETH()`, `maxDrawPerTx()`, and `vaultStatus()` in parallel.
   */
  async getSnapshot(): Promise<MainnetYieldSnapshot> {
    if (!this.publicClient || !this.vaultAddress) {
      throw new Error("MainnetYieldVaultClient: set MAINNET_RPC_URL and MAINNET_VAULT_ADDRESS");
    }

    const [availableYieldWstETH, maxDrawPerTx, vs] = await Promise.all([
      this.publicClient.readContract({
        address: this.vaultAddress,
        abi: MAINNET_YIELD_VAULT_ABI,
        functionName: "availableYieldWstETH",
      }) as Promise<bigint>,
      this.publicClient.readContract({
        address: this.vaultAddress,
        abi: MAINNET_YIELD_VAULT_ABI,
        functionName: "maxDrawPerTx",
      }) as Promise<bigint>,
      this.publicClient.readContract({
        address: this.vaultAddress,
        abi: MAINNET_YIELD_VAULT_ABI,
        functionName: "vaultStatus",
      }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>,
    ]);

    return {
      availableYieldWstETH,
      maxDrawPerTx,
      totalWstETH: vs[0],
      principalStETH: vs[1],
      currentStETH: vs[2],
      yieldStETH: vs[3],
      drawableWstETH: vs[4],
      exchangeRate: vs[5],
    };
  }

  async isRecipientWhitelisted(recipient: `0x${string}`): Promise<boolean> {
    if (!this.publicClient || !this.vaultAddress) {
      throw new Error("MainnetYieldVaultClient: not configured");
    }
    return this.publicClient.readContract({
      address: this.vaultAddress,
      abi: MAINNET_YIELD_VAULT_ABI,
      functionName: "recipientWhitelist",
      args: [recipient],
    }) as Promise<boolean>;
  }

  /**
   * Agent pulls yield wstETH to `recipient` (must be whitelisted on the vault).
   */
  async drawYield(amount: bigint, recipient: `0x${string}`): Promise<`0x${string}`> {
    if (!this.publicClient || !this.walletClient || !this.vaultAddress) {
      throw new Error("MainnetYieldVaultClient: not configured for writes");
    }

    const hash = await this.walletClient.writeContract({
      address: this.vaultAddress,
      abi: MAINNET_YIELD_VAULT_ABI,
      functionName: "drawYield",
      args: [amount, recipient],
      chain: mainnet,
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async logSnapshot(): Promise<void> {
    if (!this.isConfigured()) {
      console.log("\n📊 Mainnet yield vault (skipped — MAINNET_RPC_URL / MAINNET_VAULT_ADDRESS not set)\n");
      return;
    }
    const s = await this.getSnapshot();
    console.log("\n📊 Mainnet YieldVault (Ethereum)");
    console.log("─".repeat(40));
    console.log(`  availableYieldWstETH(): ${formatEther(s.availableYieldWstETH)} wstETH`);
    console.log(`  maxDrawPerTx:         ${formatEther(s.maxDrawPerTx)} wstETH`);
    console.log(`  yield (stETH terms):  ${formatEther(s.yieldStETH)} stETH`);
    console.log(`  drawableWstETH (status): ${formatEther(s.drawableWstETH)} wstETH`);
    console.log("─".repeat(40));
  }
}
