// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {IPayable} from "reactive-lib/interfaces/IPayable.sol";
import {HobVault} from "../src/HobVault.sol";
import {HobReactive} from "../src/HobReactive.sol";
import {HobTypes} from "../src/HobTypes.sol";
import {IERC20Min} from "../src/interfaces/IERC20Min.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Step 1 — on Reactive (Lasna):
///   forge script script/Deploy.s.sol:DeployReactive --rpc-url lasna --broadcast
contract DeployReactive is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint256 fund = vm.envOr("REACTIVE_FUND", uint256(2 ether)); // lREACT kept for reactions
        vm.startBroadcast(pk);
        HobReactive rsc = new HobReactive{value: fund}(
            8000,
            HobReactive.VelocityConfig({maxAmount: 2000e6, maxTx: 30, window: 1 hours, freezeFor: 1 hours}),
            HobReactive.VelocityConfig({maxAmount: 300e6, maxTx: 6, window: 1 hours, freezeFor: 1 days})
        );
        vm.stopBroadcast();
        console2.log("HobReactive:", address(rsc));
    }
}

/// Step 2 — on each EVM chain (home first):
///   IS_HOME=true  forge script script/Deploy.s.sol:DeployVault --rpc-url base_sepolia --broadcast
///   IS_HOME=false forge script script/Deploy.s.sol:DeployVault --rpc-url unichain_sepolia --broadcast
contract DeployVault is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address rsc = vm.envAddress("REACTIVE_CONTRACT");
        address proxy = vm.envAddress("CALLBACK_PROXY");
        bool isHome = vm.envBool("IS_HOME");
        uint64 epoch = uint64(vm.envUint("EPOCH_START")); // SAME value on every chain
        uint64 period = uint64(vm.envOr("PERIOD_SECONDS", uint256(30 days)));
        uint256 fund = vm.envOr("CALLBACK_FUND", uint256(0.01 ether)); // native gas for callbacks
        address tokenAddr = vm.envOr("TOKEN", address(0));

        address[] memory adults = isHome ? vm.envAddress("ADULTS", ",") : new address[](0);

        vm.startBroadcast(pk);
        if (tokenAddr == address(0)) {
            MockUSDC m = new MockUSDC();
            m.mint(vm.addr(pk), 100_000e6);
            tokenAddr = address(m);
            console2.log("MockUSDC:", tokenAddr);
        }
        HobVault vault = new HobVault{value: fund}(
            IPayable(payable(proxy)), rsc, IERC20Min(tokenAddr), isHome, epoch, period, adults
        );
        vm.stopBroadcast();
        console2.log("HobVault:", address(vault), isHome ? "(home)" : "(mirror)");
    }
}

/// Step 3 — on Reactive (Lasna), once per vault:
///   CHAIN_ID=84532 VAULT=0x.. HOME=true forge script script/Deploy.s.sol:RegisterVault --rpc-url lasna --broadcast
contract RegisterVault is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        HobReactive rsc = HobReactive(payable(vm.envAddress("REACTIVE_CONTRACT")));
        vm.startBroadcast(pk);
        rsc.registerVault(vm.envUint("CHAIN_ID"), vm.envAddress("VAULT"), vm.envBool("HOME"));
        vm.stopBroadcast();
    }
}

/// Step 3b — on Reactive (Lasna), after every vault is registered: lock the setup for good.
///   forge script script/Deploy.s.sol:Seal --rpc-url lasna --broadcast
contract Seal is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        HobReactive(payable(vm.envAddress("REACTIVE_CONTRACT"))).seal();
        vm.stopBroadcast();
    }
}

/// Step 4 — on the home chain: announce founding adults so mirrors learn them.
///   forge script script/Deploy.s.sol:Resync --rpc-url base_sepolia --broadcast
contract Resync is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        HobVault home = HobVault(payable(vm.envAddress("HOME_VAULT")));
        address[] memory adults = vm.envAddress("ADULTS", ",");
        vm.startBroadcast(pk);
        home.resync(adults, new uint8[](0));
        vm.stopBroadcast();
    }
}
