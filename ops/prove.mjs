// Runs the demo story with real transactions and records every loop
// (origin tx → reactive tx → callback tx on each destination) with measured latency.
//   node ops/prove.mjs local      → docs/EVIDENCE.local.md
//   node ops/prove.mjs testnet    → docs/EVIDENCE.md
// Expects a FRESH deployment (it ratifies rules and walks one period from zero).
//
// Narrator mode for recording the demo video (same transactions, same evidence file):
//   node ops/prove.mjs testnet --story          pauses before each chapter (press Enter)
//   node ops/prove.mjs testnet --story --auto   pauses STORY_PAUSE_S seconds instead (default 8)
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { decodeEventLog } from "viem";
import { A, ROOT, CATEGORY, MODE, keys, loadDeployment, net, pub, sleep, txLink, wallet } from "./lib.mjs";

const name = process.argv[2] ?? "local";
const N = net(name);
const K = keys(name);
const D = loadDeployment(name);
const V = A.vault();
const R = A.reactive();
const TIMEOUT = Number(process.env.LOOP_TIMEOUT_MS ?? 120_000);

const chains = {
  base: { ...N.base, vault: D.chains.base.vault, p: pub(N.base) },
  uni: { ...N.uni, vault: D.chains.uni.vault, p: pub(N.uni) },
};
const rx = { ...N.reactive, contract: D.chains.reactive.contract, p: pub(N.reactive) };
const loops = [];
const STORY = process.argv.includes("--story");
const AUTO = process.argv.includes("--auto");
const PAUSE = Number(process.env.STORY_PAUSE_S ?? 8);
let chapterNo = 0;

const B = (t) => `\x1b[1m${t}\x1b[0m`;
const DIM = (t) => `\x1b[2m${t}\x1b[0m`;
async function chapter(title, story, reactive) {
  if (!STORY) return;
  chapterNo++;
  console.log(`\n${B(`── Chapter ${chapterNo}. ${title}`)}\n${story}\n${DIM(`Hob, on Reactive: ${reactive}`)}`);
  if (AUTO) return sleep(PAUSE * 1000);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(DIM("  ⏎ run it "));
  rl.close();
}

async function tx(chainKey, who, functionName, args) {
  const c = chains[chainKey];
  const w = wallet(c, K[who]);
  let hash;
  for (let attempt = 1; ; attempt++) {
    try {
      hash = await w.writeContract({ address: c.vault, abi: V.abi, functionName, args });
      break;
    } catch (e) {
      // public RPCs are load-balanced: a node can lag one nonce behind. Wait and retry.
      if (attempt < 4 && /nonce too low|replacement transaction underpriced|already known/i.test(e.details ?? e.message ?? "")) {
        await sleep(2500);
        continue;
      }
      throw e;
    }
  }
  const r = await c.p.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${who} ${functionName} reverted on ${c.name}`);
  return { hash, block: r.blockNumber, chain: chainKey };
}

async function findEvent(client, address, abi, eventName, fromBlock, match = () => true) {
  const head = await client.getBlockNumber();
  if (head < fromBlock) return null; // some nodes reject ranges that start in the future
  const logs = await client.getLogs({ address, fromBlock, toBlock: head });
  for (const lg of logs) {
    try {
      const ev = decodeEventLog({ abi, data: lg.data, topics: lg.topics });
      if (ev.eventName === eventName && match(ev.args)) return { hash: lg.transactionHash, block: lg.blockNumber, args: ev.args };
    } catch {}
  }
  return null;
}

/// Sends `action`, then waits until every expected destination event shows up.
async function loop(label, action, reactiveEvent, expects) {
  const rxFrom = await rx.p.getBlockNumber();
  const from = {};
  for (const k of Object.keys(chains)) from[k] = await chains[k].p.getBlockNumber();
  const t0 = Date.now();
  const origin = await action();
  const tOrigin = Date.now();

  const got = {};
  let reactive = null;
  while (Date.now() - t0 < TIMEOUT) {
    if (!reactive) reactive = await findEvent(rx.p, rx.contract, R.abi, reactiveEvent, rxFrom + 1n);
    for (const e of expects) {
      if (got[e.chain]) continue;
      const c = chains[e.chain];
      const hit = await findEvent(c.p, c.vault, V.abi, e.event, from[e.chain] + 1n, e.match);
      if (hit) got[e.chain] = { ...hit, ms: Date.now() - tOrigin };
    }
    if (reactive && expects.every((e) => got[e.chain])) break;
    await sleep(150);
  }
  const ok = !!reactive && expects.every((e) => got[e.chain]);
  const row = { label, ok, origin, reactive, callbacks: got };
  loops.push(row);
  const lat = Object.entries(got).map(([k, v]) => `${chains[k].name} ${(v.ms / 1000).toFixed(1)}s`).join(", ");
  console.log(`${ok ? "✓" : "✗"} ${label} — ${lat || "ledger updated, no callback needed"}`);
  if (STORY && reactive) console.log(DIM(`    reactive tx ${txLink(rx, reactive.hash) ?? reactive.hash}`));
  if (!ok) throw new Error(`loop "${label}" did not complete within ${TIMEOUT} ms`);
  return row;
}

async function proposalId(chainKey) {
  return chains[chainKey].p.readContract({ address: chains[chainKey].vault, abi: V.abi, functionName: "proposalCount" });
}

async function ratify(cat, rule) {
  const id = await proposalId("base");
  await tx("base", "alice", "proposeRule", [cat, rule]);
  return tx("base", "bob", "approveProposal", [id]);
}

async function main() {
  const agent = D.members.agent;
  const shop = "0x000000000000000000000000000000000000c0DE";
  console.log(`Proving the Hob loop on ${name}\n`);

  await chapter(
    "Agree on the rules",
    "Alice proposes groceries: 1,000 USDC a month, max 200 per purchase, a second adult above 150. Bob approves: 2 of 2.",
    "sees RulesRatified on Base and writes the rule to the Unichain vault by callback."
  );
  await loop(
    "Rule ratified on Base (2 of 2 adults) → mirrored to Unichain",
    () => ratify(CATEGORY.GROCERIES, { monthlyCap: 1000_000000n, perTxCap: 200_000000n, coSignAbove: 150_000000n, active: true }),
    "RulesMirrored",
    [{ chain: "uni", event: "RulesApplied", match: (a) => a.category === CATEGORY.GROCERIES }]
  );

  await loop(
    "Rent rule (one payment may be the whole cap) → mirrored",
    () => ratify(CATEGORY.RENT, { monthlyCap: 2000_000000n, perTxCap: 2000_000000n, coSignAbove: 2000_000000n, active: true }),
    "RulesMirrored",
    [{ chain: "uni", event: "RulesApplied", match: (a) => a.category === CATEGORY.RENT }]
  );

  await chapter(
    "Welcome Pip, the AI shopper",
    "The adults vote Pip in. Pip can shop and propose, but never ratify, co-sign or unfreeze.",
    "learns the member's role (for velocity limits) and mirrors it to Unichain."
  );
  await loop(
    "Pip added by vote → known on Unichain",
    async () => {
      const id = await proposalId("base");
      await tx("base", "alice", "proposeMember", [agent, 2]);
      return tx("base", "bob", "approveProposal", [id]);
    },
    "MemberMirrored",
    [{ chain: "uni", event: "MemberSynced", match: (a) => a.member.toLowerCase() === agent.toLowerCase() }]
  );

  await chapter(
    "Shop on two chains",
    "Alice buys 40 on Base, Bob buys 30 on Unichain. Each vault sees only its own chain.",
    "adds both to one household ledger. Nothing changes on the chains, so no callback is paid for."
  );
  await loop(
    "Alice on Base + Bob on Unichain → one household ledger",
    async () => {
      await tx("base", "alice", "spend", [CATEGORY.GROCERIES, shop, 40_000000n]);
      return tx("uni", "bob", "spend", [CATEGORY.GROCERIES, shop, 30_000000n]);
    },
    "LedgerUpdated",
    []
  );

  await chapter(
    "Pip goes rogue",
    "Pip makes seven quick buys: three on Base, four on Unichain. Each chain allows an agent five an hour, so neither vault objects.",
    "counts seven across chains, which is above the agent limit of six, and freezes Pip on every chain for 24 h."
  );
  await loop(
    "Pip bursts 3 buys on Base + 4 on Unichain → frozen on both",
    async () => {
      for (let i = 0; i < 3; i++) await tx("base", "agent", "spend", [CATEGORY.GROCERIES, shop, 20_000000n]);
      let last;
      for (let i = 0; i < 4; i++) last = await tx("uni", "agent", "spend", [CATEGORY.GROCERIES, shop, 20_000000n]);
      return last;
    },
    "VelocityBreach",
    [
      { chain: "base", event: "MemberFrozen", match: (a) => a.member.toLowerCase() === agent.toLowerCase() },
      { chain: "uni", event: "MemberFrozen", match: (a) => a.member.toLowerCase() === agent.toLowerCase() },
    ]
  );

  await chapter(
    "Only adults lift a freeze",
    "Pip can't unfreeze itself. Alice decides once, on Base.",
    "carries the decision to Unichain by callback."
  );
  await loop(
    "Alice lifts Pip's freeze on Base → lifted on Unichain",
    () => tx("base", "alice", "unfreezeMember", [agent]),
    "MemberMirrored",
    [{ chain: "uni", event: "MemberSynced", match: (a) => a.member.toLowerCase() === agent.toLowerCase() && a.unfreeze }]
  );

  await chapter(
    "Crossing the tighten line",
    "The adults keep shopping until the household passes the line (800 of 1,000).",
    "sets TIGHT on every chain and splits what is left per chain. Pip now needs a co-sign."
  );
  await loop(
    "Household crosses 80% → TIGHT on both chains, remaining split per chain",
    async () => {
      for (let i = 0; i < 4; i++) await tx("base", "alice", "spend", [CATEGORY.GROCERIES, shop, 140_000000n]);
      return tx("uni", "bob", "spend", [CATEGORY.GROCERIES, shop, 140_000000n]);
    },
    "CategoryEscalated",
    [
      { chain: "base", event: "CategoryModeChanged", match: (a) => a.category === 0 && a.mode === 1 },
      { chain: "uni", event: "CategoryModeChanged", match: (a) => a.category === 0 && a.mode === 1 },
    ]
  );

  await chapter(
    "The cap, on the sum",
    "Each chain spends exactly its slice. Then Alice tries one more purchase.",
    "sees the household reach the cap and freezes groceries on every chain."
  );
  const left = async (k) => {
    const [, limit, spent] = await chains[k].p.readContract({ address: chains[k].vault, abi: V.abi, functionName: "categoryStatus", args: [0] });
    return limit > spent ? limit - spent : 0n;
  };
  await loop(
    "Each chain spends its slice → household cap reached → FROZEN on both",
    async () => {
      await tx("base", "alice", "spend", [CATEGORY.GROCERIES, shop, await left("base")]);
      return tx("uni", "bob", "spend", [CATEGORY.GROCERIES, shop, await left("uni")]);
    },
    "CategoryEscalated",
    [
      { chain: "base", event: "CategoryModeChanged", match: (a) => a.category === 0 && a.mode === 2 },
      { chain: "uni", event: "CategoryModeChanged", match: (a) => a.category === 0 && a.mode === 2 },
    ]
  );

  try {
    await tx("base", "alice", "spend", [CATEGORY.GROCERIES, shop, 10_000000n]);
    throw new Error("an extra purchase went through after the cap");
  } catch (e) {
    if (/extra purchase/.test(e.message)) throw e;
    console.log("✓ One more purchase on Base → refused (CategoryFrozen)");
  }

  if (STORY) {
    const next = new Date((D.epoch + D.period * (Math.floor((Date.now() / 1000 - D.epoch) / D.period) + 1)) * 1000);
    await chapter(
      "A new month, by itself",
      `No keeper, no bot, no cron. On ${next.toUTCString()} groceries are NORMAL again on every chain.`,
      "keeps one ledger per period; the period id travels inside every spend event."
    );
  }

  // ---- summary
  const lats = loops.flatMap((l) => Object.values(l.callbacks).map((c) => c.ms)).sort((a, b) => a - b);
  const median = lats[Math.floor(lats.length / 2)];
  const p95 = lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))];
  const status = await Promise.all(
    ["base", "uni"].map((k) =>
      chains[k].p.readContract({ address: chains[k].vault, abi: V.abi, functionName: "categoryStatus", args: [0] })
    )
  );
  console.log(`\n${loops.length} loops, ${lats.length} callbacks — median ${(median / 1000).toFixed(1)}s, p95 ${(p95 / 1000).toFixed(1)}s`);
  console.log(`groceries mode: Base ${MODE[status[0][0]]}, Unichain ${MODE[status[1][0]]}`);
  writeEvidence(median, p95);
}

function link(c, hash) {
  const u = txLink(c, hash);
  const short = `${hash.slice(0, 6)}…${hash.slice(-4)}`;
  return u ? `[${short}](${u})` : `\`${short}\``;
}

function writeEvidence(median, p95) {
  const L = [];
  L.push(`# Evidence — ${name}`);
  L.push("");
  L.push(`Generated by \`node ops/prove.mjs ${name}\` on ${new Date().toISOString()}.`);
  if (name === "local") {
    L.push("");
    L.push("> **Local run**: three anvil chains and `ops/relayer.mjs` standing in for Reactive Network. Latencies here measure our tooling, not Reactive. See `EVIDENCE.md` for the testnet run.");
  }
  L.push("");
  L.push(`Reactive contract: \`${rx.contract}\` on ${rx.name}. Vaults: \`${chains.base.vault}\` (${chains.base.name}, home), \`${chains.uni.vault}\` (${chains.uni.name}).`);
  L.push("");
  L.push(`**${loops.length} loops, all complete. Callback latency (origin receipt → callback seen): median ${(median / 1000).toFixed(1)} s, p95 ${(p95 / 1000).toFixed(1)} s.**`);
  L.push("");
  L.push("| # | Loop | Origin | Reactive tx | Callback(s) | Latency |");
  L.push("|---|---|---|---|---|---|");
  loops.forEach((l, i) => {
    const o = chains[l.origin.chain];
    const cbs = Object.entries(l.callbacks).map(([k, v]) => `${chains[k].name}: ${link(chains[k], v.hash)}`).join("<br>");
    const lat = Object.entries(l.callbacks).map(([k, v]) => `${(v.ms / 1000).toFixed(1)} s`).join(" / ");
    L.push(`| ${i + 1} | ${l.label} | ${o.name}: ${link(o, l.origin.hash)} | ${link(rx, l.reactive.hash)} | ${cbs} | ${lat} |`);
  });
  L.push("");
  L.push("Latency is wall-clock from the origin transaction's receipt to the moment the callback's event was visible over RPC (150 ms polling included).");
  const file = join(ROOT, "docs", name === "testnet" ? "EVIDENCE.md" : `EVIDENCE.${name}.md`);
  writeFileSync(file, L.join("\n") + "\n");
  console.log("wrote", file);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e, "\n", e.details ?? "", "\n", (e.stack ?? "").split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});
