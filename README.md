# Hob

**A household agreement that no one changes alone, enforced on every chain by Reactive Network.**

Reactive Omni Buildathon · track **Set It and Forget It** · Base Sepolia + Unichain Sepolia + Reactive Lasna

**Live dashboard (testnet, read-only): https://hobhq.github.io/**

**Who's who.** **Hob** is the household's guardian: the reactive contract on Reactive Network that watches Base and Unichain and enforces the agreement by itself. **Alice** and **Bob** are the adults who agree on the rules. **Pip** is the AI shopper: it buys and can propose, but it never ratifies, co-signs or unfreezes.

---

## Why Hob

Most cross-chain spending limits give **one owner** control over their wallets or agents.
A household doesn't work that way. Two adults share the money, an AI agent does the
shopping, and the rules are something they *agree on*, not something one person sets.

Hob turns that agreement into contracts:

- **The agent proposes, adults ratify.** A rule only exists once a quorum of adults approves it. The AI shopping agent can suggest a rule but can never ratify it or co-sign.
- **No one changes it alone.** Rules, members and unfreezes are household decisions on the home chain, mirrored to every other chain by Reactive. There is no local admin on the mirrors.
- **A response that escalates.** NORMAL → TIGHT (the remaining budget is split per chain and the agent needs a co-sign) → FROZEN (cap reached on the sum of all chains).
- **Per-role velocity across chains.** 3 buys on Base plus 4 on Unichain each look fine locally. Hob sees 7 in an hour from an agent and freezes it on both chains. Adults get looser limits.
- **Set it and forget it.** No keeper, no bot, no cron. The month resets by itself because the period id travels inside every spend event.

## How it works

```
        Base (home)                      Reactive Network                     Unichain (mirror)
 ┌─────────────────────┐            ┌──────────────────────────┐         ┌─────────────────────┐
 │ HobVault         │  Spent     │ HobReactive           │  Spent  │ HobVault         │
 │  propose / ratify   │ ─────────► │  household ledger        │ ◄────── │  spend / co-sign    │
 │  spend / co-sign    │  Rules     │   (period × category)    │         │  rules: mirrored    │
 │                     │  Members   │  role + velocity / member│         │                     │
 │                     │ ─────────► │                          │         │                     │
 │ cbCategoryMode  ◄───┼────────────┤  callbacks to EVERY chain├─────────┼──► cbCategoryMode   │
 │ cbFreezeMember  ◄───┤            │                          │         ├──► cbFreezeMember   │
 │                     │            │                          │         ├──► cbApplyRules     │
 │                     │            │                          │         ├──► cbSetMember      │
 └─────────────────────┘            └──────────────────────────┘         └─────────────────────┘
```

| Layer | Where | Enforces |
|---|---|---|
| Local, synchronous | each `HobVault` | per-purchase cap · second adult above a threshold · per-role rate limit (adult 20/h, agent 5/h) · this chain's slice |
| Household, reactive | `HobReactive` | cap summed across chains · per-role velocity across chains · rule and member mirroring |

| Origin event | Reaction | Callback on every chain |
|---|---|---|
| `Spent` takes the household past the tighten line | ledger → TIGHT | `cbCategoryMode(TIGHT, slice)`: remaining budget split per chain, agent needs a co-sign |
| `Spent` reaches the cap | → FROZEN | `cbCategoryMode(FROZEN)` |
| `Spent` breaches a member's velocity for their role | freeze | `cbFreezeMember(until)` |
| `RulesRatified` (quorum) on home | cap stored | `cbApplyRules` to the mirrors |
| `MemberSet` on home (add / remove / unfreeze) | role stored | `cbSetMember` to the mirrors |

**Tighten line:** whichever comes **first**, 80% of the cap or `cap − maxPerPurchase`.
Each chain only sees its own spending, so while a category is NORMAL, this line ensures no
single purchase anywhere can push the household past the cap. For rent (one payment can
be the whole cap), that makes the category tight from the first payment.

## Guarantees, tested

| Property | How it is checked |
|---|---|
| When Reactive answers before the next action, the household **never** exceeds a cap | invariant fuzz `HobInvariantSync` (256 runs × 60 calls) |
| Under latency, overshoot ≤ what was already in flight; once delivered, every chain is FROZEN and the ledger equals the sum of the chains | invariant fuzz `HobInvariantLatency` (random delayed batches) |
| No admin after setup: `seal()` locks the vault set and limits; the household always keeps an adult | unit tests + on-chain check (the deployer's `registerVault` reverts with `IsSealed`) |
| Every check matters | `script/mutants.sh`: 17 planted bugs, **17 killed** |
| Stale, duplicate and out-of-order messages are ignored, never reverted (failed callbacks are still billed) | unit tests |
| Worst-case `react()` fits Reactive's 900k gas cap | heaviest seen ~493k (ledger + velocity freeze + 2 callbacks) on a real transaction |

```bash
forge test                              # 57 tests: 50 unit + 7 invariants
forge test --mt test_demo_story -vv     # narrated walkthrough
./script/mutants.sh                     # mutation testing
```

## Run the whole system locally (no keys, no faucets)

Three anvil chains plus `ops/relayer.mjs`, which does what Reactive Network does: it delivers
subscribed logs to `react()` as the system contract and posts each callback through the
chain's proxy with the reactive contract's address injected.

```bash
cd ops && npm install && cd ..
./ops/local.sh start                    # 3 chains + deploy + relayer
node ops/seed.mjs local                 # rules, agent, a normal week of shopping
cd web && python3 -m http.server 5173   # dashboard → http://127.0.0.1:5173 (Guided demo: 8 chapters, every click a real tx)
node ops/burst.mjs local                # the agent goes rogue across chains
node ops/prove.mjs local                # full story, writes docs/EVIDENCE.local.md
./ops/local.sh stop
```

## The dashboard

Static HTML + CSS + JS with viem (no framework, no build step). On `127.0.0.1` it drives the local chains; anywhere else (GitHub Pages) it reads the live testnet deployment. `?net=local|testnet` overrides.

- **Dashboard**: Hob's latest action in plain words, the three chains live (Base · Hob on Reactive · Unichain), the household ledger summed across chains with its spend curve and Hob's interventions, the people (Alice, Bob, Pip), Hob's last steps and an interactive console with a live trace.
- **The House**: the agreement, the budget per chain, members, pending decisions and every **Reactive loop**: the origin tx linked to its Reactive tx and callback txs, with latency.
- **The Story**: 8 chapters (agree on rules → welcome Pip → shop on two chains → Pip goes rogue → only adults unfreeze → tighten line → cap → new month). One button each; checks tick off from on-chain state.
- **For Judges**: why this needs Reactive, where the evidence is, contracts, features used and guarantees.

## Testnet

```bash
cp .env.example .env    # three throwaway testnet keys (alice, bob, agent)
node ops/deploy.mjs testnet
node ops/prove.mjs testnet              # every loop with tx hashes → docs/EVIDENCE.md
node ops/prove.mjs testnet --story      # same run, narrated chapter by chapter (used for the video)
# dashboard: http://127.0.0.1:5173/?net=testnet  ·  published: https://hobhq.github.io/
```

Evidence of the live run: **[docs/EVIDENCE.md](docs/EVIDENCE.md)**.

## Honest limits

- **Overshoot window.** Between a purchase and the reaction landing, each chain can still spend within its local limits. The invariant fuzz bounds it by what is in flight; from the tighten line on, per-chain slices make it zero for new purchases.
- **The velocity limits** are fixed at deploy, not voted by the household (v2: governed like rules). Right after registering the vaults the deployer calls `seal()`, and from then on nobody, including the deployer, can add a vault or change a limit.
- **Funds leave only through `spend`** in a ratified category. A "transfer" category is how a household moves money out.
- **Modes escalate within a period and never step back.** A rule change mid-month applies its new numbers, but a category that is already TIGHT/FROZEN stays so until the next period.
- **Testnet and a mock token.** Not audited.

## Repository

```
src/HobVault.sol        per-chain vault: spend, co-sign, proposals + quorum, roles, callbacks
src/HobReactive.sol     reactive contract: household ledger, velocity, mirroring
test/                      unit tests, invariant fuzz, ReactiveSim (local Reactive Network stand-in)
script/                    Foundry deploy scripts, mutants.sh
ops/                       deploy · relayer (local) · seed · burst · prove (evidence)
web/                       dashboard (static, viem)
docs/                      evidence
```

## Background

The ratification model (an agent proposes, people ratify, and the gap between the rule a
household states and the rule it actually lives by) comes from *Unwritten*, an earlier project
that derives household spending agreements from real decisions. **No Unwritten code is included.**
Every contract here was written during this buildathon.

MIT License.
