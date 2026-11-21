# Demo video script (target 2:45, hard limit 3:00)

**The idea in one line:** *AI reasons. Code enforces. Hob reacts.* An AI shopper spends a household's money on two
chains; two adults set the rules together; Hob, on Reactive Network, enforces them across chains, even while
everyone is offline.

## Setup

- The public testnet house uses a 1-hour period. `node ops/prove.mjs testnet --story` waits for an unused
  period by itself (at most an hour), so start it a little before recording.
- **Left:** terminal running `node ops/prove.mjs testnet --story`. Press Enter to start each chapter. Every
  transaction is real; the terminal prints what Pip says for each purchase and each Reactive tx link.
- **Right:** https://hobhq.github.io/. Use the Dashboard tab for the hero, *Pip's receipts* and the map, The
  Story tab for the chapter checks, and For Judges at the end.
- Keep explorer tabs ready: Base Sepolia, Unichain Sepolia, Lasna (reactscan).

## Script

| Time | On screen | Say |
|---|---|---|
| 0:00–0:15 | Dashboard hero: *AI reasons. Code enforces. Hob reacts.* | "Who enforces an AI agent's rules when nobody is watching? Not a prompt, and not a bot that can go offline. In Hob, the household does, through Reactive Network." |
| 0:15–0:30 | The three cards under the hero | "Pip, our AI shopper, reasons, and it has to say why for every purchase. The vault code enforces the rules Alice and Bob agreed on. And Hob, on Reactive, watches both chains and reacts." |
| 0:30–0:50 | **Ch. 1 Agree on the rules** → Enter. Watch the map. | "Alice proposes, Bob approves: two of two. The rule goes live on Base, and Reactive writes it to Unichain. Nobody has admin rights on that chain." |
| 0:50–1:05 | **Ch. 2 Welcome Pip** and **Ch. 3 Shop on two chains** | "The adults vote Pip in. Pip can buy and propose, but never approve. Alice buys on Base, Bob on Unichain. Neither vault sees the other; Hob keeps one ledger for the house." |
| 1:05–1:40 | **Ch. 4 Pip goes rogue** → Enter. Terminal shows Pip's reasons. | "Pip makes seven quick buys, each one with a reason. Three on Base, four on Unichain. Each chain allows five, so neither vault objects. Hob counts seven across chains and freezes Pip on both." *(click the Reactive tx and one callback)* |
| 1:40–1:55 | Dashboard → **Pip's receipts** | "And here's the audit trail. You don't have to trust what the agent says it did: each line is Pip's own words, on-chain in the same transaction as the money, next to what the vault allowed and what Hob did. A buy without a reason is refused." |
| 1:55–2:05 | **Ch. 5 Only adults lift a freeze** | "Pip can't unfreeze itself. Alice decides once, on Base; Reactive carries it everywhere." |
| 2:05–2:25 | **Ch. 6 Tighten line** and **Ch. 7 The cap** | "At 80% both chains go TIGHT, and what's left is split per chain. At the cap, groceries are frozen everywhere and one more purchase is refused." |
| 2:25–2:45 | For Judges → *Seven questions*, then the rollovers table | "Now nobody touches anything. The AI can sleep, and the adults can be away. When the period ends, every chain is back to normal, with no transaction from anyone. It's all recorded here: every loop, every refusal and every rollover, with the code verified. Set it, and forget it." |

## Tips

- Record chapter 4 live. It's the moment that needs Reactive.
- Say *"AI reasons, code enforces, Hob reacts"* once at the start and once at the end. It is the thesis.
- On camera, read one of Pip's reasons aloud from *Pip's receipts*. It makes the audit trail concrete.
- Keep Unwritten out of the video. It's only in the README background.
