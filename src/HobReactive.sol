// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "reactive-lib/base/AbstractReactive.sol";
import {ISystemContract} from "reactive-lib/interfaces/ISystemContract.sol";
import {HobTypes} from "./HobTypes.sol";
import {HobVault} from "./HobVault.sol";

/// @title HobReactive
/// @notice Lives on Reactive Network. Holds the household's cross-chain memory:
///         ratified caps, the global spend ledger per period/category, and per-member
///         spend velocity. It reacts to vault events and calls back to every vault
///         when a household-wide limit is crossed. No keeper, no off-chain bot, no AI
///         needs to be online.
contract HobReactive is AbstractReactive {
    // ------------------------------------------------------------------
    // Event signatures we subscribe to (from HobVault)
    // ------------------------------------------------------------------

    uint256 public constant SPENT_TOPIC = uint256(keccak256("Spent(address,uint8,uint64,uint256,address,uint256,uint64)"));
    uint256 public constant RULES_TOPIC = uint256(keccak256("RulesRatified(uint8,uint64,uint128,uint128,uint128,bool)"));
    uint256 public constant MEMBER_TOPIC = uint256(keccak256("MemberSet(address,uint8,bool,uint64)"));

    uint64 public constant CALLBACK_GAS = 250_000; // network minimum is 100k
    uint8 public constant MAX_VAULTS = 4; // bounds callbacks per reaction (react gas cap 900k)
    uint16 public constant BPS = 10_000;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    struct VaultRef {
        uint256 chainId;
        address vault;
    }

    struct Ledger {
        uint128 spent; // household-wide, all chains
        HobTypes.Mode mode; // last mode broadcast for this period/category
    }

    struct Velocity {
        uint64 windowStart;
        uint32 count;
        uint128 amount;
        uint64 frozenUntil;
    }

    struct VelocityConfig {
        uint128 maxAmount; // max spend per member per window, all chains summed
        uint32 maxTx; // max spends per member per window, all chains summed
        uint32 window; // seconds
        uint32 freezeFor; // seconds a member stays frozen after a breach
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    address public immutable owner;
    uint16 public tightenBps; // e.g. 8000 = tighten at 80% of the household cap
    /// @notice Once sealed, the deployer can no longer register vaults or change limits.
    ///         Nobody, including the deployer, can change the household's setup alone.
    bool public isSealed;

    VaultRef[] public vaults;
    mapping(bytes32 => bool) public isVault;
    uint256 public homeChainId;
    address public homeVault;

    mapping(uint8 => uint128) public capOf; // category => household-wide cap
    mapping(uint8 => uint128) public perTxOf; // category => largest single spend allowed
    mapping(uint8 => uint64) public capVersion;
    mapping(uint64 => mapping(uint8 => Ledger)) public ledger; // period => category => ledger
    mapping(uint64 => mapping(uint8 => mapping(uint256 => uint128))) public spentByChain;

    /// @dev Velocity limits per role. Members the contract has not seen yet are treated
    ///      as AGENT (strictest) until the home vault announces their role.
    mapping(HobTypes.Role => VelocityConfig) public velocityFor;
    mapping(address => HobTypes.Role) public roleOf;
    mapping(address => Velocity) public velocityOf;

    mapping(bytes32 => bool) public seenLog; // idempotency on (chainId, txHash, logIndex)

    // ------------------------------------------------------------------
    // Events (visible on Reactscan; the dashboard reads these)
    // ------------------------------------------------------------------

    event VaultRegistered(uint256 indexed chainId, address indexed vault, bool home);
    event Sealed(uint256 vaults);
    event LedgerUpdated(
        uint64 indexed period, uint8 indexed category, uint256 indexed chainId, address member, uint256 amount, uint256 householdSpent, uint256 cap
    );
    event CategoryEscalated(uint64 indexed period, uint8 indexed category, HobTypes.Mode mode, uint256 householdSpent, uint256 cap);
    event VelocityBreach(address indexed member, uint256 amountInWindow, uint32 txInWindow, uint64 frozenUntil);
    event RulesMirrored(uint8 indexed category, uint64 version, uint128 cap);
    event MemberMirrored(address indexed member, HobTypes.Role role, bool unfreeze);
    event VelocityConfigured(HobTypes.Role indexed role, uint128 maxAmount, uint32 maxTx, uint32 window, uint32 freezeFor);

    error OnlyOwner();
    error TooManyVaults();
    error AlreadyRegistered();
    error HomeAlreadySet();
    error BadConfig();
    error IsSealed();
    error NoHomeVault();

    constructor(uint16 tightenBps_, VelocityConfig memory adultVelocity_, VelocityConfig memory agentVelocity_)
        payable
    {
        owner = msg.sender;
        _setTighten(tightenBps_);
        _setVelocity(HobTypes.Role.ADULT, adultVelocity_);
        _setVelocity(HobTypes.Role.AGENT, agentVelocity_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyOwnerUnsealed() {
        if (msg.sender != owner) revert OnlyOwner();
        if (isSealed) revert IsSealed();
        _;
    }

    // ------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------

    /// @notice Register a vault and subscribe to its events. Exactly one HOME vault.
    function registerVault(uint256 chainId, address vault, bool home) external onlyOwnerUnsealed {
        if (vaults.length >= MAX_VAULTS) revert TooManyVaults();
        bytes32 key = _key(chainId, vault);
        if (isVault[key]) revert AlreadyRegistered();
        if (home && homeVault != address(0)) revert HomeAlreadySet();

        isVault[key] = true;
        vaults.push(VaultRef(chainId, vault));

        SYSTEM.subscribe(chainId, vault, SPENT_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        if (home) {
            homeChainId = chainId;
            homeVault = vault;
            SYSTEM.subscribe(chainId, vault, RULES_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
            SYSTEM.subscribe(chainId, vault, MEMBER_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
        emit VaultRegistered(chainId, vault, home);
    }

    function setVelocity(HobTypes.Role role, VelocityConfig calldata v) external onlyOwnerUnsealed {
        if (role == HobTypes.Role.NONE) revert BadConfig();
        _setVelocity(role, v);
    }

    function setTighten(uint16 bps) external onlyOwnerUnsealed {
        _setTighten(bps);
    }

    /// @notice One-way: freeze the vault set and the limits. Called by the deploy script
    ///         right after registering the vaults.
    function seal() external onlyOwnerUnsealed {
        if (homeVault == address(0)) revert NoHomeVault();
        isSealed = true;
        emit Sealed(vaults.length);
    }

    /// @notice Household spend at which a category goes TIGHT: the EARLIER of
    ///         `tightenBps` of the cap and `cap - perTxCap`. The second term guarantees
    ///         that, while NORMAL, no single spend on any chain can push the household
    ///         past the cap (each chain only sees its own spending locally).
    function tightenThreshold(uint8 category) public view returns (uint256) {
        uint256 cap = capOf[category];
        uint256 byPct = cap * tightenBps / BPS;
        uint256 perTx = perTxOf[category];
        uint256 byTx = perTx >= cap ? 0 : cap - perTx;
        return byPct < byTx ? byPct : byTx;
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    // ------------------------------------------------------------------
    // React
    // ------------------------------------------------------------------

    function react(LogRecord calldata log) external onlySystem {
        // Never revert on unexpected input: reverted reactions are still billed.
        if (!isVault[_key(log.chainId, log.contractAddress)]) return;

        bytes32 id = keccak256(abi.encode(log.chainId, log.txHash, log.logIndex));
        if (seenLog[id]) return;
        seenLog[id] = true;

        if (log.topic0 == SPENT_TOPIC) {
            _onSpent(log);
        } else if (log.topic0 == RULES_TOPIC && _isHome(log)) {
            _onRules(log);
        } else if (log.topic0 == MEMBER_TOPIC && _isHome(log)) {
            _onMember(log);
        }
    }

    function _onSpent(LogRecord calldata log) internal {
        address member = address(uint160(log.topic1));
        uint8 category = uint8(log.topic2);
        uint64 period = uint64(log.topic3);
        (uint256 amount,,, uint64 ts) = abi.decode(log.data, (uint256, address, uint256, uint64));

        // ---- household-wide ledger
        Ledger storage l = ledger[period][category];
        uint256 total = uint256(l.spent) + amount;
        l.spent = uint128(total);
        spentByChain[period][category][log.chainId] += uint128(amount);

        uint128 cap = capOf[category];
        emit LedgerUpdated(period, category, log.chainId, member, amount, total, cap);

        if (cap > 0) {
            if (total >= cap && l.mode != HobTypes.Mode.FROZEN) {
                l.mode = HobTypes.Mode.FROZEN;
                emit CategoryEscalated(period, category, HobTypes.Mode.FROZEN, total, cap);
                _broadcastMode(category, period, HobTypes.Mode.FROZEN, 0);
            } else if (total >= tightenThreshold(category) && l.mode == HobTypes.Mode.NORMAL) {
                l.mode = HobTypes.Mode.TIGHT;
                // Split what is left evenly: no chain can spend the other chains' share.
                uint128 slice = uint128((cap - total) / vaults.length);
                emit CategoryEscalated(period, category, HobTypes.Mode.TIGHT, total, cap);
                _broadcastMode(category, period, HobTypes.Mode.TIGHT, slice);
            }
        }

        // ---- cross-chain velocity breaker (per member)
        _checkVelocity(member, amount, ts);
    }

    function _checkVelocity(address member, uint256 amount, uint64 ts) internal {
        HobTypes.Role role = roleOf[member];
        if (role == HobTypes.Role.NONE) role = HobTypes.Role.AGENT; // unknown => strictest
        VelocityConfig memory cfg = velocityFor[role];
        if (cfg.window == 0) return;

        Velocity storage v = velocityOf[member];
        if (ts >= uint256(v.windowStart) + cfg.window) {
            v.windowStart = ts;
            v.count = 0;
            v.amount = 0;
        }
        v.count += 1;
        v.amount += uint128(amount);

        bool breach = (cfg.maxAmount > 0 && v.amount > cfg.maxAmount) || (cfg.maxTx > 0 && v.count > cfg.maxTx);
        if (breach && ts >= v.frozenUntil) {
            uint64 until = ts + cfg.freezeFor;
            v.frozenUntil = until;
            emit VelocityBreach(member, v.amount, v.count, until);
            bytes memory payload = abi.encodeCall(HobVault.cbFreezeMember, (address(0), member, until));
            _broadcast(payload, false);
        }
    }

    function _onRules(LogRecord calldata log) internal {
        uint8 category = uint8(log.topic1);
        uint64 version = uint64(log.topic2);
        (uint128 cap, uint128 perTx, uint128 coSign, bool active) = abi.decode(log.data, (uint128, uint128, uint128, bool));
        if (version <= capVersion[category]) return;

        capVersion[category] = version;
        capOf[category] = active ? cap : 0;
        perTxOf[category] = perTx;
        emit RulesMirrored(category, version, cap);

        bytes memory payload =
            abi.encodeCall(HobVault.cbApplyRules, (address(0), category, version, cap, perTx, coSign, active));
        _broadcast(payload, true);
    }

    function _onMember(LogRecord calldata log) internal {
        address member = address(uint160(log.topic1));
        (HobTypes.Role role, bool unfreeze, uint64 nonce) = abi.decode(log.data, (HobTypes.Role, bool, uint64));
        roleOf[member] = role;
        if (unfreeze || role == HobTypes.Role.NONE) {
            Velocity storage v = velocityOf[member];
            v.frozenUntil = 0;
            v.count = 0;
            v.amount = 0;
        }
        emit MemberMirrored(member, role, unfreeze);

        bytes memory payload = abi.encodeCall(HobVault.cbSetMember, (address(0), member, role, unfreeze, nonce));
        _broadcast(payload, true);
    }

    // ------------------------------------------------------------------
    // Callbacks
    // ------------------------------------------------------------------

    function _broadcastMode(uint8 category, uint64 period, HobTypes.Mode mode, uint128 allowance) internal {
        bytes memory payload = abi.encodeCall(HobVault.cbCategoryMode, (address(0), category, period, mode, allowance));
        _broadcast(payload, false);
    }

    /// @param mirrorsOnly Skip the home vault (it is already the source of that change).
    function _broadcast(bytes memory payload, bool mirrorsOnly) internal {
        uint256 n = vaults.length;
        for (uint256 i; i < n; ++i) {
            VaultRef memory v = vaults[i];
            if (mirrorsOnly && v.vault == homeVault && v.chainId == homeChainId) continue;
            SYSTEM.requestCallbackV_1_0(
                ISystemContract.CallbackConfiguration_V_1_0({
                    chainId: v.chainId, recipient: v.vault, gasLimit: CALLBACK_GAS, payload: payload
                })
            );
        }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _isHome(LogRecord calldata log) internal view returns (bool) {
        return log.chainId == homeChainId && log.contractAddress == homeVault;
    }

    function _key(uint256 chainId, address vault) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, vault));
    }

    function _setTighten(uint16 bps) internal {
        if (bps == 0 || bps >= BPS) revert BadConfig();
        tightenBps = bps;
    }

    function _setVelocity(HobTypes.Role role, VelocityConfig memory v) internal {
        if (v.window > 0 && v.freezeFor == 0) revert BadConfig();
        velocityFor[role] = v;
        emit VelocityConfigured(role, v.maxAmount, v.maxTx, v.window, v.freezeFor);
    }
}
