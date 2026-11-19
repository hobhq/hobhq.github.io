// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {IPayable} from "reactive-lib/interfaces/IPayable.sol";
import {ReactiveSim} from "./utils/ReactiveSim.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {HobVault} from "../src/HobVault.sol";
import {HobReactive} from "../src/HobReactive.sol";
import {HobTypes} from "../src/HobTypes.sol";
import {IERC20Min} from "../src/interfaces/IERC20Min.sol";

/// @notice Drives random household activity across two chains and the reactive layer.
contract HobHandler is ReactiveSim {
    uint256 constant BASE = 84532;
    uint256 constant UNI = 1301;
    uint64 constant PERIOD = 30 days;

    HobVault public home;
    HobVault public mirror;
    HobReactive public rsc;
    MockUSDC public usdcBase;
    MockUSDC public usdcUni;

    bool public immutable syncMode; // true: Reactive answers after every action
    address[3] public actors;
    uint8[2] public categories = [0, 1];

    // ghosts
    uint256 public inFlight; // amount spent since the last relay
    uint256 public maxInFlight; // largest in-flight batch ever relayed
    uint256 public spendsOk;
    uint256 public spendsRefused;
    uint256 public relays;
    Vm.Log[] internal held;

    constructor(bool sync_) {
        syncMode = sync_;
        vm.warp(1_780_000_000);
        _installSystem();

        actors = [makeAddr("alice"), makeAddr("bob"), makeAddr("agent")];

        rsc = new HobReactive(
            8000,
            HobReactive.VelocityConfig({maxAmount: 2000e6, maxTx: 30, window: 1 hours, freezeFor: 1 hours}),
            HobReactive.VelocityConfig({maxAmount: 300e6, maxTx: 6, window: 1 hours, freezeFor: 1 days})
        );
        usdcBase = new MockUSDC();
        usdcUni = new MockUSDC();

        address[] memory adults = new address[](2);
        adults[0] = actors[0];
        adults[1] = actors[1];
        address proxyBase = makeAddr("proxyBase");
        address proxyUni = makeAddr("proxyUni");
        uint64 epoch = uint64(block.timestamp);
        home = new HobVault(IPayable(payable(proxyBase)), address(rsc), IERC20Min(address(usdcBase)), true, epoch, PERIOD, adults);
        mirror = new HobVault(IPayable(payable(proxyUni)), address(rsc), IERC20Min(address(usdcUni)), false, epoch, PERIOD, new address[](0));
        _bindChain(address(home), BASE, proxyBase);
        _bindChain(address(mirror), UNI, proxyUni);
        rsc.registerVault(BASE, address(home), true);
        rsc.registerVault(UNI, address(mirror), false);
        usdcBase.mint(address(home), 1e15);
        usdcUni.mint(address(mirror), 1e15);
        vm.getRecordedLogs();

        address[] memory list = new address[](2);
        list[0] = actors[0];
        list[1] = actors[1];
        vm.prank(actors[0]);
        home.resync(list, new uint8[](0));
        _relay();

        // Groceries: many small buys. Rent-like: one payment can be the whole cap.
        _ratify(0, 1000e6, 200e6, 150e6);
        _ratify(1, 2000e6, 2000e6, 2000e6);

        vm.prank(actors[0]);
        uint256 id = home.proposeMember(actors[2], HobTypes.Role.AGENT);
        vm.prank(actors[1]);
        home.approveProposal(id);
        _relay();
    }

    function _ratify(uint8 cat, uint128 cap, uint128 perTx, uint128 coSign) internal {
        vm.prank(actors[0]);
        uint256 id = home.proposeRule(cat, HobTypes.Rule(cap, perTx, coSign, true));
        vm.prank(actors[1]);
        home.approveProposal(id);
        _relay();
    }

    // ------------------------------------------------------------------ actions

    function spend(uint256 actorSeed, uint256 chainSeed, uint256 catSeed, uint256 amount) external {
        address who = actors[actorSeed % 3];
        HobVault v = chainSeed % 2 == 0 ? home : mirror;
        uint8 cat = categories[catSeed % 2];
        (uint128 cap, uint128 perTx,,) = v.rules(cat);
        if (cap == 0) return;
        amount = bound(amount, 1e6, perTx);

        vm.prank(who);
        try v.spend(cat, address(0xCAFE), uint128(amount)) returns (uint256 id) {
            if (id == type(uint256).max) {
                spendsOk++;
                inFlight += amount;
            }
        } catch {
            spendsRefused++;
        }
        _after();
    }

    function coSign(uint256 chainSeed, uint256 idSeed, uint256 adultSeed) external {
        HobVault v = chainSeed % 2 == 0 ? home : mirror;
        uint256 n = v.pendingCount();
        if (n == 0) return;
        uint256 id = idSeed % n;
        (,, uint128 amount,,,) = v.pending(id);
        vm.prank(actors[adultSeed % 2]);
        try v.approveSpend(id) {
            spendsOk++;
            inFlight += amount;
        } catch {
            spendsRefused++;
        }
        _after();
    }

    function passTime(uint256 secs) external {
        // stay inside the period so the cap invariant is meaningful; rollovers are covered by unit tests
        secs = bound(secs, 1, 3 hours);
        if ((block.timestamp + secs - home.epochStart()) / PERIOD != home.currentPeriod()) return;
        vm.warp(block.timestamp + secs);
        _after();
    }

    function relayNow() external {
        _flushHeld();
    }

    // ------------------------------------------------------------------ plumbing

    function _after() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) held.push(logs[i]);
        if (syncMode) _flushHeld();
    }

    function _flushHeld() internal {
        Vm.Log[] memory logs = held;
        delete held;
        _deliverHeld(logs);
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        inFlight = 0;
        relays++;
    }

    // ------------------------------------------------------------------ views for invariants

    function household(uint8 cat) public view returns (uint256) {
        uint64 p = home.currentPeriod();
        return uint256(home.localSpent(p, cat)) + mirror.localSpent(p, cat);
    }

    function ledger(uint8 cat) public view returns (uint256 spent) {
        (spent,) = rsc.ledger(home.currentPeriod(), cat);
    }

    function cap(uint8 cat) public view returns (uint256 c) {
        (c,,,) = home.rules(cat);
    }

    function pendingRelay() external view returns (uint256) {
        return held.length;
    }
}

abstract contract HobInvariantBase is ReactiveSim {
    HobHandler internal h;

    function _handler(bool sync_) internal {
        h = new HobHandler(sync_);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](sync_ ? 3 : 4);
        sel[0] = HobHandler.spend.selector;
        sel[1] = HobHandler.coSign.selector;
        sel[2] = HobHandler.passTime.selector;
        if (!sync_) sel[3] = HobHandler.relayNow.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }
}

/// Reactive answers after every action: the household never exceeds any cap.
contract HobInvariantSync is HobInvariantBase {
    function setUp() public {
        _handler(true);
    }

    function invariant_household_never_exceeds_cap() public view {
        for (uint8 c; c < 2; ++c) {
            assertLe(h.household(c), h.cap(c), "household spent > cap");
        }
    }

    function invariant_ledger_matches_chains() public view {
        for (uint8 c; c < 2; ++c) {
            assertEq(h.ledger(c), h.household(c), "reactive ledger != sum of chains");
        }
    }

    function invariant_cap_reached_means_frozen_everywhere() public view {
        for (uint8 c; c < 2; ++c) {
            if (h.household(c) >= h.cap(c)) {
                (HobTypes.Mode a,,) = h.home().categoryStatus(c);
                (HobTypes.Mode b,,) = h.mirror().categoryStatus(c);
                assertEq(uint8(a), uint8(HobTypes.Mode.FROZEN));
                assertEq(uint8(b), uint8(HobTypes.Mode.FROZEN));
            }
        }
    }

    function invariant_no_failed_callbacks() public view {
        assertEq(h.callbacksFailed(), 0);
    }
}

/// Reactive answers late (random batches): overshoot is bounded by what was in flight,
/// and once delivered, the ledger agrees with the chains.
contract HobInvariantLatency is HobInvariantBase {
    function setUp() public {
        _handler(false);
    }

    function invariant_overshoot_bounded_by_in_flight() public view {
        uint256 bound_ = h.maxInFlight() > h.inFlight() ? h.maxInFlight() : h.inFlight();
        for (uint8 c; c < 2; ++c) {
            assertLe(h.household(c), h.cap(c) + bound_, "overshoot larger than in-flight spend");
        }
    }

    function invariant_settled_state_consistent() public view {
        if (h.pendingRelay() != 0) return; // only judge a settled system
        for (uint8 c; c < 2; ++c) {
            assertEq(h.ledger(c), h.household(c), "ledger != chains after settle");
            if (h.household(c) >= h.cap(c)) {
                (HobTypes.Mode a,,) = h.home().categoryStatus(c);
                (HobTypes.Mode b,,) = h.mirror().categoryStatus(c);
                assertEq(uint8(a), uint8(HobTypes.Mode.FROZEN));
                assertEq(uint8(b), uint8(HobTypes.Mode.FROZEN));
            }
        }
    }

    function invariant_no_failed_callbacks() public view {
        assertEq(h.callbacksFailed(), 0);
    }
}
