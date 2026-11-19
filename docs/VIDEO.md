# Demo video script (target 2:40, hard limit 3:00)

Setup before recording: a **fresh** testnet deployment (`node ops/deploy.mjs testnet`, no seed). Split the screen:
- left: terminal running `node ops/prove.mjs testnet --story`. Press Enter to start each chapter; every transaction is real, and the run writes `docs/EVIDENCE.md`;
- right: dashboard at `?net=testnet` on the **Guided demo** tab. Click the chapter you are on: its checks tick as the transactions land.

Keep explorer tabs ready (Base Sepolia, Unichain Sepolia, Lasna reactscan). The terminal prints each Reactive tx link.
The network map at the top stays on screen the whole time: every event flies from its chain to
Reactive, and every callback flies back.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:15 | Map: Base · Reactive · Unichain | "Most spending limits give one owner control over their agents. Households don't work like that. Hob is a household agreement that no one changes alone, enforced on every chain by Reactive." |
| 0:15–0:40 | **Ch. 1 Agree on the rules** → Enter | "Alice proposes, Bob approves: two of two. The rule goes live on Base. Watch the map: Reactive picks it up and writes it to Unichain. Nobody touched the mirror, and nobody has admin rights there." |
| 0:40–1:00 | **Ch. 3 Shop on two chains** → Enter | "Each chain sees only its own spending. Reactive keeps the household ledger, the sum across both chains. Under the line nothing changes, so no callback is sent." |
| 1:00–1:35 | **Ch. 4 Pip goes rogue** → Enter | "Pip makes seven quick buys: three on Base, four on Unichain. Each chain allows five, so neither vault objects. Hob, on Reactive, counts seven across chains and freezes Pip on both." *(click the Reactive tx link the terminal prints, and one callback)* |
| 1:35–1:45 | **Ch. 5 Only adults lift a freeze** → Enter | "Pip can't unfreeze itself. Alice decides once, on Base. Reactive carries it everywhere." |
| 1:45–2:10 | **Ch. 6 Tighten line**, then **Ch. 7 The cap** | "At the line both chains go TIGHT, and what's left is split per chain. When the sum reaches the cap: frozen everywhere, and one more purchase is refused." |
| 2:10–2:40 | **Under the hood** tab, then `docs/EVIDENCE.md` | "Every loop here (origin, Reactive, callback) is linked, and the full run is in the evidence file. The guarantees are fuzzed, and seventeen planted bugs are all caught, and after setup there is no admin key at all. No keeper, no bot, no cron. Set it, and forget it." |

Tips
- Record chapter 4 live. It's the moment that needs Reactive.
- Each step's "What just happened" log links every transaction. Click one Lasna and one callback tx (judging: *Execution*).
- On testnet, chapter 8 shows when the next period starts. Mention it, but don't wait for it.
- Keep Unwritten out of the video. It's only in the README background.
