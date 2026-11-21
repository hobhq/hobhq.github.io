// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractCallback} from "reactive-lib/base/AbstractCallback.sol";
import {IPayable} from "reactive-lib/interfaces/IPayable.sol";
import {IERC20Min} from "./interfaces/IERC20Min.sol";
import {HobTypes} from "./HobTypes.sol";

/// @title HobVault
/// @notice A household spending vault. One instance per chain.
///
/// The HOME vault is where the household governs: members propose and ratify
/// spending rules (quorum of adults). MIRROR vaults on other chains receive
/// those rules from the reactive contract, never from a local admin.
///
/// Every vault enforces the local, synchronous checks (per-tx cap, co-sign
/// threshold, per-role rate limit, local monthly ceiling). The reactive
/// contract on Reactive Network watches the `Spent` events of every vault,
/// keeps the cross-chain ledger and calls back to tighten / freeze a category
/// or freeze a member on ALL chains when the household-wide limits are hit.
contract HobVault is AbstractCallback {

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    struct Member {
        HobTypes.Role role;
        uint64 frozenUntil; // set by the reactive contract (cross-chain velocity breaker)
        uint64 windowStart; // local rate limit window
        uint32 windowCount;
    }

    struct CategoryState {
        uint64 period; // period the mode applies to; stale periods read as NORMAL
        HobTypes.Mode mode;
        uint128 limit; // local spend ceiling for that period while TIGHT / FROZEN
    }

    struct PendingSpend {
        address member;
        address to;
        uint128 amount;
        uint64 expiresAt;
        uint8 category;
        bool closed;
    }

    enum ProposalKind {
        RULE,
        MEMBER
    }

    struct Proposal {
        ProposalKind kind;
        address proposer;
        uint64 expiresAt;
        uint8 approvals;
        bool executed;
        // RULE
        uint8 category;
        HobTypes.Rule rule;
        // MEMBER
        address member;
        HobTypes.Role role;
    }

    struct RateLimit {
        uint32 maxTx;
        uint32 window; // seconds
    }

    // ------------------------------------------------------------------
    // Constants / immutables
    // ------------------------------------------------------------------

    uint64 public constant PENDING_TTL = 1 days;
    uint64 public constant PROPOSAL_TTL = 7 days;
    uint8 public constant MAX_CATEGORIES = 16;
    uint256 public constant MAX_REASON = 160; // bytes; enough for one honest sentence

    IERC20Min public immutable token;
    bool public immutable isHome;
    uint64 public immutable epochStart; // must be identical on every vault of the household
    uint64 public immutable periodLength; // e.g. 30 days; must be identical on every vault

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    mapping(address => Member) public members;
    uint8 public adultCount;

    mapping(uint8 => HobTypes.Rule) public rules;
    mapping(uint8 => uint64) public ruleVersion;

    mapping(uint8 => CategoryState) public categoryState;
    mapping(uint64 => mapping(uint8 => uint128)) public localSpent; // period => category => amount

    mapping(HobTypes.Role => RateLimit) public rateLimit;

    PendingSpend[] public pending;
    Proposal[] internal _proposals;
    mapping(uint256 => mapping(address => bool)) public approvedProposal;

    uint64 public memberNonce; // home: increments on every membership change; mirror: last applied

    // ------------------------------------------------------------------
    // Events (the reactive contract subscribes to these)
    // ------------------------------------------------------------------

    /// @dev topic1 = member, topic2 = category, topic3 = period.
    event Spent(
        address indexed member,
        uint8 indexed category,
        uint64 indexed period,
        uint256 amount,
        address to,
        uint256 localSpentInPeriod,
        uint64 timestamp
    );

    /// @dev Emitted on the HOME vault only, when a rule reaches quorum.
    event RulesRatified(
        uint8 indexed category,
        uint64 indexed version,
        uint128 monthlyCap,
        uint128 perTxCap,
        uint128 coSignAbove,
        bool active
    );

    /// @dev Emitted on the HOME vault only. `unfreeze` lifts a reactive freeze on every chain.
    event MemberSet(address indexed member, HobTypes.Role role, bool unfreeze, uint64 nonce);

    // Informational events
    /// @dev The member's own words for a spend, on-chain next to the money it moved.
    ///      `requestId` is the pending id for a co-sign request, `type(uint256).max` otherwise.
    event SpendReason(uint256 indexed requestId, address indexed member, uint8 indexed category, string reason);
    event SpendRequested(uint256 indexed id, address indexed member, uint8 indexed category, uint256 amount, address to);
    event SpendApproved(uint256 indexed id, address indexed approver);
    event SpendCancelled(uint256 indexed id, address indexed by);
    event ProposalCreated(uint256 indexed id, ProposalKind kind, address indexed proposer);
    event ProposalApproved(uint256 indexed id, address indexed adult, uint8 approvals);
    event CategoryModeChanged(uint8 indexed category, uint64 indexed period, HobTypes.Mode mode, uint128 limit);
    event MemberFrozen(address indexed member, uint64 until);
    event RulesApplied(uint8 indexed category, uint64 indexed version, uint128 monthlyCap);
    event MemberSynced(address indexed member, HobTypes.Role role, bool unfreeze, uint64 nonce);
    event Deposited(address indexed from, uint256 amount);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error NotMember();
    error NotAdult();
    error MemberIsFrozen(uint64 until);
    error CategoryInactive(uint8 category);
    error CategoryFrozen(uint8 category);
    error InvalidAmount();
    error AboveTxCap(uint256 amount, uint256 cap);
    error AboveLocalLimit(uint256 wouldBe, uint256 limit);
    error RateLimited(uint32 maxTx, uint32 window);
    error OnlyHome();
    error OnlyMirror();
    error BadProposal();
    error AlreadyApproved();
    error Expired();
    error Closed();
    error SelfApproval();
    error BadCategory();
    error BadRule();
    error LastAdult();
    error ReasonRequired();
    error ReasonTooLong(uint256 length, uint256 max);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /// @param callbackProxy_ Reactive callback proxy on this chain.
    /// @param reactive_ Address of the HobReactive contract on Reactive Network.
    /// @param token_ Stablecoin used by the household (USDC).
    /// @param isHome_ True for the governance vault.
    /// @param epochStart_ Shared period epoch (unix seconds). Same value on every vault.
    /// @param periodLength_ Period length in seconds. Same value on every vault.
    /// @param adults_ Initial adults (HOME only; mirrors get members via callbacks).
    constructor(
        IPayable callbackProxy_,
        address reactive_,
        IERC20Min token_,
        bool isHome_,
        uint64 epochStart_,
        uint64 periodLength_,
        address[] memory adults_
    ) payable AbstractCallback(callbackProxy_, reactive_) {
        require(periodLength_ > 0 && epochStart_ <= block.timestamp, "period");
        token = token_;
        isHome = isHome_;
        epochStart = epochStart_;
        periodLength = periodLength_;

        // Default rate limits (local, per chain). Agents are deliberately tighter.
        rateLimit[HobTypes.Role.ADULT] = RateLimit({maxTx: 20, window: 1 hours});
        rateLimit[HobTypes.Role.AGENT] = RateLimit({maxTx: 5, window: 1 hours});

        if (isHome_) {
            for (uint256 i; i < adults_.length; ++i) {
                _setMember(adults_[i], HobTypes.Role.ADULT, false);
            }
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function currentPeriod() public view returns (uint64) {
        return uint64((block.timestamp - epochStart) / periodLength);
    }

    function quorum() public view returns (uint8) {
        return adultCount >= 2 ? 2 : 1;
    }

    /// @notice Effective mode + local ceiling for a category in the current period.
    function categoryStatus(uint8 category) public view returns (HobTypes.Mode mode, uint128 limit, uint128 spent) {
        uint64 p = currentPeriod();
        CategoryState memory st = categoryState[category];
        spent = localSpent[p][category];
        if (st.period == p && st.mode != HobTypes.Mode.NORMAL) {
            return (st.mode, st.limit, spent);
        }
        return (HobTypes.Mode.NORMAL, rules[category].monthlyCap, spent);
    }

    function proposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    function pendingCount() external view returns (uint256) {
        return pending.length;
    }

    // ------------------------------------------------------------------
    // Funding
    // ------------------------------------------------------------------

    /// @notice Anyone can fund the household. Requires prior ERC20 approval.
    function deposit(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Spending
    // ------------------------------------------------------------------

    /// @notice Spend from the household vault. Returns `type(uint256).max` when the spend
    ///         executed immediately, or the pending id when it needs an adult co-sign.
    /// @param reason Why, in the member's own words. An agent must always give one; it is
    ///        emitted as `SpendReason` so anyone can audit what the agent said it was doing.
    function spend(uint8 category, address to, uint128 amount, string calldata reason) external returns (uint256) {
        Member storage m = members[msg.sender];
        if (m.role == HobTypes.Role.NONE) revert NotMember();
        if (block.timestamp < m.frozenUntil) revert MemberIsFrozen(m.frozenUntil);
        if (amount == 0 || to == address(0)) revert InvalidAmount();
        uint256 len = bytes(reason).length;
        if (len > MAX_REASON) revert ReasonTooLong(len, MAX_REASON);
        if (len == 0 && m.role == HobTypes.Role.AGENT) revert ReasonRequired();

        HobTypes.Rule memory r = rules[category];
        if (!r.active) revert CategoryInactive(category);
        if (amount > r.perTxCap) revert AboveTxCap(amount, r.perTxCap);

        _consumeRateLimit(m);

        (HobTypes.Mode mode,,) = categoryStatus(category);
        if (mode == HobTypes.Mode.FROZEN) revert CategoryFrozen(category);

        bool needsCoSign = amount > r.coSignAbove || (mode == HobTypes.Mode.TIGHT && m.role == HobTypes.Role.AGENT);
        if (needsCoSign) {
            uint256 id = pending.length;
            pending.push(
                PendingSpend({
                    member: msg.sender,
                    to: to,
                    amount: amount,
                    expiresAt: uint64(block.timestamp) + PENDING_TTL,
                    category: category,
                    closed: false
                })
            );
            if (len != 0) emit SpendReason(id, msg.sender, category, reason);
            emit SpendRequested(id, msg.sender, category, amount, to);
            return id;
        }

        if (len != 0) emit SpendReason(type(uint256).max, msg.sender, category, reason);
        _execute(msg.sender, category, to, amount);
        return type(uint256).max;
    }

    /// @notice An adult (not the requester) co-signs a pending spend. All checks run again.
    function approveSpend(uint256 id) external {
        _requireActiveAdult();
        PendingSpend storage ps = pending[id];
        if (ps.closed) revert Closed();
        if (block.timestamp > ps.expiresAt) revert Expired();
        if (ps.member == msg.sender) revert SelfApproval();

        // the requester may have been frozen in the meantime
        Member storage m = members[ps.member];
        if (m.role == HobTypes.Role.NONE) revert NotMember();
        if (block.timestamp < m.frozenUntil) revert MemberIsFrozen(m.frozenUntil);

        HobTypes.Rule memory r = rules[ps.category];
        if (!r.active) revert CategoryInactive(ps.category);
        if (ps.amount > r.perTxCap) revert AboveTxCap(ps.amount, r.perTxCap);
        (HobTypes.Mode mode,,) = categoryStatus(ps.category);
        if (mode == HobTypes.Mode.FROZEN) revert CategoryFrozen(ps.category);

        ps.closed = true;
        emit SpendApproved(id, msg.sender);
        _execute(ps.member, ps.category, ps.to, ps.amount);
    }

    /// @notice Requester or any adult can cancel a pending spend.
    function cancelSpend(uint256 id) external {
        PendingSpend storage ps = pending[id];
        if (ps.closed) revert Closed();
        if (msg.sender != ps.member) _requireActiveAdult();
        ps.closed = true;
        emit SpendCancelled(id, msg.sender);
    }

    function _execute(address member, uint8 category, address to, uint128 amount) internal {
        uint64 p = currentPeriod();
        (, uint128 limit, uint128 spent) = categoryStatus(category);
        uint256 wouldBe = uint256(spent) + amount;
        if (wouldBe > limit) revert AboveLocalLimit(wouldBe, limit);

        localSpent[p][category] = uint128(wouldBe);
        if (!token.transfer(to, amount)) revert TransferFailed();

        emit Spent(member, category, p, amount, to, wouldBe, uint64(block.timestamp));
    }

    function _consumeRateLimit(Member storage m) internal {
        RateLimit memory rl = rateLimit[m.role];
        if (block.timestamp >= uint256(m.windowStart) + rl.window) {
            m.windowStart = uint64(block.timestamp);
            m.windowCount = 0;
        }
        if (m.windowCount >= rl.maxTx) revert RateLimited(rl.maxTx, rl.window);
        unchecked {
            ++m.windowCount;
        }
    }

    // ------------------------------------------------------------------
    // Governance (HOME only)
    // ------------------------------------------------------------------

    /// @notice Propose a spending rule. Adults AND agents may propose (an AI agent can
    ///         suggest the rule it observed), but only adults can ratify.
    function proposeRule(uint8 category, HobTypes.Rule calldata rule) external returns (uint256 id) {
        if (!isHome) revert OnlyHome();
        Member storage m = members[msg.sender];
        HobTypes.Role role = m.role;
        if (role == HobTypes.Role.NONE) revert NotMember();
        // a frozen member (adult or agent) cannot propose, and a frozen adult's vote never counts
        uint64 frozenUntil = m.frozenUntil;
        if (block.timestamp < frozenUntil) revert MemberIsFrozen(frozenUntil);
        if (category >= MAX_CATEGORIES) revert BadCategory();
        if (rule.active && (rule.perTxCap == 0 || rule.perTxCap > rule.monthlyCap || rule.coSignAbove > rule.perTxCap)) {
            revert BadRule();
        }

        id = _proposals.length;
        Proposal storage p = _proposals.push();
        p.kind = ProposalKind.RULE;
        p.proposer = msg.sender;
        p.expiresAt = uint64(block.timestamp) + PROPOSAL_TTL;
        p.category = category;
        p.rule = rule;
        emit ProposalCreated(id, ProposalKind.RULE, msg.sender);

        if (role == HobTypes.Role.ADULT) _approve(id);
    }

    /// @notice Propose adding / changing / removing (Role.NONE) a member. Adults only.
    function proposeMember(address member, HobTypes.Role role) external returns (uint256 id) {
        if (!isHome) revert OnlyHome();
        _requireActiveAdult();
        if (member == address(0)) revert BadProposal();

        id = _proposals.length;
        Proposal storage p = _proposals.push();
        p.kind = ProposalKind.MEMBER;
        p.proposer = msg.sender;
        p.expiresAt = uint64(block.timestamp) + PROPOSAL_TTL;
        p.member = member;
        p.role = role;
        emit ProposalCreated(id, ProposalKind.MEMBER, msg.sender);

        _approve(id);
    }

    function approveProposal(uint256 id) external {
        if (!isHome) revert OnlyHome();
        _requireActiveAdult();
        _approve(id);
    }

    /// @notice Any adult can lift a reactive freeze. Propagated to every chain.
    function unfreezeMember(address member) external {
        if (!isHome) revert OnlyHome();
        _requireActiveAdult();
        HobTypes.Role role = members[member].role;
        if (role == HobTypes.Role.NONE) revert NotMember();
        _setMember(member, role, true);
    }

    /// @notice Re-announce members and rules so the reactive contract mirrors them.
    ///         Needed once after setup: the constructor runs before the reactive
    ///         contract is subscribed, so those first events are never seen.
    function resync(address[] calldata memberList, uint8[] calldata categories) external {
        if (!isHome) revert OnlyHome();
        _requireActiveAdult();
        for (uint256 i; i < memberList.length; ++i) {
            address who = memberList[i];
            _setMember(who, members[who].role, false);
        }
        for (uint256 i; i < categories.length; ++i) {
            uint8 c = categories[i];
            HobTypes.Rule memory r = rules[c];
            uint64 v = ruleVersion[c] + 1;
            ruleVersion[c] = v;
            emit RulesRatified(c, v, r.monthlyCap, r.perTxCap, r.coSignAbove, r.active);
        }
    }

    function _approve(uint256 id) internal {
        if (id >= _proposals.length) revert BadProposal();
        Proposal storage p = _proposals[id];
        if (p.executed) revert Closed();
        if (block.timestamp > p.expiresAt) revert Expired();
        if (approvedProposal[id][msg.sender]) revert AlreadyApproved();

        approvedProposal[id][msg.sender] = true;
        p.approvals += 1;
        emit ProposalApproved(id, msg.sender, p.approvals);

        if (p.approvals >= quorum()) {
            p.executed = true;
            if (p.kind == ProposalKind.RULE) {
                _applyRule(p.category, p.rule, ruleVersion[p.category] + 1);
                HobTypes.Rule memory r = p.rule;
                emit RulesRatified(p.category, ruleVersion[p.category], r.monthlyCap, r.perTxCap, r.coSignAbove, r.active);
            } else {
                _setMember(p.member, p.role, false);
            }
        }
    }

    function _setMember(address member, HobTypes.Role role, bool unfreeze) internal {
        Member storage m = members[member];
        // The household always keeps at least one adult; otherwise nobody could ever decide again.
        // Checked on HOME only (mirrors just follow, and a reverted callback is still billed).
        if (isHome && m.role == HobTypes.Role.ADULT && role != HobTypes.Role.ADULT && adultCount == 1) {
            revert LastAdult();
        }
        if (m.role == HobTypes.Role.ADULT && role != HobTypes.Role.ADULT) adultCount -= 1;
        if (m.role != HobTypes.Role.ADULT && role == HobTypes.Role.ADULT) adultCount += 1;
        m.role = role;
        if (unfreeze || role == HobTypes.Role.NONE) m.frozenUntil = 0;

        if (isHome) {
            memberNonce += 1;
            emit MemberSet(member, role, unfreeze, memberNonce);
        }
    }

    function _applyRule(uint8 category, HobTypes.Rule memory rule, uint64 version) internal {
        rules[category] = rule;
        ruleVersion[category] = version;
    }

    function _requireActiveAdult() internal view {
        Member storage m = members[msg.sender];
        if (m.role != HobTypes.Role.ADULT) revert NotAdult();
        if (block.timestamp < m.frozenUntil) revert MemberIsFrozen(m.frozenUntil);
    }

    // ------------------------------------------------------------------
    // Reactive callbacks
    //   First argument is overwritten by Reactive Network with the address of the
    //   reactive contract that requested the callback; `onlyCallbackSender` checks it.
    //   Stale / duplicate callbacks are ignored (never revert: failed callbacks are still billed).
    // ------------------------------------------------------------------

    /// @notice Mirror the rules ratified on the HOME vault.
    function cbApplyRules(
        address rvm,
        uint8 category,
        uint64 version,
        uint128 monthlyCap,
        uint128 perTxCap,
        uint128 coSignAbove,
        bool active
    ) external onlyServiceProvider onlyCallbackSender(rvm) {
        if (isHome) return; // home is the source of truth
        if (version <= ruleVersion[category]) return; // out of order / duplicate
        _applyRule(category, HobTypes.Rule(monthlyCap, perTxCap, coSignAbove, active), version);
        emit RulesApplied(category, version, monthlyCap);
    }

    /// @notice Mirror a membership change made on the HOME vault.
    function cbSetMember(address rvm, address member, HobTypes.Role role, bool unfreeze, uint64 nonce)
        external
        onlyServiceProvider
        onlyCallbackSender(rvm)
    {
        if (isHome) return;
        if (nonce <= memberNonce) return;
        memberNonce = nonce;
        _setMember(member, role, unfreeze);
        emit MemberSynced(member, role, unfreeze, nonce);
    }

    /// @notice Household-wide budget state for a category, computed across all chains.
    /// @param allowance For TIGHT: this chain's slice of the remaining global budget.
    function cbCategoryMode(address rvm, uint8 category, uint64 period, HobTypes.Mode mode, uint128 allowance)
        external
        onlyServiceProvider
        onlyCallbackSender(rvm)
    {
        if (period != currentPeriod()) return; // stale: the period already rolled over
        CategoryState storage st = categoryState[category];
        HobTypes.Mode current = st.period == period ? st.mode : HobTypes.Mode.NORMAL;
        if (uint8(mode) <= uint8(current)) return; // modes only escalate within a period

        uint128 spent = localSpent[period][category];
        uint128 limit;
        if (mode == HobTypes.Mode.TIGHT) {
            uint256 l = uint256(spent) + allowance;
            uint128 cap = rules[category].monthlyCap;
            limit = l > cap ? cap : uint128(l);
        } else {
            limit = spent;
        }
        st.period = period;
        st.mode = mode;
        st.limit = limit;
        emit CategoryModeChanged(category, period, mode, limit);
    }

    /// @notice Cross-chain velocity breaker: freeze a member on this chain.
    function cbFreezeMember(address rvm, address member, uint64 until)
        external
        onlyServiceProvider
        onlyCallbackSender(rvm)
    {
        Member storage m = members[member];
        if (m.role == HobTypes.Role.NONE) return;
        if (until <= m.frozenUntil) return;
        m.frozenUntil = until;
        emit MemberFrozen(member, until);
    }
}
