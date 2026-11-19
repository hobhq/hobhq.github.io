#!/usr/bin/env bash
# Plants one bug at a time and checks that the test suite catches it.
# Every mutant must FAIL the suite; the real contracts must PASS.
set -u
cd "$(dirname "$0")/.."
backup=$(mktemp -d)
cp src/*.sol "$backup/"
restore() { cp "$backup"/*.sol src/; }
trap restore EXIT

mutants=(
  "src/HobReactive.sol|return byPct < byTx ? byPct : byTx;|return byPct;|tighten only at 80% (ignores per-tx cap)"
  "src/HobReactive.sol|uint128 slice = uint128((cap - total) / vaults.length);|uint128 slice = uint128(cap - total);|every chain gets the whole remaining budget"
  "src/HobReactive.sol|if (seenLog[id]) return;|// dedupe removed|duplicate logs counted twice"
  "src/HobReactive.sol|if (role == HobTypes.Role.NONE) role = HobTypes.Role.AGENT;|if (role == HobTypes.Role.NONE) role = HobTypes.Role.ADULT;|unknown members get loose limits"
  "src/HobVault.sol|if (uint8(mode) <= uint8(current)) return;|if (mode == current) return;|modes can downgrade within a period"
  "src/HobVault.sol|if (period != currentPeriod()) return;|// stale-period check removed|stale callbacks applied to a new period"
  "src/HobVault.sol|if (ps.member == msg.sender) revert SelfApproval();|// self-approval allowed|requester co-signs own spend"
  "src/HobVault.sol|if (wouldBe > limit) revert AboveLocalLimit(wouldBe, limit);|// local limit removed|local slice not enforced"
  "src/HobVault.sol|if (block.timestamp < frozenUntil) revert MemberIsFrozen(frozenUntil);|// frozen check removed|frozen members can propose (and a frozen adult votes)"
  "src/HobVault.sol|if (approvedProposal[id][msg.sender]) revert AlreadyApproved();|// double-vote check removed|one adult votes twice and ratifies alone"
  "src/HobVault.sol|if (!r.active) revert CategoryInactive(category);|// active check removed|spending without a ratified rule"
  "src/HobVault.sol|if (ps.closed) revert Closed();|// closed check removed|cancelled request can still be co-signed"
  "src/HobVault.sol|if (block.timestamp > p.expiresAt) revert Expired();|// expiry removed|stale proposals can be ratified"
  "src/HobVault.sol|if (m.role != HobTypes.Role.ADULT) revert NotAdult();|// adult check removed|the agent gets adult powers"
  "src/HobVault.sol|if (mode == HobTypes.Mode.FROZEN) revert CategoryFrozen(ps.category);|// re-check removed|old co-sign request executes after the cap"
  "src/HobReactive.sol|if (isSealed) revert IsSealed();|// seal ignored|deployer keeps admin powers after seal"
  "src/HobVault.sol|            revert LastAdult();|            {}|last adult can be removed"
)

echo "baseline:"; forge test >/dev/null 2>&1 && echo "  PASS (real contracts)" || { echo "  baseline FAILS — fix before mutating"; exit 1; }
killed=0
for m in "${mutants[@]}"; do
  IFS='|' read -r file from to label <<<"$m"
  restore
  if ! FILE="$file" FROM="$from" TO="$to" python3 -c '
import os,sys
f,a,b=os.environ["FILE"],os.environ["FROM"],os.environ["TO"]
s=open(f).read()
if a not in s: sys.exit(1)
open(f,"w").write(s.replace(a,b,1))'; then echo "  ?? pattern not found: $label"; continue; fi
  if forge test >/dev/null 2>&1; then echo "  SURVIVED  $label"; else echo "  killed    $label"; killed=$((killed+1)); fi
done
echo "killed $killed / ${#mutants[@]}"
