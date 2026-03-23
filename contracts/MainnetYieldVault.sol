// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Canonical wstETH interface on Ethereum mainnet.
interface IMainnetWstETH is IERC20 {
    function stEthPerToken() external view returns (uint256);
}

/**
 * @title MainnetYieldVault
 * @notice Holds principal in canonical mainnet wstETH and only lets the agent draw yield.
 *         This vault is intended to live on Ethereum mainnet.
 *
 *         Flow:
 *         - Owner deposits principal wstETH.
 *         - Agent draws only accrued yield to a whitelisted recipient (typically a bridge adapter).
 *         - Owner can withdraw all funds.
 */
contract MainnetYieldVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IMainnetWstETH;

    IMainnetWstETH public immutable wstETH;
    address public agent;
    uint256 public maxDrawPerTx;

    /// @notice Baseline principal value in stETH terms at deposit time.
    uint256 public principalBaselineStETH;

    mapping(address => bool) public recipientWhitelist;

    event Deposited(address indexed owner, uint256 wstETHAmount, uint256 baselineStETH);
    event YieldDrawn(address indexed agent, address indexed recipient, uint256 wstETHAmount);
    event PrincipalWithdrawn(address indexed owner, uint256 wstETHAmount);
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event MaxDrawPerTxUpdated(uint256 oldMax, uint256 newMax);
    event RecipientWhitelisted(address indexed recipient, bool allowed);

    error NotAgent();
    error RecipientNotWhitelisted(address recipient);
    error ExceedsMaxDrawPerTx(uint256 requested, uint256 max);
    error InsufficientYield(uint256 requested, uint256 available);
    error ZeroAmount();
    error ZeroAddress();

    constructor(address _wstETH, address _agent, uint256 _maxDrawPerTx) Ownable(msg.sender) {
        if (_wstETH == address(0) || _agent == address(0)) revert ZeroAddress();
        wstETH = IMainnetWstETH(_wstETH);
        agent = _agent;
        maxDrawPerTx = _maxDrawPerTx;
    }

    function deposit(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        wstETH.safeTransferFrom(msg.sender, address(this), amount);

        uint256 baselineDelta = _wstETHToStETH(amount);
        principalBaselineStETH += baselineDelta;

        emit Deposited(msg.sender, amount, baselineDelta);
    }

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

    function withdrawAll() external onlyOwner nonReentrant {
        uint256 balance = wstETH.balanceOf(address(this));
        if (balance == 0) revert ZeroAmount();

        principalBaselineStETH = 0;
        wstETH.safeTransfer(owner(), balance);

        emit PrincipalWithdrawn(owner(), balance);
    }

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

    function currentValueStETH() public view returns (uint256) {
        return _wstETHToStETH(wstETH.balanceOf(address(this)));
    }

    function accruedYieldStETH() public view returns (uint256) {
        uint256 current = currentValueStETH();
        if (current <= principalBaselineStETH) return 0;
        return current - principalBaselineStETH;
    }

    function availableYieldWstETH() public view returns (uint256) {
        uint256 yieldStETH = accruedYieldStETH();
        if (yieldStETH == 0) return 0;
        return _stETHToWstETH(yieldStETH);
    }

    function vaultStatus()
        external
        view
        returns (
            uint256 totalWstETH,
            uint256 principalStETH,
            uint256 currentStETH,
            uint256 yieldStETH,
            uint256 drawableWstETH,
            uint256 exchangeRate
        )
    {
        totalWstETH = wstETH.balanceOf(address(this));
        principalStETH = principalBaselineStETH;
        currentStETH = currentValueStETH();
        yieldStETH = accruedYieldStETH();
        drawableWstETH = availableYieldWstETH();
        exchangeRate = wstETH.stEthPerToken();
    }

    function _wstETHToStETH(uint256 wstETHAmount) internal view returns (uint256) {
        return (wstETHAmount * wstETH.stEthPerToken()) / 1e18;
    }

    function _stETHToWstETH(uint256 stETHAmount) internal view returns (uint256) {
        return (stETHAmount * 1e18) / wstETH.stEthPerToken();
    }
}

