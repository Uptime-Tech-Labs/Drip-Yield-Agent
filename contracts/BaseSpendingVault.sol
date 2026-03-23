// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BaseSpendingVault
 * @notice Base-side vault for bridged funds. Agent can only draw to whitelisted recipients.
 *         Intended target token is USDC on Base for x402/game spending.
 *
 *         Owner (human) funds this vault, typically from bridged yield.
 *         Agent can spend within strict recipient + per-tx caps.
 */
contract BaseSpendingVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public agent;
    uint256 public maxDrawPerTx;

    mapping(address => bool) public recipientWhitelist;

    event Funded(address indexed from, uint256 amount);
    event Drawn(address indexed agent, address indexed recipient, uint256 amount);
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event MaxDrawPerTxUpdated(uint256 oldMax, uint256 newMax);
    event RecipientWhitelisted(address indexed recipient, bool allowed);
    event OwnerWithdrawn(address indexed owner, uint256 amount);

    error NotAgent();
    error RecipientNotWhitelisted(address recipient);
    error ExceedsMaxDrawPerTx(uint256 requested, uint256 max);
    error InsufficientBalance(uint256 requested, uint256 available);
    error ZeroAmount();
    error ZeroAddress();

    constructor(address _token, address _agent, uint256 _maxDrawPerTx) Ownable(msg.sender) {
        if (_token == address(0) || _agent == address(0)) revert ZeroAddress();
        token = IERC20(_token);
        agent = _agent;
        maxDrawPerTx = _maxDrawPerTx;
    }

    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function draw(uint256 amount, address recipient) external nonReentrant {
        if (msg.sender != agent) revert NotAgent();
        if (!recipientWhitelist[recipient]) revert RecipientNotWhitelisted(recipient);
        if (amount == 0) revert ZeroAmount();
        if (amount > maxDrawPerTx) revert ExceedsMaxDrawPerTx(amount, maxDrawPerTx);

        uint256 bal = token.balanceOf(address(this));
        if (amount > bal) revert InsufficientBalance(amount, bal);

        token.safeTransfer(recipient, amount);
        emit Drawn(msg.sender, recipient, amount);
    }

    function ownerWithdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = token.balanceOf(address(this));
        if (amount > bal) revert InsufficientBalance(amount, bal);

        token.safeTransfer(owner(), amount);
        emit OwnerWithdrawn(owner(), amount);
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

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}

