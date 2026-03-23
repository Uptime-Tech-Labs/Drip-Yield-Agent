import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

/** Matches `BaseSpendingVault.sol` on Base (USDC or other ERC-20). */
const SPENDING_VAULT_ABI = parseAbi([
  "function balance() external view returns (uint256)",
  "function draw(uint256 amount, address recipient) external",
  "function maxDrawPerTx() external view returns (uint256)",
  "function recipientWhitelist(address recipient) external view returns (bool)",
  "function token() external view returns (address)",
]);

const ERC20_META_ABI = parseAbi([
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
]);

export interface SpendingVaultStatus {
  vaultBalance: bigint;
  maxDrawPerTx: bigint;
  tokenAddress: `0x${string}`;
  decimals: number;
  symbol: string;
}

/**
 * Client for BaseSpendingVault: owner-funded spend token (e.g. USDC), agent `draw`s to whitelisted recipients.
 * Not the mainnet wstETH yield vault — that contract lives on Ethereum and uses different methods.
 */
export class SpendingVaultClient {
  private publicClient;
  private walletClient;
  private vaultAddress: `0x${string}`;

  constructor(vaultAddress: string, agentPrivateKey: `0x${string}`) {
    this.vaultAddress = vaultAddress as `0x${string}`;

    const account = privateKeyToAccount(agentPrivateKey);

    this.publicClient = createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL),
    });

    this.walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(process.env.BASE_RPC_URL),
    });
  }

  /** Token metadata (from vault's immutable `token`). */
  async getTokenMeta(): Promise<{ address: `0x${string}`; decimals: number; symbol: string }> {
    const tokenAddress = (await this.publicClient.readContract({
      address: this.vaultAddress,
      abi: SPENDING_VAULT_ABI,
      functionName: "token",
    })) as `0x${string}`;

    const [decimals, symbol] = await Promise.all([
      this.publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_META_ABI,
        functionName: "decimals",
      }) as Promise<number>,
      this.publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_META_ABI,
        functionName: "symbol",
      }) as Promise<string>,
    ]);

    return { address: tokenAddress, decimals: Number(decimals), symbol };
  }

  async getStatus(): Promise<SpendingVaultStatus> {
    const tokenMeta = await this.getTokenMeta();
    const [vaultBalance, maxDrawPerTx] = await Promise.all([
      this.publicClient.readContract({
        address: this.vaultAddress,
        abi: SPENDING_VAULT_ABI,
        functionName: "balance",
      }) as Promise<bigint>,
      this.publicClient.readContract({
        address: this.vaultAddress,
        abi: SPENDING_VAULT_ABI,
        functionName: "maxDrawPerTx",
      }) as Promise<bigint>,
    ]);

    return {
      vaultBalance,
      maxDrawPerTx,
      tokenAddress: tokenMeta.address,
      decimals: tokenMeta.decimals,
      symbol: tokenMeta.symbol,
    };
  }

  async isRecipientWhitelisted(recipient: `0x${string}`): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.vaultAddress,
      abi: SPENDING_VAULT_ABI,
      functionName: "recipientWhitelist",
      args: [recipient],
    }) as Promise<boolean>;
  }

  /**
   * Agent pulls spend token from the vault to `recipient` (must be whitelisted).
   */
  async draw(amount: bigint, recipient: `0x${string}`): Promise<`0x${string}`> {
    const hash = await this.walletClient.writeContract({
      address: this.vaultAddress,
      abi: SPENDING_VAULT_ABI,
      functionName: "draw",
      args: [amount, recipient],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async logStatus(): Promise<void> {
    const s = await this.getStatus();
    console.log("\n📊 Base spending vault");
    console.log("─".repeat(40));
    console.log(`  Token:                 ${s.symbol} (${s.tokenAddress})`);
    console.log(`  Vault balance:         ${formatUnits(s.vaultBalance, s.decimals)} ${s.symbol}`);
    console.log(`  Max draw per tx:       ${formatUnits(s.maxDrawPerTx, s.decimals)} ${s.symbol}`);
    console.log("─".repeat(40));
  }
}
