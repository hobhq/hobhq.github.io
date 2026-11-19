// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IReactive} from "reactive-lib/interfaces/IReactive.sol";
import {ISystemContract} from "reactive-lib/interfaces/ISystemContract.sol";

/// @notice Stand-in for Reactive Network's system contract (0x8888…8888).
///         Records subscriptions and callback requests so the test can replay
///         exactly what the network does: deliver matching logs to `react()` and
///         post requested callbacks through each chain's callback proxy.
contract MockSystem {
    struct Sub {
        address subscriber;
        uint256 chainId;
        address emitter;
        uint256 topic0;
    }

    struct Req {
        address requester;
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    Sub[] internal _subs;
    Req[] internal _reqs;

    event CallbackRequest(uint256 indexed chainId, address indexed requester, address indexed recipient, uint64 gasLimit, bytes payload);

    function subscribe(uint256 chainId, address emitter, uint256 topic0, uint256, uint256, uint256) external {
        _subs.push(Sub(msg.sender, chainId, emitter, topic0));
    }

    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external {}

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory c) external {
        _reqs.push(Req(msg.sender, c.chainId, c.recipient, c.gasLimit, c.payload));
        emit CallbackRequest(c.chainId, msg.sender, c.recipient, c.gasLimit, c.payload);
    }

    function requestCallback(ISystemContract.CallbackVersion, bytes memory) external pure {
        revert("not used");
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    receive() external payable {}

    function subs() external view returns (Sub[] memory) {
        return _subs;
    }

    function drain() external returns (Req[] memory out) {
        out = _reqs;
        delete _reqs;
    }
}

/// @notice Test base that simulates the full loop: origin event -> react() -> callback.
abstract contract ReactiveSim is Test {
    address internal constant SYSTEM_ADDR = 0x8888888888888888888888888888888888888888;

    struct ChainCtx {
        uint256 chainId;
        address proxy;
    }

    // emitter address => chain context (each vault lives on a "chain")
    mapping(address => ChainCtx) internal chainOf;
    mapping(uint256 => address) internal proxyOfChain;

    uint256 internal txCounter = 1;
    uint256 public callbacksDelivered;
    uint256 public reactionsDelivered;
    uint256 public callbacksFailed;

    function _installSystem() internal {
        MockSystem impl = new MockSystem();
        vm.etch(SYSTEM_ADDR, address(impl).code);
        vm.recordLogs();
    }

    function _system() internal pure returns (MockSystem) {
        return MockSystem(payable(SYSTEM_ADDR));
    }

    function _bindChain(address emitter, uint256 chainId, address proxy) internal {
        chainOf[emitter] = ChainCtx(chainId, proxy);
        proxyOfChain[chainId] = proxy;
    }

    /// @notice Deliver every recorded log to subscribed reactive contracts, then post the
    ///         resulting callbacks. Repeats until the system is quiet (callbacks can emit logs).
    function _relay() internal {
        for (uint256 round; round < 6; ++round) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            bool any = _deliverLogs(logs);
            bool cbs = _deliverCallbacks();
            if (!any && !cbs) return;
        }
        revert("relay did not settle");
    }

    function _deliverLogs(Vm.Log[] memory logs) internal returns (bool any) {
        MockSystem.Sub[] memory s = _system().subs();
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory lg = logs[i];
            ChainCtx memory ctx = chainOf[lg.emitter];
            if (ctx.chainId == 0 || lg.topics.length == 0) continue;
            uint256 t0 = uint256(lg.topics[0]);

            for (uint256 j; j < s.length; ++j) {
                if (s[j].chainId != ctx.chainId || s[j].emitter != lg.emitter || s[j].topic0 != t0) continue;
                IReactive.LogRecord memory rec = IReactive.LogRecord({
                    chainId: ctx.chainId,
                    contractAddress: lg.emitter,
                    topic0: t0,
                    topic1: lg.topics.length > 1 ? uint256(lg.topics[1]) : 0,
                    topic2: lg.topics.length > 2 ? uint256(lg.topics[2]) : 0,
                    topic3: lg.topics.length > 3 ? uint256(lg.topics[3]) : 0,
                    data: lg.data,
                    blockNumber: block.number,
                    opCode: lg.topics.length,
                    blockHash: uint256(blockhash(block.number - 1)),
                    txHash: txCounter++,
                    logIndex: i
                });
                vm.prank(SYSTEM_ADDR);
                IReactive(payable(s[j].subscriber)).react(rec);
                reactionsDelivered++;
                any = true;
            }
        }
    }

    function _deliverCallbacks() internal returns (bool any) {
        MockSystem.Req[] memory reqs = _system().drain();
        for (uint256 i; i < reqs.length; ++i) {
            MockSystem.Req memory r = reqs[i];
            require(r.gasLimit >= 100_000, "callback gas below network minimum");
            bytes memory p = r.payload;
            address requester = r.requester;
            // Reactive Network overwrites the first argument with the requesting contract.
            assembly {
                mstore(add(p, 36), requester)
            }
            address proxy = proxyOfChain[r.chainId];
            require(proxy != address(0), "unknown destination chain");
            vm.prank(proxy);
            (bool ok,) = r.recipient.call{gas: r.gasLimit}(p);
            if (ok) callbacksDelivered++;
            else callbacksFailed++;
            any = true;
        }
    }

    /// @notice Simulate network latency: drop the recorded logs into a buffer you deliver later.
    function _holdLogs() internal returns (Vm.Log[] memory) {
        return vm.getRecordedLogs();
    }

    function _deliverHeld(Vm.Log[] memory held) internal {
        _deliverLogs(held);
        _deliverCallbacks();
        _relay();
    }
}
