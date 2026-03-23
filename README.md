# Yield Maximizing Degeneracy Agent

AI agent that spends **only yield** from staked wstETH while **principal stays** in the vault.

## What it does

On the default path (TypeScript agent, no Base spending vault required):

1. Yield accrues on mainnet wstETH in `MainnetYieldVault`.
2. The agent draws **yield only** to its Ethereum EOA (whitelisted).
3. Funds move to Base as USDC via **Across** (preferred: one bundle — wstETH → Base USDC with `anyToBridgeable`) **or** Uniswap wstETH→USDC on Ethereum then Across USDC→Base.
4. The agent pays the x402 game with **USDC on Base**.

Optional: deploy `BaseSpendingVault` for owner-funded caps on Base instead of holding USDC in the agent EOA.

## The Synthesis (hackathon)

Integration with [The Synthesis](https://synthesis.md/skill.md) uses Mastra memory under `data/` (no API keys in memory).

| Step | What |
|------|------|
| Register | Fill `SYNTHESIS_*` in `.env` (see `.env.example`). Tools: `synthesis-registration-advance` → email OTP or social → `POST /register/complete`. Credentials: `.synthesis-credentials`; metadata: `.synthesis-registration.json`. |
| API | `synthesis-auth-status`, `synthesis-api-request` → `https://synthesis.devfolio.co` |
| Submit / publish | [Submission skill](https://synthesis.devfolio.co/submission/skill.md): public GitHub repo, set `SYNTHESIS_PROJECT_REPO_URL`, then `npm run synthesis:submit` or tool `synthesis-submission-advance` (draft → self-custody → publish; admin + all members self-custody). |

`npm run dev` prints a short Synthesis block, runs registration advance once (again if `SYNTHESIS_EMAIL_OTP` is set), then the LLM pipeline. Game HTTP: **undici** by default; set `GAME_USE_NODE_FETCH=1` for Node fetch. `DRIPAGENT_SKIP_PLAY=1` skips `play-game`.

## End-to-end flow (agent default)

1. Owner deposits mainnet wstETH into `MainnetYieldVault`.
2. Agent calls `drawYield` so yield wstETH lands in the **agent EOA** on Ethereum (must be whitelisted).
3. **Either** Across **wstETH → Base USDC** on Ethereum (`GET /swap/approval` → `approvalTxns` + `swapTx`; `crossSwapType` often `anyToBridgeable`) **or** Uniswap wstETH→USDC on Ethereum (`mainnetSwapClient.ts`) then bridge.
4. If you used Uniswap in step 3, bridge **USDC (Ethereum) → USDC (Base)** (`acrossBridgeClient.ts`). If you used Across wstETH→Base USDC in step 3, skip this.
5. Agent pays the game via x402 with USDC on Base.

## Optional: Base spending vault

1. After bridging, owner funds `BaseSpendingVault` instead of keeping USDC in the agent EOA.
2. Agent `draw`s from the vault to game recipients. Tighter spend controls than a bare EOA.

## Contracts

### `MainnetYieldVault.sol` (Ethereum mainnet)

- Principal: canonical mainnet wstETH; yield via `stEthPerToken()`
- Agent: `drawYield(amount, recipient)` only
- Enforces `recipientWhitelist`, `maxDrawPerTx`, yield-only limits
- Owner: config + `withdrawAll()`

### `BaseSpendingVault.sol` (Base)

- Spending token (recommended: USDC)
- Agent: `draw(amount, recipient)` only
- Enforces whitelist, `maxDrawPerTx`, balance
- Owner: `ownerWithdraw(amount)`

## Prerequisites

- Foundry (`forge`, `cast`), Node.js + npm
- Mainnet + Base RPC URLs; owner key (deploy/config); agent key; game payee from x402 `PAYMENT-REQUIRED`

## Setup

### 1) Install

```bash
cd <repo>
forge install OpenZeppelin/openzeppelin-contracts
npm install
```

### 2) Configure `.env`

Example for two-contract deploy:

```bash
# Mainnet vault
MAINNET_WSTETH_ADDRESS=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0
MAINNET_AGENT_ADDRESS=0xYourAgentAddress
MAINNET_MAX_DRAW_PER_TX=10000000000000000

# Base spending vault
BASE_SPEND_TOKEN_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
BASE_AGENT_ADDRESS=0xYourAgentAddress
BASE_MAX_DRAW_PER_TX=100000
BASE_GAME_PAYMENT_ADDRESS=0xGamePaymentRecipient
```

- `MAINNET_MAX_DRAW_PER_TX`: wstETH wei (18 decimals).
- `BASE_MAX_DRAW_PER_TX`: token units (USDC: 6 decimals).

### 3) Deploy `MainnetYieldVault`

```bash
forge script script/DeployMainnetYieldVault.s.sol \
  --rpc-url $MAINNET_RPC_URL \
  --private-key $OWNER_PRIVATE_KEY \
  --broadcast
```

Set `MAINNET_VAULT_ADDRESS` from the output.

### 4) Deploy `BaseSpendingVault` (Base)

```bash
forge script script/DeployBaseSpendingVault.s.sol \
  --rpc-url $BASE_RPC_URL \
  --private-key $OWNER_PRIVATE_KEY \
  --broadcast
```

Set `BASE_SPENDING_VAULT_ADDRESS`.

### 5) Whitelists and caps

Mainnet:

```bash
cast send $MAINNET_VAULT_ADDRESS \
  "setRecipientWhitelist(address,bool)" $MAINNET_BRIDGE_RECIPIENT true \
  --rpc-url $MAINNET_RPC_URL --private-key $OWNER_PRIVATE_KEY
```

Base:

```bash
cast send $BASE_SPENDING_VAULT_ADDRESS \
  "setRecipientWhitelist(address,bool)" $GAME_PAYMENT_ADDRESS true \
  --rpc-url $BASE_RPC_URL --private-key $OWNER_PRIVATE_KEY
```

### 6) Deposit principal (mainnet)

```bash
cast send $MAINNET_WSTETH_ADDRESS \
  "approve(address,uint256)" $MAINNET_VAULT_ADDRESS $DEPOSIT_AMOUNT \
  --rpc-url $MAINNET_RPC_URL --private-key $OWNER_PRIVATE_KEY

cast send $MAINNET_VAULT_ADDRESS \
  "deposit(uint256)" $DEPOSIT_AMOUNT \
  --rpc-url $MAINNET_RPC_URL --private-key $OWNER_PRIVATE_KEY
```

### 7) Bridge yield and fund Base vault (if using spending vault)

1. Draw yield from mainnet vault to bridge recipient.
2. Bridge to Base (USDC).
3. Fund vault:

```bash
cast send $BASE_SPEND_TOKEN_ADDRESS \
  "approve(address,uint256)" $BASE_SPENDING_VAULT_ADDRESS $AMOUNT \
  --rpc-url $BASE_RPC_URL --private-key $OWNER_PRIVATE_KEY

cast send $BASE_SPENDING_VAULT_ADDRESS \
  "fund(uint256)" $AMOUNT \
  --rpc-url $BASE_RPC_URL --private-key $OWNER_PRIVATE_KEY
```

### 8) Run the agent

```bash
npm run dev
```

Whitelist the **agent’s Ethereum address** on `MainnetYieldVault` for `drawYield`. Env: `MAINNET_RPC_URL`, `MAINNET_VAULT_ADDRESS`, `AGENT_PRIVATE_KEY`, `AGENT_WALLET_ADDRESS`, `BASE_RPC_URL`, `GAME_TLS_INSECURE` (dev only if the game host has TLS issues). Optional: `MAINNET_DRAW_RECIPIENT` (defaults to `AGENT_WALLET_ADDRESS`). Optional Uniswap fees: `MAINNET_UNISWAP_FEE_WSTETH_WETH`, `MAINNET_UNISWAP_FEE_WETH_USDC` (default `500` = 0.05%).

## x402 payment recipient

```bash
curl -X POST https://play.0000402.xyz/play \
  -H "Content-Type: application/json" \
  -d '{}'
```

Use the `PAYMENT-REQUIRED` response to set recipient/token details before whitelisting.

## Security

- Never commit keys or paste them into untrusted logs.
- Keep `maxDrawPerTx` conservative; tighten recipient whitelists.
- Treat the agent key as hot; keep balances minimal.
- Verify chain and contract addresses before approvals or transfers.
