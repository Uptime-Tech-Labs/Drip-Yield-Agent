// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/BaseSpendingVault.sol";

/**
 * @notice Deploy BaseSpendingVault to Base.
 *
 * Required env:
 * - BASE_SPEND_TOKEN_ADDRESS  (typically USDC on Base)
 * - BASE_AGENT_ADDRESS
 * - BASE_MAX_DRAW_PER_TX      (uint256 token units, USDC uses 6 decimals)
 * - BASE_GAME_PAYMENT_ADDRESS (optional; set to zero to skip whitelist bootstrap)
 */
contract DeployBaseSpendingVault is Script {
    function run() external {
        address token = vm.envAddress("BASE_SPEND_TOKEN_ADDRESS");
        address agentAddress = vm.envAddress("BASE_AGENT_ADDRESS");
        uint256 maxDrawPerTx = vm.envUint("BASE_MAX_DRAW_PER_TX");
        address gamePaymentAddress = vm.envAddress("BASE_GAME_PAYMENT_ADDRESS");

        vm.startBroadcast();

        BaseSpendingVault vault = new BaseSpendingVault(token, agentAddress, maxDrawPerTx);

        if (gamePaymentAddress != address(0)) {
            vault.setRecipientWhitelist(gamePaymentAddress, true);
        }

        console.log("BaseSpendingVault deployed at:", address(vault));
        console.log("Token:", token);
        console.log("Agent:", agentAddress);
        console.log("Max draw per tx:", maxDrawPerTx);
        console.log("Game payment recipient whitelisted:", gamePaymentAddress);

        vm.stopBroadcast();
    }
}

