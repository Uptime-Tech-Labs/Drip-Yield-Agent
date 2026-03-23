// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/MainnetYieldVault.sol";

/**
 * @notice Deploy MainnetYieldVault to Ethereum mainnet.
 *
 * Required env:
 * - MAINNET_WSTETH_ADDRESS   (canonical mainnet wstETH, typically 0x7f39...)
 * - MAINNET_AGENT_ADDRESS
 * - MAINNET_MAX_DRAW_PER_TX  (uint256, e.g. 10000000000000000 for 0.01 wstETH)
 */
contract DeployMainnetYieldVault is Script {
    function run() external {
        address wstETH = vm.envAddress("MAINNET_WSTETH_ADDRESS");
        address agentAddress = vm.envAddress("MAINNET_AGENT_ADDRESS");
        uint256 maxDrawPerTx = vm.envUint("MAINNET_MAX_DRAW_PER_TX");

        vm.startBroadcast();

        MainnetYieldVault vault = new MainnetYieldVault(wstETH, agentAddress, maxDrawPerTx);

        console.log("MainnetYieldVault deployed at:", address(vault));
        console.log("wstETH:", wstETH);
        console.log("Agent:", agentAddress);
        console.log("Max draw per tx:", maxDrawPerTx);

        vm.stopBroadcast();
    }
}

