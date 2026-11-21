# Hob

**AI reasons. Code enforces. Hob reacts.**
A household agreement that no one changes alone, enforced on every chain by Reactive Network, even while everyone is offline.

Reactive Omni Buildathon · track **Set It and Forget It** · Base Sepolia + Unichain Sepolia + Reactive Lasna

**Live dashboard (testnet, read-only): https://hobhq.github.io/**

**Who's who.** **Hob** is the household's guardian: the reactive contract on Reactive Network that watches Base and Unichain and enforces the agreement by itself. **Alice** and **Bob** are the adults who agree on the rules. **Pip** is the AI shopper: it buys and can propose, but it never ratifies, co-signs or unfreezes, and it must say why for every purchase.

---

## Why Hob

**Who enforces an AI agent's rules when nobody is watching?** A prompt can't. An operator's
bot can, until it goes offline, and then what the agent did lives in that operator's private logs.

Hob splits the job in three. **Pip reasons**: the AI decides what to buy and writes why, on-chain.
**Code enforces**: each vault checks the rules the adults ratified, on every purchase. **Hob reacts**:
on Reactive Network it remembers the whole household across chains and tightens, freezes, copies
decisions and starts a new period by itself. Pip can sleep; the rules stay awake.

Most cross-chain spending limits give **one owner** control over their wallets or agents.
A household doesn't work that way. Two adults share the money, an AI agent does the
shopping, and the rules are something they *agree on*, not something one person sets.

Hob turns that agreement into contracts:

- **The agent proposes, adults ratify.** A rule only exists once a quorum of adults approves it. The AI shopping agent can suggest a rule but can never ratify it or co-sign.
- **No one changes it alone.** Rules, members and unfreezes are household decisions on the home chain, mirrored to every other chain by Reactive. There is no local admin on the mirrors.
- **A response that escalates.** NORMAL → TIGHT (the remaining budget is split per chain and the agent needs a co-sign) → FROZEN (cap reached on the sum of all chains).
- **Per-role velocity across chains.** 3 buys on Base plus 4 on Unichain each look fine locally. Hob sees 7 in an hour from an agent and freezes it on both chains. Adults get looser limits.
- **Set it and forget it.** No keeper, no bot, no cron. The month resets by itself because the period id travels inside every spend event.
- **An audit trail for the agent.** Every purchase by Pip carries its reason (`SpendReason`, at most 160 bytes) in the same transaction as the money. A purchase by an agent without one is refused (`ReasonRequired`). Adults may add one. The dashboard shows it as *Pip's receipts*: what Pip said, what the vault allowed, how Hob reacted.

### Seven questions about on-chain reactivity

| Question | Hob's answer | Proof |
|---|---|---|
| Can a contract react without a bot or keeper? | The period resets with no transaction from anyone | rollovers in [EVIDENCE.md](docs/EVIDENCE.md) |
| Observe → remember → evaluate → react? | 3 subscribed events on 2 chains → ledger per period × category → rules → callbacks only when a chain must change | every loop linked in the dashboard (*The House*) |
| One shared view across chains? | Alice on Base + Bob on Unichain = one house budget, split per chain at the tighten line | story, chapters 3 and 6 |
| Stateful, not stateless? | Pip's pace counted across chains and time: 6 buys pass, the 7th freezes | scenario *the pace limit is exact* |
| **Who enforces an AI's rules when nobody is watching?** | Adults ratify, vaults enforce locally, Hob enforces what no single chain sees; Pip can never approve, co-sign or unfreeze | refusals recorded as checks |
| Can you audit what the agent did? | Pip's words on-chain next to the money; no reason, no purchase; Hob's reactions on Reactive | scenario *Pip must say why* · *Pip's receipts* |
| What if the agent goes offline? | Nothing stops: Hob keeps tightening, freezing, mirroring and rolling periods | rollovers: no transaction sent by anyone |

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
| Local, synchronous | each `HobVault` | per-purchase cap · second adult above a threshold · per-role rate limit (adult 20/h, agent 5/h) · this chain's slice · an agent must give a reason |
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
| Every check matters | `script/mutants.sh`: 18 planted bugs, **18 killed** |
| Stale, duplicate and out-of-order messages are ignored, never reverted (failed callbacks are still billed) | unit tests |
| Worst-case `react()` fits Reactive's 900k gas cap | heaviest seen ~493k (ledger + velocity freeze + 2 callbacks) on a real transaction |

```bash
forge test                              # 62 tests: 55 unit + 7 invariants
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

- **Dashboard**: *AI reasons · code enforces · Hob reacts*, Hob's latest action in plain words, the three chains live (Base · Hob on Reactive · Unichain), the household ledger summed across chains with its spend curve and Hob's interventions, the people (Alice, Bob, Pip), **Pip's receipts** (each purchase with Pip's own words, the vault's decision and Hob's reaction), Hob's last steps and an interactive console with a live trace.
- **The House**: the agreement, the budget per chain, members, pending decisions and every **Reactive loop**: the origin tx linked to its Reactive tx and callback txs, with latency.
- **The Story**: 8 chapters (agree on rules → welcome Pip → shop on two chains → Pip goes rogue → only adults unfreeze → tighten line → cap → new month). One button each; checks tick off from on-chain state.
- **For Judges**: seven questions about on-chain reactivity answered with transactions, why this needs Reactive, where the evidence is, the recorded scenarios and rollovers, contracts (Sourcify-verified), features used and guarantees.

## Testnet

```bash
cp .env.example .env    # three throwaway testnet keys (alice, bob, agent)
PERIOD_SECONDS=3600 node ops/deploy.mjs testnet           # the public demo house uses a 1-hour period
node ops/prove.mjs testnet                                # one full story run → docs/EVIDENCE.md
node ops/prove.mjs testnet --plan story,scenarios,story   # several runs, one per period
node ops/prove.mjs testnet --story                        # the story, narrated chapter by chapter (video)
# dashboard: http://127.0.0.1:5173/?net=testnet  ·  published: https://hobhq.github.io/
```

**Why a 1-hour period on testnet.** In production a period is a month (`PERIOD_SECONDS` is a constructor
argument; the contracts don't change). With one hour, judges can watch the reset happen on-chain: when a
period ends, both chains report groceries NORMAL with zero spent, and nobody sends a transaction for it.
The prover records each of these rollovers.

**What the prover records.** Every run needs an unused period; if the current one already has spending,
the prover waits for the next one and records the rollover. Two kinds of run:

| Run | What it proves |
|---|---|
| `story` | rules ratified and mirrored → Pip added → shopping on two chains summed → Pip's cross-chain burst frozen everywhere → only an adult unfreezes → TIGHT at 80% with per-chain slices → FROZEN at the cap → an extra purchase refused |
| `scenarios` | co-sign above the line (and Pip can't co-sign itself) · Pip must say why (no reason → refused; the reason is in the same tx as the spend) · a rule changed mid-period reaches Unichain · a paused category is refused on the other chain · a member voted out is refused on the other chain · the pace limit is exact (6 buys pass, the 7th freezes) · one payment can close a category while the others stay open |

Each loop is origin tx → Reactive tx → callback tx(s) with measured latency; each refusal is a check.
Results: **[docs/EVIDENCE.md](docs/EVIDENCE.md)** and `docs/evidence.testnet.json`, also shown in the
dashboard under **For Judges → Scenarios proven on-chain**.

**Verified source.** The vaults and the reactive contract are verified on [Sourcify](https://sourcify.dev)
(exact match), so the code on the explorers is the code in this repository.

## Honest limits

- **Overshoot window.** Between a purchase and the reaction landing, each chain can still spend within its local limits. The invariant fuzz bounds it by what is in flight; from the tighten line on, per-chain slices make it zero for new purchases.
- **The velocity limits** are fixed at deploy, not voted by the household (v2: governed like rules). Right after registering the vaults the deployer calls `seal()`, and from then on nobody, including the deployer, can add a vault or change a limit.
- **Funds leave only through `spend`** in a ratified category. A "transfer" category is how a household moves money out.
- **Modes escalate within a period and never step back.** A rule change mid-period applies its new numbers, but a category that is already TIGHT/FROZEN stays so until the next period.
- **Testnet and a mock token.** Not audited.

## Repository

```
src/HobVault.sol        per-chain vault: spend, co-sign, proposals + quorum, roles, callbacks
src/HobReactive.sol     reactive contract: household ledger, velocity, mirroring
test/                      unit tests, invariant fuzz, ReactiveSim (local Reactive Network stand-in)
script/                    Foundry deploy scripts, mutants.sh
ops/                       deploy · relayer (local) · seed · burst · prove (evidence)
web/                       dashboard (static HTML/CSS/JS; viem self-hosted in web/vendor, rebuilt by ops/build-vendor.mjs)
docs/                      evidence
```

## Background

The ratification model (an agent proposes, people ratify, and the gap between the rule a
household states and the rule it actually lives by) comes from *Unwritten*, an earlier project
that derives household spending agreements from real decisions. **No Unwritten code is included.**
Every contract here was written during this buildathon.

MIT License.
