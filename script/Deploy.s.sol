// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/YieldVault.sol";

/**
 * @notice Deploy YieldVault to Base.
 *
 * Usage:
 *   forge script script/Deploy.s.sol \
 *     --rpc-url $BASE_RPC_URL \
 *     --private-key $OWNER_PRIVATE_KEY \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY
 */
contract DeployYieldVault is Script {
    // wstETH on Base mainnet (Lido bridged token)
    address constant WSTETH_BASE = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;

    function run() external {
        address agentAddress = vm.envAddress("AGENT_ADDRESS");

        // Agent can draw at most 0.005 wstETH per transaction (~$15 at current prices)
        uint256 maxDrawPerTx = 0.005 ether;

        vm.startBroadcast();

        YieldVault vault = new YieldVault(
            WSTETH_BASE,
            agentAddress,
            maxDrawPerTx
        );

        console.log("YieldVault deployed at:", address(vault));
        console.log("Agent address:         ", agentAddress);
        console.log("Max draw per tx:       ", maxDrawPerTx);

        // Whitelist the game's x402 payment address as an allowed recipient.
        // The agent will draw yield → send to this address as x402 payment.
        address gamePaymentAddress = vm.envAddress("GAME_PAYMENT_ADDRESS");
        vault.setRecipientWhitelist(gamePaymentAddress, true);
        console.log("Whitelisted game payment address:", gamePaymentAddress);

        vm.stopBroadcast();
    }
}
