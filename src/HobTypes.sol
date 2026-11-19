// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Types shared by HobVault and HobReactive.
library HobTypes {
    enum Role {
        NONE,
        ADULT, // can spend, co-sign, propose and ratify
        AGENT  // can spend (tighter limits) and propose rules, never ratify or co-sign
    }

    /// @dev Escalates only within a period: NORMAL -> TIGHT -> FROZEN. Resets next period.
    enum Mode {
        NORMAL,
        TIGHT, // >= tighten threshold of the household-wide cap: agents need co-sign, each chain gets a slice
        FROZEN // household-wide cap reached on the sum of all chains
    }

    struct Rule {
        uint128 monthlyCap; // household-wide, summed across every chain
        uint128 perTxCap;
        uint128 coSignAbove; // spends above this need a second adult
        bool active;
    }
}
