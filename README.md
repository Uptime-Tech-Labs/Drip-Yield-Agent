# Yield Maximizing Degeneracy Agent

AI agent that spends **only yield** from staked wstETH while **principal stays** in the vault.

## What it does

1. Yield accrues on mainnet wstETH in `MainnetYieldVault`.
2. The agent draws **yield only** to its Ethereum EOA (whitelisted).
3. Funds move to Base as USDC via **Across** (preferred: one bundle — wstETH → Base USDC with `anyToBridgeable`) **or** Uniswap wstETH→USDC on Ethereum then Across USDC→Base.
4. The agent pays the x402 game with **USDC on Base** (held in the agent EOA after bridging).

## The Synthesis (hackathon)

Integration with [The Synthesis](https://synthesis.md/skill.md) uses Mastra memory under `data/` (no API keys in memory).

| Step | What |
|------|------|
| Register | Fill `SYNTHESIS_*` in `.env` (see `.env.example`). Tools: `synthesis-registration-advance` → email OTP or social → `POST /register/complete`. Credentials: `.synthesis-credentials`; metadata: `.synthesis-registration.json`. |
| API | `synthesis-auth-status`, `synthesis-api-request` → `https://synthesis.devfolio.co` |
| Submit / publish | [Submission skill](https://synthesis.devfolio.co/submission/skill.md): public GitHub repo, set `SYNTHESIS_PROJECT_REPO_URL`, then `npm run synthesis:submit` or tool `synthesis-submission-advance` (draft → self-custody → publish; admin + all members self-custody). If transfer fails with *owner address in use*, set `SYNTHESIS_SELF_CUSTODY_ADDRESS` to a **new** EOA that no other Synthesis participant uses. |

`npm run dev` prints a short Synthesis block, runs registration advance once (again if `SYNTHESIS_EMAIL_OTP` is set), then the LLM pipeline. Game HTTP: **undici** by default; set `GAME_USE_NODE_FETCH=1` for Node fetch. `DRIPAGENT_SKIP_PLAY=1` skips `play-game`.

## End-to-end flow (agent default)

1. Owner deposits mainnet wstETH into `MainnetYieldVault`.
2. Agent calls `drawYield` so yield wstETH lands in the **agent EOA** on Ethereum (must be whitelisted).
3. **Either** Across **wstETH → Base USDC** on Ethereum (`GET /swap/approval` → `approvalTxns` + `swapTx`; `crossSwapType` often `anyToBridgeable`) **or** Uniswap wstETH→USDC on Ethereum (`mainnetSwapClient.ts`) then bridge.
4. If you used Uniswap in step 3, bridge **USDC (Ethereum) → USDC (Base)** (`acrossBridgeClient.ts`). If you used Across wstETH→Base USDC in step 3, skip this.
5. Agent pays the game via x402 with USDC on Base.

## Contracts

### `MainnetYieldVault.sol` (Ethereum mainnet)

- Principal: canonical mainnet wstETH; yield via `stEthPerToken()`
- Agent: `drawYield(amount, recipient)` only
- Enforces `recipientWhitelist`, `maxDrawPerTx`, yield-only limits
- Owner: config + `withdrawAll()`

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

Mainnet vault deploy (example):

```bash
MAINNET_WSTETH_ADDRESS=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0
MAINNET_AGENT_ADDRESS=0xYourAgentAddress
MAINNET_MAX_DRAW_PER_TX=10000000000000000
```

`MAINNET_MAX_DRAW_PER_TX` is in wstETH wei (18 decimals). Add `BASE_RPC_URL`, `AGENT_PRIVATE_KEY`, `AGENT_WALLET_ADDRESS`, and game settings per `.env.example`.

### 3) Deploy `MainnetYieldVault`

```bash
forge script script/DeployMainnetYieldVault.s.sol \
  --rpc-url $MAINNET_RPC_URL \
  --private-key $OWNER_PRIVATE_KEY \
  --broadcast
```

Set `MAINNET_VAULT_ADDRESS` from the output.

### 4) Whitelist and caps (mainnet)

```bash
cast send $MAINNET_VAULT_ADDRESS \
  "setRecipientWhitelist(address,bool)" $MAINNET_BRIDGE_RECIPIENT true \
  --rpc-url $MAINNET_RPC_URL --private-key $OWNER_PRIVATE_KEY
```

Use the address that should receive yield draws (often the agent EOA or a bridge-facing recipient).

### 5) Deposit principal (mainnet)

```bash
cast send $MAINNET_WSTETH_ADDRESS \
  "approve(address,uint256)" $MAINNET_VAULT_ADDRESS $DEPOSIT_AMOUNT \
  --rpc-url $MAINNET_RPC_URL --private-key $OWNER_PRIVATE_KEY

cast send $MAINNET_VAULT_ADDRESS \
  "deposit(uint256)" $DEPOSIT_AMOUNT \
  --rpc-url $MAINNET_RPC_URL --private-key $OWNER_PRIVATE_KEY
```

### 6) Run the agent

Bridge USDC to the agent’s Base address as needed, then:

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

Use the `PAYMENT-REQUIRED` response to configure the x402 payee and token for the agent.

## Security

- Never commit keys or paste them into untrusted logs.
- Keep `maxDrawPerTx` conservative; tighten recipient whitelists.
- Treat the agent key as hot; keep balances minimal.
- Verify chain and contract addresses before approvals or transfers.
