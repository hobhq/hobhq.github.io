// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPayable} from "reactive-lib/interfaces/IPayable.sol";
import {AbstractPayer} from "reactive-lib/base/AbstractPayer.sol";
import {AbstractCallback} from "reactive-lib/base/AbstractCallback.sol";
import {ReactiveSim} from "./utils/ReactiveSim.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {HobVault} from "../src/HobVault.sol";
import {HobReactive} from "../src/HobReactive.sol";
import {HobTypes} from "../src/HobTypes.sol";
import {IERC20Min} from "../src/interfaces/IERC20Min.sol";
import {IReactive} from "reactive-lib/interfaces/IReactive.sol";

contract HobTest is ReactiveSim {
    uint256 constant BASE = 84532; // home (Base Sepolia)
    uint256 constant UNI = 1301; // mirror (Unichain Sepolia)
    uint8 constant GROCERIES = 0;
    uint8 constant LEISURE = 1;
    uint64 constant PERIOD = 30 days;

    address alice = makeAddr("alice"); // adult
    address bob = makeAddr("bob"); // adult
    address agent = makeAddr("agent"); // AI shopping agent
    address shop = makeAddr("shop");
    address proxyBase = makeAddr("proxyBase");
    address proxyUni = makeAddr("proxyUni");

    MockUSDC usdcBase;
    MockUSDC usdcUni;
    HobVault home;
    HobVault mirror;
    HobReactive rsc;
    uint64 epoch;

    function setUp() public {
        vm.warp(1_780_000_000);
        epoch = uint64(block.timestamp);
        _installSystem();

        rsc = new HobReactive(
            8000, // tighten at 80%
            HobReactive.VelocityConfig({maxAmount: 2000e6, maxTx: 30, window: 1 hours, freezeFor: 1 hours}), // adults
            HobReactive.VelocityConfig({maxAmount: 300e6, maxTx: 6, window: 1 hours, freezeFor: 1 days}) // agents
        );

        usdcBase = new MockUSDC();
        usdcUni = new MockUSDC();

        address[] memory adults = new address[](2);
        adults[0] = alice;
        adults[1] = bob;
        home = new HobVault(IPayable(payable(proxyBase)), address(rsc), IERC20Min(address(usdcBase)), true, epoch, PERIOD, adults);
        mirror = new HobVault(
            IPayable(payable(proxyUni)), address(rsc), IERC20Min(address(usdcUni)), false, epoch, PERIOD, new address[](0)
        );
        _bindChain(address(home), BASE, proxyBase);
        _bindChain(address(mirror), UNI, proxyUni);

        rsc.registerVault(BASE, address(home), true);
        rsc.registerVault(UNI, address(mirror), false);

        usdcBase.mint(address(home), 10_000e6);
        usdcUni.mint(address(mirror), 10_000e6);

        vm.getRecordedLogs(); // ignore constructor noise

        // one-time sync of the founding adults to every mirror
        address[] memory list = new address[](2);
        list[0] = alice;
        list[1] = bob;
        vm.prank(alice);
        home.resync(list, new uint8[](0));
        _relay();
    }

    // ------------------------------------------------------------------ helpers

    function _ratify(uint8 cat, uint128 cap, uint128 perTx, uint128 coSign) internal {
        vm.prank(alice);
        uint256 id = home.proposeRule(cat, HobTypes.Rule(cap, perTx, coSign, true));
        vm.prank(bob);
        home.approveProposal(id);
        _relay();
    }

    function _addAgent() internal {
        vm.prank(alice);
        uint256 id = home.proposeMember(agent, HobTypes.Role.AGENT);
        vm.prank(bob);
        home.approveProposal(id);
        _relay();
    }

    function _standardHouse() internal {
        _ratify(GROCERIES, 1000e6, 200e6, 150e6);
        _addAgent();
    }

    function _mode(HobVault v, uint8 cat) internal view returns (HobTypes.Mode m) {
        (m,,) = v.categoryStatus(cat);
    }

    function _household(uint8 cat) internal view returns (uint128 spent) {
        (spent,) = rsc.ledger(home.currentPeriod(), cat);
    }

    // ------------------------------------------------------------------ setup & governance

    function test_subscriptions_registered() public view {
        // home: Spent + RulesRatified + MemberSet ; mirror: Spent
        assertEq(_system().subs().length, 4);
        assertEq(rsc.vaultCount(), 2);
    }

    function test_adults_mirrored_after_resync() public view {
        (HobTypes.Role r,,,) = mirror.members(alice);
        assertEq(uint8(r), uint8(HobTypes.Role.ADULT));
        assertEq(mirror.adultCount(), 2);
    }

    function test_rule_needs_quorum_then_mirrors() public {
        vm.prank(alice);
        uint256 id = home.proposeRule(GROCERIES, HobTypes.Rule(1000e6, 200e6, 150e6, true));
        _relay();
        (,, bool active0) = _ruleOf(home, GROCERIES);
        assertFalse(active0, "one adult is not quorum");

        vm.prank(bob);
        home.approveProposal(id);
        _relay();

        (uint128 capH,, bool activeH) = _ruleOf(home, GROCERIES);
        (uint128 capM,, bool activeM) = _ruleOf(mirror, GROCERIES);
        assertTrue(activeH && activeM);
        assertEq(capH, 1000e6);
        assertEq(capM, 1000e6);
        assertEq(rsc.capOf(GROCERIES), 1000e6);
    }

    function test_agent_can_propose_but_not_ratify() public {
        _standardHouse();
        vm.prank(agent);
        uint256 id = home.proposeRule(LEISURE, HobTypes.Rule(300e6, 100e6, 80e6, true));
        assertEq(home.proposal(id).approvals, 0, "agent proposal carries no approval");

        vm.prank(agent);
        vm.expectRevert(HobVault.NotAdult.selector);
        home.approveProposal(id);

        vm.prank(alice);
        home.approveProposal(id);
        vm.prank(bob);
        home.approveProposal(id);
        _relay();
        (uint128 cap,, bool active) = _ruleOf(mirror, LEISURE);
        assertTrue(active);
        assertEq(cap, 300e6);
    }

    function test_mirror_rejects_local_governance() public {
        vm.prank(alice);
        vm.expectRevert(HobVault.OnlyHome.selector);
        mirror.proposeRule(GROCERIES, HobTypes.Rule(1, 1, 1, true));
    }

    function test_bad_rule_rejected() public {
        vm.prank(alice);
        vm.expectRevert(HobVault.BadRule.selector);
        home.proposeRule(GROCERIES, HobTypes.Rule(100e6, 200e6, 50e6, true)); // perTx > cap
    }

    // ------------------------------------------------------------------ local checks

    function test_spend_below_cosign_executes_and_ledger_aggregates_chains() public {
        _standardHouse();
        vm.prank(alice);
        home.spend(GROCERIES, shop, 100e6);
        vm.prank(bob);
        mirror.spend(GROCERIES, shop, 120e6);
        _relay();

        assertEq(usdcBase.balanceOf(shop), 100e6);
        assertEq(usdcUni.balanceOf(shop), 120e6);
        assertEq(_household(GROCERIES), 220e6, "ledger sums both chains");
        assertEq(rsc.spentByChain(home.currentPeriod(), GROCERIES, BASE), 100e6);
        assertEq(rsc.spentByChain(home.currentPeriod(), GROCERIES, UNI), 120e6);
    }

    function test_above_tx_cap_reverts() public {
        _standardHouse();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HobVault.AboveTxCap.selector, 250e6, 200e6));
        home.spend(GROCERIES, shop, 250e6);
    }

    function test_cosign_flow() public {
        _standardHouse();
        vm.prank(alice);
        uint256 id = home.spend(GROCERIES, shop, 180e6); // > 150 co-sign threshold
        assertEq(usdcBase.balanceOf(shop), 0);

        vm.prank(alice);
        vm.expectRevert(HobVault.SelfApproval.selector);
        home.approveSpend(id);

        vm.prank(agent);
        vm.expectRevert(HobVault.NotAdult.selector);
        home.approveSpend(id);

        vm.prank(bob);
        home.approveSpend(id);
        assertEq(usdcBase.balanceOf(shop), 180e6);

        vm.prank(bob);
        vm.expectRevert(HobVault.Closed.selector);
        home.approveSpend(id);
    }

    function test_pending_expires() public {
        _standardHouse();
        vm.prank(alice);
        uint256 id = home.spend(GROCERIES, shop, 180e6);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(bob);
        vm.expectRevert(HobVault.Expired.selector);
        home.approveSpend(id);
    }

    function test_local_rate_limit_agent() public {
        _standardHouse();
        for (uint256 i; i < 5; ++i) {
            vm.prank(agent);
            home.spend(GROCERIES, shop, 1e6);
        }
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HobVault.RateLimited.selector, uint32(5), uint32(1 hours)));
        home.spend(GROCERIES, shop, 1e6);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(agent);
        home.spend(GROCERIES, shop, 1e6); // window rolled
    }

    function test_non_member_cannot_spend() public {
        _standardHouse();
        vm.prank(shop);
        vm.expectRevert(HobVault.NotMember.selector);
        home.spend(GROCERIES, shop, 1e6);
    }

    // ------------------------------------------------------------------ reactive: household-wide cap

    function test_tighten_at_80_percent_on_all_chains() public {
        _standardHouse();
        // 4 x 140 = 560 on Base, 2 x 140 = 280 on Unichain → 840 = 84% of 1000
        for (uint256 i; i < 4; ++i) {
            vm.prank(alice);
            home.spend(GROCERIES, shop, 140e6);
        }
        for (uint256 i; i < 2; ++i) {
            vm.prank(bob);
            mirror.spend(GROCERIES, shop, 140e6);
        }
        _relay();

        assertEq(uint8(_mode(home, GROCERIES)), uint8(HobTypes.Mode.TIGHT));
        assertEq(uint8(_mode(mirror, GROCERIES)), uint8(HobTypes.Mode.TIGHT));

        // Remaining household budget = 160 → 80 per chain.
        (, uint128 limitH, uint128 spentH) = home.categoryStatus(GROCERIES);
        (, uint128 limitM, uint128 spentM) = mirror.categoryStatus(GROCERIES);
        assertEq(limitH - spentH, 80e6);
        assertEq(limitM - spentM, 80e6);

        // Agent now needs a co-sign, even for small spends.
        vm.prank(agent);
        uint256 id = mirror.spend(GROCERIES, shop, 10e6);
        assertTrue(id != type(uint256).max, "agent spend became a request");

        // An adult cannot spend more than this chain's slice.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HobVault.AboveLocalLimit.selector, 650e6, 640e6));
        home.spend(GROCERIES, shop, 90e6);
    }

    function test_freeze_when_household_cap_reached() public {
        _standardHouse();
        _ratify(GROCERIES, 1000e6, 200e6, 200e6); // co-sign only above per-tx cap
        // Jump from 0 to 1000 across chains before any reaction arrives (worst case latency).
        for (uint256 i; i < 3; ++i) {
            vm.prank(alice);
            home.spend(GROCERIES, shop, 200e6);
        }
        for (uint256 i; i < 2; ++i) {
            vm.prank(bob);
            mirror.spend(GROCERIES, shop, 200e6);
        }
        _relay();

        assertEq(uint8(_mode(home, GROCERIES)), uint8(HobTypes.Mode.FROZEN));
        assertEq(uint8(_mode(mirror, GROCERIES)), uint8(HobTypes.Mode.FROZEN));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HobVault.CategoryFrozen.selector, GROCERIES));
        home.spend(GROCERIES, shop, 1e6);
    }

    function test_new_period_resets_without_cron() public {
        test_freeze_when_household_cap_reached();
        vm.warp(block.timestamp + PERIOD);
        assertEq(uint8(_mode(home, GROCERIES)), uint8(HobTypes.Mode.NORMAL));
        vm.prank(alice);
        home.spend(GROCERIES, shop, 50e6);
        _relay();
        assertEq(_household(GROCERIES), 50e6, "fresh ledger for the new period");
    }

    function test_stale_period_callback_ignored() public {
        _standardHouse();
        uint64 p = home.currentPeriod();
        vm.warp(block.timestamp + PERIOD);
        vm.prank(proxyBase);
        home.cbCategoryMode(address(rsc), GROCERIES, p, HobTypes.Mode.FROZEN, 0);
        assertEq(uint8(_mode(home, GROCERIES)), uint8(HobTypes.Mode.NORMAL));
    }

    function test_stale_callback_cannot_erase_current_period_state() public {
        _standardHouse();
        uint64 old = home.currentPeriod();
        vm.warp(block.timestamp + PERIOD); // new month
        uint64 cur = home.currentPeriod();
        vm.startPrank(proxyBase);
        home.cbCategoryMode(address(rsc), GROCERIES, cur, HobTypes.Mode.TIGHT, 100e6);
        // a late FROZEN from last month arrives now
        home.cbCategoryMode(address(rsc), GROCERIES, old, HobTypes.Mode.FROZEN, 0);
        vm.stopPrank();
        assertEq(uint8(_mode(home, GROCERIES)), uint8(HobTypes.Mode.TIGHT), "current TIGHT must survive");
    }

    function test_unknown_member_gets_strictest_velocity() public {
        _standardHouse();
        address stranger = makeAddr("stranger"); // never announced by the home vault
        assertEq(uint8(rsc.roleOf(stranger)), 0);
        vm.startPrank(SYSTEM_ADDR);
        for (uint256 i; i < 7; ++i) {
            rsc.react(
                IReactive.LogRecord({
                    chainId: BASE,
                    contractAddress: address(home),
                    topic0: rsc.SPENT_TOPIC(),
                    topic1: uint256(uint160(stranger)),
                    topic2: GROCERIES,
                    topic3: home.currentPeriod(),
                    data: abi.encode(uint256(1e6), shop, uint256(1e6), uint64(block.timestamp)),
                    blockNumber: 1,
                    opCode: 4,
                    blockHash: 1,
                    txHash: 9000 + i,
                    logIndex: 0
                })
            );
        }
        vm.stopPrank();
        (,,, uint64 frozenUntil) = rsc.velocityOf(stranger);
        assertGt(frozenUntil, 0, "7 tx/h breaches the agent limit (6), not the adult one (30)");
    }

    function test_modes_never_downgrade() public {
        _standardHouse();
        uint64 p = home.currentPeriod();
        vm.startPrank(proxyBase);
        home.cbCategoryMode(address(rsc), GROCERIES, p, HobTypes.Mode.FROZEN, 0);
        home.cbCategoryMode(address(rsc), GROCERIES, p, HobTypes.Mode.TIGHT, 500e6);
        vm.stopPrank();
        assertEq(uint8(_mode(home, GROCERIES)), uint8(HobTypes.Mode.FROZEN));
    }

    /// The honest number: how far can the household overshoot while a reaction is in flight?
    function test_overshoot_bounded_by_local_checks() public {
        _standardHouse();
        // Both adults spend in parallel on two chains; NOTHING is relayed yet (latency).
        for (uint256 i; i < 5; ++i) {
            vm.prank(alice);
            home.spend(GROCERIES, shop, 140e6);
            vm.prank(bob);
            mirror.spend(GROCERIES, shop, 140e6);
        }
        Vm.Log[] memory held = _holdLogs();
        // 1400 spent against a 1000 cap: this is the latency window with no reactive layer at all.
        assertEq(home.localSpent(home.currentPeriod(), GROCERIES) + mirror.localSpent(home.currentPeriod(), GROCERIES), 1400e6);

        _deliverHeld(held);
        // Once the reactions land, both chains are frozen.
        assertEq(uint8(_mode(home, GROCERIES)), uint8(HobTypes.Mode.FROZEN));
        assertEq(uint8(_mode(mirror, GROCERIES)), uint8(HobTypes.Mode.FROZEN));
        // The overshoot window is ~one reaction round-trip; the local per-tx cap and
        // rate limit bound what fits inside it (documented in README).
    }

    // ------------------------------------------------------------------ reactive: velocity breaker

    function test_agent_frozen_everywhere_on_cross_chain_burst() public {
        _standardHouse();
        // 3 spends on Base + 4 on Unichain. Each chain alone is within the agent's
        // local limit (5/hour), but together it's 7 > 6 → household-wide breaker.
        for (uint256 i; i < 3; ++i) {
            vm.prank(agent);
            home.spend(GROCERIES, shop, 20e6);
        }
        for (uint256 i; i < 4; ++i) {
            vm.prank(agent);
            mirror.spend(GROCERIES, shop, 20e6);
        }
        _relay();

        (, uint64 fh,,) = home.members(agent);
        (, uint64 fm,,) = mirror.members(agent);
        assertGt(fh, block.timestamp);
        assertEq(fh, fm, "same freeze on both chains");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HobVault.MemberIsFrozen.selector, fh));
        home.spend(GROCERIES, shop, 1e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HobVault.MemberIsFrozen.selector, fm));
        mirror.spend(GROCERIES, shop, 1e6);
    }

    function test_velocity_by_amount() public {
        _standardHouse();
        // 150 + 150 + 10 = 310 > 300 in one hour across chains
        vm.prank(agent);
        home.spend(GROCERIES, shop, 150e6);
        vm.prank(agent);
        mirror.spend(GROCERIES, shop, 150e6);
        vm.prank(agent);
        mirror.spend(GROCERIES, shop, 10e6);
        _relay();
        (, uint64 fm,,) = mirror.members(agent);
        assertGt(fm, block.timestamp);
    }

    function test_adults_not_frozen_by_normal_heavy_shopping() public {
        _ratify(GROCERIES, 5000e6, 200e6, 200e6);
        // 6 x 150 = 900 in one hour across chains: fine for an adult, would freeze an agent
        for (uint256 i; i < 3; ++i) {
            vm.prank(alice);
            home.spend(GROCERIES, shop, 150e6);
            vm.prank(alice);
            mirror.spend(GROCERIES, shop, 150e6);
        }
        _relay();
        (, uint64 f,,) = home.members(alice);
        assertEq(f, 0);
        assertEq(uint8(rsc.roleOf(alice)), uint8(HobTypes.Role.ADULT));
    }

    function test_react_gas_fits_network_cap() public {
        _standardHouse();
        _ratify(GROCERIES, 100e6, 100e6, 100e6);
        // one spend that hits the cap AND breaches agent velocity in the same reaction
        for (uint256 i; i < 3; ++i) {
            vm.prank(agent);
            home.spend(GROCERIES, shop, 1e6);
            vm.prank(agent);
            mirror.spend(GROCERIES, shop, 1e6);
        }
        _relay();
        vm.warp(block.timestamp + 2 hours);
        vm.prank(alice);
        home.unfreezeMember(agent);
        _relay();

        vm.prank(agent);
        mirror.spend(GROCERIES, shop, 94e6); // 6 + 94 = 100 → FROZEN broadcast
        Vm.Log[] memory held = _holdLogs();
        uint256 before = gasleft();
        _deliverLogs(held);
        uint256 used = before - gasleft();
        console2.log("react() gas incl. harness overhead:", used);
        assertLt(used, 900_000, "must fit Reactive's per-transaction cap");
        _deliverCallbacks();
        assertEq(callbacksFailed, 0);
    }

    function test_unfreeze_on_home_propagates() public {
        test_agent_frozen_everywhere_on_cross_chain_burst();
        vm.prank(alice);
        home.unfreezeMember(agent);
        _relay();
        (, uint64 fh,,) = home.members(agent);
        (, uint64 fm,,) = mirror.members(agent);
        assertEq(fh, 0);
        assertEq(fm, 0);
        (,,, uint64 rf) = rsc.velocityOf(agent);
        assertEq(rf, 0, "reactive memory cleared too");
    }

    function test_freeze_expires_by_itself() public {
        test_agent_frozen_everywhere_on_cross_chain_burst();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(agent);
        mirror.spend(GROCERIES, shop, 1e6);
    }

    function test_remove_member_propagates() public {
        _standardHouse();
        vm.prank(alice);
        uint256 id = home.proposeMember(agent, HobTypes.Role.NONE);
        vm.prank(bob);
        home.approveProposal(id);
        _relay();
        vm.prank(agent);
        vm.expectRevert(HobVault.NotMember.selector);
        mirror.spend(GROCERIES, shop, 1e6);
    }

    // ------------------------------------------------------------------ security

    function test_callbacks_only_from_proxy() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, alice, proxyUni));
        mirror.cbFreezeMember(address(rsc), bob, type(uint64).max);
    }

    function test_callbacks_only_from_our_reactive_contract() public {
        address evil = makeAddr("evilRsc");
        vm.prank(proxyUni);
        vm.expectRevert(abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, evil, address(rsc)));
        mirror.cbFreezeMember(evil, bob, type(uint64).max);
    }

    function test_react_only_from_system() public {
        IReactive.LogRecord memory rec;
        vm.prank(alice);
        vm.expectRevert();
        rsc.react(rec);
    }

    function test_react_ignores_unknown_emitters_and_duplicates() public {
        _standardHouse();
        vm.prank(alice);
        home.spend(GROCERIES, shop, 100e6);
        Vm.Log[] memory held = _holdLogs();

        // deliver the Spent log twice with the same tx hash / log index
        IReactive.LogRecord memory rec;
        for (uint256 i; i < held.length; ++i) {
            if (held[i].emitter == address(home) && uint256(held[i].topics[0]) == rsc.SPENT_TOPIC()) {
                rec = IReactive.LogRecord({
                    chainId: BASE,
                    contractAddress: address(home),
                    topic0: uint256(held[i].topics[0]),
                    topic1: uint256(held[i].topics[1]),
                    topic2: uint256(held[i].topics[2]),
                    topic3: uint256(held[i].topics[3]),
                    data: held[i].data,
                    blockNumber: 1,
                    opCode: 4,
                    blockHash: 1,
                    txHash: 777,
                    logIndex: 0
                });
            }
        }
        vm.startPrank(SYSTEM_ADDR);
        rsc.react(rec);
        rsc.react(rec);
        rec.contractAddress = shop; // not a registered vault
        rsc.react(rec);
        vm.stopPrank();
        assertEq(_household(GROCERIES), 100e6);
    }

    function test_register_limits() public {
        vm.expectRevert(HobReactive.AlreadyRegistered.selector);
        rsc.registerVault(UNI, address(mirror), false);
        vm.expectRevert(HobReactive.HomeAlreadySet.selector);
        rsc.registerVault(1, address(0xBEEF), true);
        vm.prank(alice);
        vm.expectRevert(HobReactive.OnlyOwner.selector);
        rsc.registerVault(1, address(0xBEEF), false);
    }

    function test_all_callbacks_succeed_in_full_flow() public {
        test_tighten_at_80_percent_on_all_chains();
        assertEq(callbacksFailed, 0);
        assertGt(callbacksDelivered, 0);
    }

    // ------------------------------------------------------------------ narrated demo

    function test_demo_story() public {
        console2.log("== 1. Household ratifies (2 of 2 adults): groceries 1000 USDC/month, 200/tx, co-sign above 150");
        _ratify(GROCERIES, 1000e6, 200e6, 150e6);
        console2.log("   Reactive mirrored the rule to Unichain, cap:", _cap(mirror, GROCERIES) / 1e6);

        console2.log("== 2. Household adds its AI shopping agent (adults vote)");
        _addAgent();

        console2.log("== 3. Normal week: adults shop on Base and Unichain");
        for (uint256 i; i < 2; ++i) {
            vm.prank(alice);
            home.spend(GROCERIES, shop, 140e6);
            vm.prank(bob);
            mirror.spend(GROCERIES, shop, 140e6);
        }
        _relay();
        console2.log("   household spent, all chains:", _household(GROCERIES) / 1e6);

        console2.log("== 4. Agent bursts: 3 buys on Base + 4 on Unichain (each chain alone is under its 5/h limit)");
        for (uint256 i; i < 3; ++i) {
            vm.prank(agent);
            home.spend(GROCERIES, shop, 20e6);
        }
        for (uint256 i; i < 4; ++i) {
            vm.prank(agent);
            mirror.spend(GROCERIES, shop, 20e6);
        }
        _relay();
        (, uint64 fb,,) = home.members(agent);
        (, uint64 fu,,) = mirror.members(agent);
        console2.log("   7 buys > 6/h household-wide -> agent frozen on Base until:", fb);
        console2.log("   ... and on Unichain until:                              ", fu);

        console2.log("== 5. Alice buys 140 on Base -> household crosses 80%");
        vm.prank(alice);
        home.spend(GROCERIES, shop, 140e6);
        _relay();
        (, uint128 lb, uint128 sb) = home.categoryStatus(GROCERIES);
        (, uint128 lu, uint128 su) = mirror.categoryStatus(GROCERIES);
        console2.log("   household spent:", _household(GROCERIES) / 1e6);
        console2.log("   mode Base / Unichain (1 = TIGHT):", uint8(_mode(home, GROCERIES)), uint8(_mode(mirror, GROCERIES)));
        console2.log("   remaining split per chain, Base / Unichain:", (lb - sb) / 1e6, (lu - su) / 1e6);

        console2.log("== 6. Each adult uses their chain's slice -> household cap reached");
        vm.prank(alice);
        home.spend(GROCERIES, shop, 80e6);
        vm.prank(bob);
        mirror.spend(GROCERIES, shop, 80e6);
        _relay();
        console2.log("   household spent:", _household(GROCERIES) / 1e6);
        console2.log("   mode Base / Unichain (2 = FROZEN):", uint8(_mode(home, GROCERIES)), uint8(_mode(mirror, GROCERIES)));

        console2.log("== 7. Next month: fresh budget, no cron, no keeper");
        vm.warp(block.timestamp + PERIOD);
        console2.log("   mode Base / Unichain:", uint8(_mode(home, GROCERIES)), uint8(_mode(mirror, GROCERIES)));
        console2.log("   reactions / callbacks delivered / failed:", reactionsDelivered, callbacksDelivered);
        console2.log("   failed callbacks:", callbacksFailed);

        assertEq(_household(GROCERIES), 0); // new period
        assertEq(callbacksFailed, 0);
    }

    // ------------------------------------------------------------------ view helpers

    function _ruleOf(HobVault v, uint8 cat) internal view returns (uint128 cap, uint128 perTx, bool active) {
        uint128 coSign;
        (cap, perTx, coSign, active) = v.rules(cat);
    }

    function _cap(HobVault v, uint8 cat) internal view returns (uint256 cap) {
        (cap,,) = _ruleOf(v, cat);
    }

    // ------------------------------------------------------------------ rule-by-rule coverage
    // One test per household rule that the tests above don't already pin down.

    HobTypes.Rule internal GROCERY_RULE = HobTypes.Rule(1000e6, 200e6, 150e6, true);

    function _freezeAgentByBurst() internal {
        for (uint256 i; i < 3; ++i) {
            vm.prank(agent);
            home.spend(GROCERIES, shop, 10e6);
        }
        for (uint256 i; i < 4; ++i) {
            vm.prank(agent);
            mirror.spend(GROCERIES, shop, 10e6);
        }
        _relay();
    }

    function _frozenUntil(HobVault v, address who) internal view returns (uint64 until) {
        (, until,,) = v.members(who);
    }

    /// Rule: no ratified rule, no spending.
    function test_no_rule_means_no_spending() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HobVault.CategoryInactive.selector, GROCERIES));
        home.spend(GROCERIES, shop, 10e6);
    }

    /// Rule: pausing a category is a household decision and applies on every chain.
    function test_paused_rule_blocks_spending_on_every_chain() public {
        _standardHouse();
        vm.prank(alice);
        uint256 id = home.proposeRule(GROCERIES, HobTypes.Rule(1000e6, 200e6, 150e6, false));
        vm.prank(bob);
        home.approveProposal(id);
        _relay();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HobVault.CategoryInactive.selector, GROCERIES));
        home.spend(GROCERIES, shop, 10e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(HobVault.CategoryInactive.selector, GROCERIES));
        mirror.spend(GROCERIES, shop, 10e6);
    }

    /// Rule: one adult is one vote. Approving twice does not reach quorum.
    function test_one_adult_cannot_vote_twice() public {
        vm.prank(alice);
        uint256 id = home.proposeRule(GROCERIES, GROCERY_RULE); // proposing counts as Alice's vote
        vm.prank(alice);
        vm.expectRevert(HobVault.AlreadyApproved.selector);
        home.approveProposal(id);
        (,, bool active) = _ruleOf(home, GROCERIES);
        assertFalse(active);
    }

    /// Rule: a proposal lives 7 days; after that it cannot be ratified.
    function test_proposal_expires_after_seven_days() public {
        vm.prank(alice);
        uint256 id = home.proposeRule(GROCERIES, GROCERY_RULE);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(bob);
        vm.expectRevert(HobVault.Expired.selector);
        home.approveProposal(id);
    }

    /// Rule: a ratified proposal is closed; unknown proposals don't exist.
    function test_executed_or_unknown_proposal_rejected() public {
        vm.prank(alice);
        uint256 id = home.proposeRule(GROCERIES, GROCERY_RULE);
        vm.prank(bob);
        home.approveProposal(id);
        vm.prank(alice);
        vm.expectRevert(HobVault.Closed.selector);
        home.approveProposal(id);
        vm.prank(alice);
        vm.expectRevert(HobVault.BadProposal.selector);
        home.approveProposal(999);
    }

    /// Rule: the requester or an adult can cancel a request; a cancelled request can't be co-signed.
    function test_cancelled_request_cannot_be_cosigned() public {
        _standardHouse();
        vm.prank(bob);
        uint256 req = home.spend(GROCERIES, shop, 180e6);

        vm.prank(agent); // not the requester, not an adult
        vm.expectRevert(HobVault.NotAdult.selector);
        home.cancelSpend(req);

        vm.prank(bob);
        home.cancelSpend(req);
        vm.prank(alice);
        vm.expectRevert(HobVault.Closed.selector);
        home.approveSpend(req);
        vm.prank(bob);
        vm.expectRevert(HobVault.Closed.selector);
        home.cancelSpend(req);
    }

    /// Rule: the agent shops and proposes, nothing more.
    function test_agent_has_no_adult_powers() public {
        _standardHouse();
        vm.prank(bob);
        uint256 req = home.spend(GROCERIES, shop, 180e6);

        vm.startPrank(agent);
        vm.expectRevert(HobVault.NotAdult.selector);
        home.approveSpend(req);
        vm.expectRevert(HobVault.NotAdult.selector);
        home.unfreezeMember(agent);
        vm.expectRevert(HobVault.NotAdult.selector);
        home.proposeMember(agent, HobTypes.Role.ADULT);
        vm.expectRevert(HobVault.NotAdult.selector);
        home.cancelSpend(req);
        vm.stopPrank();
    }

    /// Rule: a frozen agent can't even propose.
    function test_frozen_agent_cannot_propose() public {
        _standardHouse();
        _freezeAgentByBurst();
        uint64 until = _frozenUntil(home, agent);
        assertGt(until, block.timestamp);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HobVault.MemberIsFrozen.selector, until));
        home.proposeRule(GROCERIES, GROCERY_RULE);
    }

    /// Rule: a frozen adult has no vote (propose, approve, co-sign) until another adult lifts it.
    function test_frozen_adult_has_no_vote_until_unfrozen() public {
        _standardHouse();
        _ratify(LEISURE, 10_000e6, 2000e6, 2000e6);
        // 2,200 in an hour across chains: above the adult velocity limit of 2,000
        vm.prank(alice);
        home.spend(LEISURE, shop, 1100e6);
        vm.prank(alice);
        mirror.spend(LEISURE, shop, 1100e6);
        _relay();
        uint64 until = _frozenUntil(home, alice);
        assertGt(until, block.timestamp, "alice frozen by velocity");

        bytes memory frozen = abi.encodeWithSelector(HobVault.MemberIsFrozen.selector, until);
        vm.prank(alice);
        vm.expectRevert(frozen);
        home.proposeRule(GROCERIES, GROCERY_RULE);

        vm.prank(bob);
        uint256 pid = home.proposeRule(GROCERIES, HobTypes.Rule(900e6, 200e6, 150e6, true));
        vm.prank(alice);
        vm.expectRevert(frozen);
        home.approveProposal(pid);

        vm.prank(bob);
        uint256 req = home.spend(GROCERIES, shop, 180e6);
        vm.prank(alice);
        vm.expectRevert(frozen);
        home.approveSpend(req);

        // Bob lifts it; Reactive mirrors it; Alice votes again.
        vm.prank(bob);
        home.unfreezeMember(alice);
        _relay();
        assertEq(_frozenUntil(mirror, alice), 0);
        vm.prank(alice);
        home.approveProposal(pid);
        assertEq(_cap(home, GROCERIES), 900e6);
    }

    /// Rule: a co-sign re-checks the requester. A freeze in the meantime blocks it.
    function test_cosign_rechecks_requester_freeze() public {
        _standardHouse();
        vm.prank(agent);
        uint256 req = home.spend(GROCERIES, shop, 160e6); // above 150: needs a second adult
        _freezeAgentByBurst();
        uint64 until = _frozenUntil(home, agent);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HobVault.MemberIsFrozen.selector, until));
        home.approveSpend(req);
    }

    /// Rule: a co-sign re-checks the category. Once the cap is reached, old requests can't execute.
    function test_cosign_after_cap_is_refused() public {
        _standardHouse();
        vm.prank(bob);
        uint256 req = home.spend(GROCERIES, shop, 180e6);
        _ratify(GROCERIES, 1000e6, 200e6, 200e6);
        for (uint256 i; i < 3; ++i) {
            vm.prank(alice);
            home.spend(GROCERIES, shop, 200e6);
        }
        for (uint256 i; i < 2; ++i) {
            vm.prank(bob);
            mirror.spend(GROCERIES, shop, 200e6);
        }
        _relay();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HobVault.CategoryFrozen.selector, GROCERIES));
        home.approveSpend(req);
    }

    /// Rule: inputs are validated.
    function test_input_validation() public {
        _standardHouse();
        vm.startPrank(alice);
        vm.expectRevert(HobVault.InvalidAmount.selector);
        home.spend(GROCERIES, shop, 0);
        vm.expectRevert(HobVault.InvalidAmount.selector);
        home.spend(GROCERIES, address(0), 10e6);
        vm.expectRevert(HobVault.BadCategory.selector);
        home.proposeRule(16, GROCERY_RULE);
        vm.expectRevert(HobVault.BadProposal.selector);
        home.proposeMember(address(0), HobTypes.Role.ADULT);
        vm.stopPrank();
        vm.prank(shop);
        vm.expectRevert(HobVault.NotMember.selector);
        home.proposeRule(GROCERIES, GROCERY_RULE);
    }

    /// Documented limit: a rule change mid-period updates the numbers, but an escalated mode stays.
    function test_rule_change_mid_period_keeps_escalated_mode() public {
        _standardHouse();
        for (uint256 i; i < 6; ++i) {
            vm.prank(i % 2 == 0 ? alice : bob);
            (i % 2 == 0 ? home : mirror).spend(GROCERIES, shop, 140e6);
        }
        _relay();
        assertEq(uint8(_mode(home, GROCERIES)), uint8(HobTypes.Mode.TIGHT));
        _ratify(GROCERIES, 2000e6, 200e6, 150e6);
        assertEq(rsc.capOf(GROCERIES), 2000e6, "Reactive learned the new cap");
        assertEq(_cap(mirror, GROCERIES), 2000e6, "mirror got the new cap");
        assertEq(uint8(_mode(home, GROCERIES)), uint8(HobTypes.Mode.TIGHT), "still tight until next period");
        assertEq(uint8(_mode(mirror, GROCERIES)), uint8(HobTypes.Mode.TIGHT));
    }

    /// Documented: removing an adult needs both adults; afterwards the remaining adult decides alone.
    function test_removing_an_adult_needs_their_consent_then_quorum_is_one() public {
        vm.prank(alice);
        uint256 id = home.proposeMember(bob, HobTypes.Role.NONE);
        assertEq(home.quorum(), 2);
        (HobTypes.Role r0,,,) = home.members(bob);
        assertEq(uint8(r0), uint8(HobTypes.Role.ADULT), "Alice alone can't remove Bob");
        vm.prank(bob);
        home.approveProposal(id);
        _relay();
        assertEq(home.quorum(), 1);
        (HobTypes.Role rm,,,) = mirror.members(bob);
        assertEq(uint8(rm), uint8(HobTypes.Role.NONE), "removal mirrored");
    }

    /// Rule: the household always keeps at least one adult.
    function test_last_adult_cannot_be_removed_or_demoted() public {
        test_removing_an_adult_needs_their_consent_then_quorum_is_one(); // Bob removed, Alice alone
        vm.prank(alice);
        vm.expectRevert(HobVault.LastAdult.selector);
        home.proposeMember(alice, HobTypes.Role.AGENT); // quorum 1: executes at once → reverts
        vm.prank(alice);
        vm.expectRevert(HobVault.LastAdult.selector);
        home.proposeMember(alice, HobTypes.Role.NONE);
    }

    /// Security: after seal(), not even the deployer can add a vault or change the limits.
    function test_sealed_setup_cannot_be_changed_by_deployer() public {
        rsc.seal();
        assertTrue(rsc.isSealed());
        vm.expectRevert(HobReactive.IsSealed.selector);
        rsc.registerVault(999, address(0xBEEF), false);
        vm.expectRevert(HobReactive.IsSealed.selector);
        rsc.setVelocity(HobTypes.Role.AGENT, HobReactive.VelocityConfig(1e30, 1000, 1 hours, 0));
        vm.expectRevert(HobReactive.IsSealed.selector);
        rsc.setTighten(9999);
        vm.expectRevert(HobReactive.IsSealed.selector);
        rsc.seal();
        vm.prank(alice);
        vm.expectRevert(HobReactive.OnlyOwner.selector);
        rsc.seal();
    }
}
