// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title IWstETH
 * @notice Minimal interface for wstETH on Base (bridged Lido token).
 *         wstETH is a rebasing token wrapper — its exchange rate vs stETH
 *         increases over time as staking rewards accrue.
 */
interface IWstETH is IERC20 {
    /// @notice Returns how many stETH (in wei) one wstETH is worth right now.
    function stEthPerToken() external view returns (uint256);
    /// @notice Converts a stETH amount to wstETH shares.
    function getWstETHByStETH(uint256 stETHAmount) external view returns (uint256);
}

/**
 * @title YieldVault
 * @notice A contract that lets a human deposit wstETH as principal and grant
 *         an AI agent access to the yield only — never the principal.
 *
 * HOW IT WORKS
 * ─────────────
 * 1. Owner deposits wstETH. The contract records the deposit in wstETH shares
 *    AND the stETH-equivalent value at deposit time (the "principal baseline").
 *
 * 2. Over time, wstETH appreciates vs stETH: stEthPerToken() increases.
 *    The vault's wstETH balance is worth more stETH than at deposit time.
 *    That delta IS the yield.
 *
 * 3. The agent can call `drawYield(amount, recipient)` to pull up to the
 *    current yield out of the vault — but only:
 *      - Up to `maxDrawPerTx` wstETH per transaction (configurable cap)
 *      - Only to addresses on the `recipientWhitelist`
 *      - Only if `msg.sender == agent`
 *
 * 4. Principal is structurally inaccessible to the agent. Only the owner
 *    can call `withdrawPrincipal()`.
 *
 * PERMISSIONS (all configurable by owner)
 * ────────────────────────────────────────
 * - agent address
 * - maxDrawPerTx (wstETH cap per agent withdrawal)
 * - recipientWhitelist (set of allowed destination addresses)
 *
 * YIELD CALCULATION
 * ─────────────────
 * principalBaselineStETH = wstETH deposited × stEthPerToken at deposit time
 * currentValueStETH      = wstETH balance × stEthPerToken now
 * yieldStETH             = currentValueStETH − principalBaselineStETH
 * yieldWstETH            = yieldStETH / stEthPerToken now
 *
 * The agent can draw up to yieldWstETH, leaving at least principalBaselineStETH
 * worth of wstETH in the vault at all times.
 */
contract YieldVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeERC20 for IWstETH;

    // ─── State ────────────────────────────────────────────────────────────────

    IWstETH public immutable wstETH;

    /// @notice The AI agent address — only this address can call drawYield().
    address public agent;

    /// @notice Maximum wstETH the agent may withdraw in a single transaction.
    uint256 public maxDrawPerTx;

    /// @notice Total wstETH deposited as principal (in wstETH shares).
    uint256 public principalWstETH;

    /**
     * @notice The stETH value of the principal at deposit time.
     *         This is the floor — the vault must always retain at least this
     *         much stETH-equivalent value, ensuring principal is never touched.
     */
    uint256 public principalBaselineStETH;

    /// @notice Fallback accounting: principal baseline measured in wstETH units.
    ///         Used when stEthPerToken()/getWstETHByStETH() are not callable on the
    ///         target token deployment (they revert on your Base deployment).
    uint256 public principalBaselineWstETH;

    /// @notice If true, `availableYieldWstETH()` uses token-unit yield accounting.
    bool public useWstETHAccounting;

    /// @notice Whitelist of addresses the agent may send yield to.
    mapping(address => bool) public recipientWhitelist;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed owner, uint256 wstETHAmount, uint256 baselineStETH);
    event YieldDrawn(address indexed agent, address indexed recipient, uint256 wstETHAmount);
    event PrincipalWithdrawn(address indexed owner, uint256 wstETHAmount);
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event MaxDrawPerTxUpdated(uint256 oldMax, uint256 newMax);
    event RecipientWhitelisted(address indexed recipient, bool allowed);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error NotAgent();
    error RecipientNotWhitelisted(address recipient);
    error ExceedsMaxDrawPerTx(uint256 requested, uint256 max);
    error InsufficientYield(uint256 requested, uint256 available);
    error ZeroAmount();
    error ZeroAddress();

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param _wstETH       Address of wstETH on Base
     *                      (0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452 on Base mainnet)
     * @param _agent        Address of the AI agent wallet
     * @param _maxDrawPerTx Max wstETH the agent can draw per tx (e.g. 0.01 ether)
     */
    constructor(
        address _wstETH,
        address _agent,
        uint256 _maxDrawPerTx
    ) Ownable(msg.sender) {
        if (_wstETH == address(0) || _agent == address(0)) revert ZeroAddress();
        wstETH = IWstETH(_wstETH);
        agent = _agent;
        maxDrawPerTx = _maxDrawPerTx;
    }

    // ─── Owner: Deposit ───────────────────────────────────────────────────────

    /**
     * @notice Deposit wstETH as principal. Establishes the baseline stETH value
     *         that the vault will always protect.
     * @dev    Can be called multiple times — additional deposits increase the
     *         protected principal baseline proportionally.
     * @param  amount wstETH amount to deposit (must be approved first).
     */
    function deposit(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();

        // Pull wstETH from owner
        wstETH.safeTransferFrom(msg.sender, address(this), amount);

        principalWstETH += amount;
        principalBaselineWstETH += amount;

        // Record the stETH value of this deposit at current exchange rate (if available).
        // Some bridged wstETH deployments on Base revert on stEthPerToken/getWstETHByStETH.
        uint256 stETHValueNow = 0;
        if (!useWstETHAccounting) {
            try wstETH.stEthPerToken() returns (uint256 rate) {
                if (rate != 0) {
                    stETHValueNow = (amount * rate) / 1e18;
                    principalBaselineStETH += stETHValueNow;
                }
            } catch {
                // Switch to token-unit accounting permanently (safer than reverting).
                useWstETHAccounting = true;
            }
        }

        emit Deposited(msg.sender, amount, stETHValueNow);
    }

    // ─── Agent: Draw Yield ────────────────────────────────────────────────────

    /**
     * @notice Draw yield from the vault. Only callable by the agent.
     *         Enforces:
     *           1. Recipient must be whitelisted
     *           2. Amount must not exceed maxDrawPerTx
     *           3. Amount must not exceed available yield (principal stays intact)
     *
     * @param  amount    wstETH amount to withdraw (from yield only).
     * @param  recipient Whitelisted address to send wstETH to.
     */
    function drawYield(uint256 amount, address recipient) external nonReentrant {
        if (msg.sender != agent) revert NotAgent();
        if (!recipientWhitelist[recipient]) revert RecipientNotWhitelisted(recipient);
        if (amount == 0) revert ZeroAmount();
        if (amount > maxDrawPerTx) revert ExceedsMaxDrawPerTx(amount, maxDrawPerTx);

        uint256 available = availableYieldWstETH();
        if (amount > available) revert InsufficientYield(amount, available);

        wstETH.safeTransfer(recipient, amount);

        emit YieldDrawn(msg.sender, recipient, amount);
    }

    // ─── Owner: Withdraw Principal ────────────────────────────────────────────

    /**
     * @notice Withdraw the full principal. Only the owner can call this.
     *         The agent has no path to this function.
     */
    function withdrawPrincipal() external onlyOwner nonReentrant {
        uint256 balance = wstETH.balanceOf(address(this));
        if (balance == 0) revert ZeroAmount();

        // Reset state
        principalWstETH = 0;
        principalBaselineStETH = 0;
        principalBaselineWstETH = 0;
        useWstETHAccounting = false;

        wstETH.safeTransfer(owner(), balance);
        emit PrincipalWithdrawn(owner(), balance);
    }

    // ─── Owner: Configuration ─────────────────────────────────────────────────

    function setAgent(address _agent) external onlyOwner {
        if (_agent == address(0)) revert ZeroAddress();
        emit AgentUpdated(agent, _agent);
        agent = _agent;
    }

    function setMaxDrawPerTx(uint256 _max) external onlyOwner {
        emit MaxDrawPerTxUpdated(maxDrawPerTx, _max);
        maxDrawPerTx = _max;
    }

    function setRecipientWhitelist(address recipient, bool allowed) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        recipientWhitelist[recipient] = allowed;
        emit RecipientWhitelisted(recipient, allowed);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /**
     * @notice The current stETH value of all wstETH held in this vault.
     */
    function currentValueStETH() public view returns (uint256) {
        uint256 bal = wstETH.balanceOf(address(this));
        if (useWstETHAccounting) return 0;

        // If conversion calls revert, treat as 0 so views don't revert.
        uint256 rate = _tryStEthPerToken();
        if (rate == 0) return 0;
        return (bal * rate) / 1e18;
    }

    /**
     * @notice How much yield has accrued, denominated in stETH.
     *         This is the growth above the principal baseline.
     */
    function accruedYieldStETH() public view returns (uint256) {
        if (useWstETHAccounting) return 0;
        uint256 current = currentValueStETH();
        if (current <= principalBaselineStETH) return 0;
        return current - principalBaselineStETH;
    }

    /**
     * @notice How much yield is available for the agent to draw, in wstETH.
     *         This is the amount the agent can actually transfer out.
     */
    function availableYieldWstETH() public view returns (uint256) {
        uint256 balWstETH = wstETH.balanceOf(address(this));

        // Fallback: yield is any excess wstETH over the principal baseline.
        if (useWstETHAccounting) {
            if (balWstETH <= principalBaselineWstETH) return 0;
            return balWstETH - principalBaselineWstETH;
        }

        // Primary: yield is delta in stETH-equivalent value.
        uint256 rate = _tryStEthPerToken();
        if (rate == 0) {
            // If conversion is unavailable, fall back to token-unit accounting.
            if (balWstETH <= principalBaselineWstETH) return 0;
            return balWstETH - principalBaselineWstETH;
        }

        uint256 currentStETH = (balWstETH * rate) / 1e18;
        if (currentStETH <= principalBaselineStETH) return 0;
        uint256 yieldStETH = currentStETH - principalBaselineStETH;

        // Convert yield (in stETH) back to wstETH shares at current rate
        return (yieldStETH * 1e18) / rate;
    }

    /**
     * @notice Full vault status — useful for the agent to query before acting.
     */
    function vaultStatus() external view returns (
        uint256 totalWstETH,
        uint256 principalStETH,
        uint256 currentStETH,
        uint256 yieldStETH,
        uint256 drawableWstETH,
        uint256 exchangeRate      // stETH per wstETH (18 decimals)
    ) {
        totalWstETH   = wstETH.balanceOf(address(this));
        principalStETH = principalBaselineStETH;
        currentStETH  = currentValueStETH();
        yieldStETH    = accruedYieldStETH();
        drawableWstETH = availableYieldWstETH();
        exchangeRate   = _tryStEthPerToken();
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _tryStEthPerToken() internal view returns (uint256) {
        try wstETH.stEthPerToken() returns (uint256 rate) {
            return rate;
        } catch {
            return 0;
        }
    }

    function _wstETHToStETH(uint256 wstETHAmount) internal view returns (uint256) {
        uint256 rate = _tryStEthPerToken();
        if (rate == 0) return 0;
        return (wstETHAmount * rate) / 1e18;
    }

    function _stETHToWstETH(uint256 stETHAmount) internal view returns (uint256) {
        uint256 rate = _tryStEthPerToken();
        if (rate == 0) return 0;
        return (stETHAmount * 1e18) / rate;
    }
}
