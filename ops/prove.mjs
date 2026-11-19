// Runs the demo story with real transactions and records every loop
// (origin tx → reactive tx → callback tx on each destination) with measured latency.
//   node ops/prove.mjs local      → docs/EVIDENCE.local.md
//   node ops/prove.mjs testnet    → docs/EVIDENCE.md
// Re-runnable: each run needs an unused period. If this period already has spending, the prover waits
// for the next one and records the rollover (both chains back to NORMAL with no transaction from anyone).
//   node ops/prove.mjs testnet --runs 3        three full runs, one per period (testnet period: 1 h)
// Every run is appended to docs/evidence.<network>.json (also copied to web/ for the judges' tab).
//
// Narrator mode for recording the demo video (same transactions, same evidence file):
//   node ops/prove.mjs testnet --story          pauses before each chapter (press Enter)
//   node ops/prove.mjs testnet --story --auto   pauses STORY_PAUSE_S seconds instead (default 8)
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
let loops = [];
const argOf = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
// --plan story,scenarios,story   one run per entry, each in its own period (default: one story run)
const PLAN = (argOf("--plan") ?? Array(Number(argOf("--runs") ?? 1)).fill("story").join(",")).split(",").map((x) => x.trim()).filter(Boolean);
let checks = [];
let scenario = null; // tag for loops and checks while a scenario runs
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
  const row = { label, ok, origin, reactive, callbacks: got, ...(scenario ? { scenario } : {}) };
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

async function runStory(runNo) {
  const agent = D.members.agent;
  const shop = "0x000000000000000000000000000000000000c0DE";
  console.log(`\nRun ${runNo}: proving the Hob loop on ${name}\n`);

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

  await refused("One more purchase on Base after the cap", () => tx("base", "alice", "spend", [CATEGORY.GROCERIES, shop, 10_000000n]), "CategoryFrozen");

  if (STORY) {
    const next = new Date((D.epoch + D.period * (Math.floor((Date.now() / 1000 - D.epoch) / D.period) + 1)) * 1000);
    await chapter(
      "A new month, by itself",
      `No keeper, no bot, no cron. On ${next.toUTCString()} groceries are NORMAL again on every chain.`,
      "keeps one ledger per period; the period id travels inside every spend event."
    );
  }

}



// ---- time: testnet waits for real; local warps the three anvil chains (no relayer/keeper involved)
const chainNow = async () => Number((await chains.base.p.getBlock()).timestamp);
async function waitUntilTs(ts) {
  if (name === "local") {
    const dt = ts - (await chainNow()) + 5;
    if (dt <= 0) return;
    for (const c of [chains.base, chains.uni, rx]) {
      await c.p.request({ method: "evm_increaseTime", params: [dt] });
      await c.p.request({ method: "evm_mine", params: [] });
    }
    console.log(`   (local: moved the three chains ${dt} s forward)`);
    return;
  }
  for (;;) {
    const now = await chainNow();
    if (now >= ts + 5) return;
    await sleep(Math.min(60_000, (ts + 5 - now) * 1000));
  }
}

// ---- scenarios: one situation per step, each proving a different guarantee
async function refused(label, action, errorName) {
  try {
    await action();
  } catch (e) {
    const text = [e.shortMessage, e.message, ...(e.metaMessages ?? [])].join(" ");
    const named = errorName ? new RegExp(errorName).test(text) : true;
    checks.push({ scenario, label, ok: named, detail: named ? `refused (${errorName})` : `refused, error not decoded` });
    console.log(`${named ? "✓" : "~"} ${label} → refused${named ? ` (${errorName})` : ""}`);
    return;
  }
  checks.push({ scenario, label, ok: false, detail: "went through" });
  throw new Error(`${label}: expected a refusal`);
}
function check(label, ok, detail) {
  checks.push({ scenario, label, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) throw new Error(`check failed: ${label}`);
}
const SCENARIOS = [
  ["cosign", "A purchase above the co-sign line needs a second adult", "Pip's 160 waits on Unichain until Bob co-signs; only then is it spent and counted by Hob"],
  ["rulechange", "The adults change a rule mid-period", "a new cap ratified on Base reaches Unichain by callback, no admin involved"],
  ["pause", "A paused category is closed on every chain", "rent paused on Base is refused on Unichain, then reopened the same way"],
  ["membership", "Removing a member works everywhere", "Pip voted out on Base is refused on Unichain, then voted back in"],
  ["threshold", "Hob's pace limit is exact", "6 buys across chains pass, the 7th freezes Pip on both chains"],
  ["wholecap", "One payment can close a category", "a single rent payment of the whole cap freezes rent on both chains; groceries stay open"],
];
async function waitPipWindows() {
  // the per-chain rate limit and Hob's pace window both last 1 h; start the pace test from a clean window
  const agent = D.members.agent;
  const [mb, mu, v] = await Promise.all([
    viewVault("base", "members", [agent]),
    viewVault("uni", "members", [agent]),
    rx.p.readContract({ address: rx.contract, abi: R.abi, functionName: "velocityOf", args: [agent] }),
  ]);
  const ends = [[mb[2], mb[3]], [mu[2], mu[3]], [v[0], v[1]]].filter(([, n]) => Number(n) > 0).map(([w]) => (Number(w) + 3600) * 1000);
  const until = Math.max(0, ...ends) / 1000;
  if (until > (await chainNow())) {
    console.log(`Pip's 1-hour windows end at ${new Date(until * 1000).toISOString()}; waiting so the pace test starts clean.`);
    await waitUntilTs(until);
  }
}
async function runScenarios() {
  const agent = D.members.agent;
  const shop = "0x000000000000000000000000000000000000c0DE";
  const G = CATEGORY.GROCERIES, RENT = CATEGORY.RENT;
  const head = (k) => {
    scenario = k;
    const [, title, proves] = SCENARIOS.find((x) => x[0] === k);
    console.log(`\n── Scenario: ${title}\n   ${proves}`);
  };
  const ratifyRule = (cat, rule) => ratify(cat, rule);
  const groceries = { monthlyCap: 1000_000000n, perTxCap: 200_000000n, coSignAbove: 150_000000n, active: true };
  const rent = { monthlyCap: 2000_000000n, perTxCap: 2000_000000n, coSignAbove: 2000_000000n, active: true };

  // a known starting point: both rules in place (ratified again; a new version is fine)
  scenario = "setup";
  await loop("Setup: groceries rule in force → mirrored", () => ratifyRule(G, groceries), "RulesMirrored", [{ chain: "uni", event: "RulesApplied", match: (a) => a.category === G }]);
  await loop("Setup: rent rule in force → mirrored", () => ratifyRule(RENT, rent), "RulesMirrored", [{ chain: "uni", event: "RulesApplied", match: (a) => a.category === RENT }]);

  head("cosign");
  const id = await viewVault("uni", "pendingCount");
  await tx("uni", "agent", "spend", [G, shop, 160_000000n]);
  const req = await viewVault("uni", "pending", [id]);
  check("Pip's 160 on Unichain is held for a co-sign", req[0].toLowerCase() === agent.toLowerCase() && !req[5], `request #${id}`);
  await refused("Pip co-signs its own request", () => tx("uni", "agent", "approveSpend", [id]), "NotAdult|SelfApproval|OnlyAdult");
  await loop("Bob co-signs on Unichain → spent → counted in the household ledger", () => tx("uni", "bob", "approveSpend", [id]), "LedgerUpdated", []);

  head("rulechange");
  await loop("Adults raise the groceries cap to 1,200 on Base → applied on Unichain", () => ratifyRule(G, { ...groceries, monthlyCap: 1200_000000n }), "RulesMirrored", [{ chain: "uni", event: "RulesApplied", match: (a) => a.category === G }]);
  const ru = await viewVault("uni", "rules", [G]);
  check("Unichain now enforces a cap of 1,200", ru[0] === 1200_000000n, "read from the Unichain vault");
  await loop("Adults set it back to 1,000 → applied on Unichain", () => ratifyRule(G, groceries), "RulesMirrored", [{ chain: "uni", event: "RulesApplied", match: (a) => a.category === G }]);

  head("pause");
  await loop("Adults pause rent on Base → paused on Unichain", () => ratifyRule(RENT, { ...rent, active: false }), "RulesMirrored", [{ chain: "uni", event: "RulesApplied", match: (a) => a.category === RENT }]);
  await refused("Bob pays rent on Unichain while it is paused", () => tx("uni", "bob", "spend", [RENT, shop, 100_000000n]), "CategoryInactive");
  await loop("Adults reopen rent on Base → reopened on Unichain", () => ratifyRule(RENT, rent), "RulesMirrored", [{ chain: "uni", event: "RulesApplied", match: (a) => a.category === RENT }]);

  head("membership");
  await loop("Adults vote Pip out on Base → removed on Unichain", async () => {
    const pid = await proposalId("base");
    await tx("base", "alice", "proposeMember", [agent, 0]);
    return tx("base", "bob", "approveProposal", [pid]);
  }, "MemberMirrored", [{ chain: "uni", event: "MemberSynced", match: (a) => a.member.toLowerCase() === agent.toLowerCase() && Number(a.role) === 0 }]);
  await refused("Pip buys on Unichain after being voted out", () => tx("uni", "agent", "spend", [G, shop, 10_000000n]), "NotMember");
  await loop("Adults vote Pip back in → known again on Unichain", async () => {
    const pid = await proposalId("base");
    await tx("base", "alice", "proposeMember", [agent, 2]);
    return tx("base", "bob", "approveProposal", [pid]);
  }, "MemberMirrored", [{ chain: "uni", event: "MemberSynced", match: (a) => a.member.toLowerCase() === agent.toLowerCase() && Number(a.role) === 2 }]);

  head("threshold");
  const rxStart = await rx.p.getBlockNumber();
  for (const [i, k] of ["base", "uni", "base", "uni", "base", "uni"].entries()) {
    await loop(`Pip buy ${i + 1}/6 on ${chains[k].name} (limit: 6 an hour, all chains)`, () => tx(k, "agent", "spend", [G, shop, 10_000000n]), "LedgerUpdated", []);
  }
  const early = await findEvent(rx.p, rx.contract, R.abi, "VelocityBreach", rxStart + 1n);
  check("6 buys across chains: no freeze", !early, "no VelocityBreach on Reactive");
  await loop("Pip buy 7 on Base → over the limit → frozen on both chains", () => tx("base", "agent", "spend", [G, shop, 10_000000n]), "VelocityBreach", [
    { chain: "base", event: "MemberFrozen", match: (a) => a.member.toLowerCase() === agent.toLowerCase() },
    { chain: "uni", event: "MemberFrozen", match: (a) => a.member.toLowerCase() === agent.toLowerCase() },
  ]);
  await refused("Frozen Pip buys on Unichain", () => tx("uni", "agent", "spend", [G, shop, 10_000000n]), "MemberIsFrozen");
  await loop("Alice lifts the freeze on Base → lifted on Unichain", () => tx("base", "alice", "unfreezeMember", [agent]), "MemberMirrored", [
    { chain: "uni", event: "MemberSynced", match: (a) => a.member.toLowerCase() === agent.toLowerCase() && a.unfreeze },
  ]);

  head("wholecap");
  await loop("Alice pays the whole rent (2,000) on Base → rent FROZEN on both chains", () => tx("base", "alice", "spend", [RENT, shop, 2000_000000n]), "CategoryEscalated", [
    { chain: "base", event: "CategoryModeChanged", match: (a) => a.category === RENT && a.mode === 2 },
    { chain: "uni", event: "CategoryModeChanged", match: (a) => a.category === RENT && a.mode === 2 },
  ]);
  await refused("Bob pays rent on Unichain after the cap", () => tx("uni", "bob", "spend", [RENT, shop, 10_000000n]), "CategoryFrozen");
  const g = await viewVault("uni", "categoryStatus", [G]);
  check("Groceries stay open on Unichain", Number(g[0]) !== 2, `groceries ${MODE[g[0]]}`);
  scenario = null;
}


// ---- delivery health: every callback Hob asked for must have landed before a run starts.
// Compares what Hob requested on Reactive with what each vault received (counts since deploy).
async function backlog() {
  // state, not event counts: a late callback for an old period is ignored by design and emits nothing
  const cats = [CATEGORY.GROCERIES, CATEGORY.RENT];
  const [vb, vu, nb, nu, pb] = await Promise.all([
    Promise.all(cats.map((c) => viewVault("base", "ruleVersion", [c]))),
    Promise.all(cats.map((c) => viewVault("uni", "ruleVersion", [c]))),
    viewVault("base", "memberNonce"),
    viewVault("uni", "memberNonce"),
    viewVault("base", "currentPeriod"),
  ]);
  let uni = cats.filter((_, i) => vb[i] > vu[i]).length + (nb > nu ? 1 : 0);
  let base = 0;
  // escalations Hob decided for the current period must be in force on both chains
  const head = await rx.p.getBlockNumber();
  const from = head > 3000n ? head - 3000n : 0n; // Lasna: a few hours back covers the current period
  const logs = await rx.p.getLogs({ address: rx.contract, fromBlock: from, toBlock: head });
  for (const lg of logs) {
    let ev;
    try { ev = decodeEventLog({ abi: R.abi, data: lg.data, topics: lg.topics }); } catch { continue; }
    if (ev.eventName !== "CategoryEscalated" || BigInt(ev.args.period) !== BigInt(pb)) continue;
    const [sb, su] = await Promise.all([viewVault("base", "categoryStatus", [ev.args.category]), viewVault("uni", "categoryStatus", [ev.args.category])]);
    if (Number(sb[0]) < Number(ev.args.mode)) base++;
    if (Number(su[0]) < Number(ev.args.mode)) uni++;
  }
  return { base, uni };
}
async function waitForDelivery() {
  if (name === "local") return;
  let warned = false;
  for (;;) {
    const bl = await backlog();
    if (bl.base === 0 && bl.uni === 0) {
      if (warned) console.log(`✓ Reactive delivered the backlog (${new Date().toISOString()})`);
      return;
    }
    if (!warned) console.log(`Reactive callbacks not delivered yet: ${bl.base} to Base, ${bl.uni} to Unichain. Waiting before starting a run…`);
    else console.log(`  ${new Date().toISOString()} still pending: ${bl.base} to Base, ${bl.uni} to Unichain`);
    warned = true;
    await sleep(120_000);
  }
}

// ---- periods: a run needs a period with no spending yet
const viewVault = (k, functionName, args = []) => chains[k].p.readContract({ address: chains[k].vault, abi: V.abi, functionName, args });
async function periodState() {
  const [p, b, u] = await Promise.all([viewVault("base", "currentPeriod"), viewVault("base", "categoryStatus", [0]), viewVault("uni", "categoryStatus", [0])]);
  return { period: Number(p), base: { mode: Number(b[0]), spent: b[2] }, uni: { mode: Number(u[0]), spent: u[2] } };
}
async function ensureFreshPeriod() {
  const st = await periodState();
  if (st.base.spent === 0n && st.uni.spent === 0n && st.base.mode === 0 && st.uni.mode === 0) return st;
  const next = D.epoch + D.period * (st.period + 1);
  console.log(`\nPeriod #${st.period} is already used (groceries ${MODE[st.base.mode]} on Base, ${MODE[st.uni.mode]} on Unichain).`);
  console.log(`Waiting for period #${st.period + 1} at ${new Date(next * 1000).toISOString()}. Nobody will send a transaction to reset it.`);
  await waitUntilTs(next);
  let now;
  for (;;) {
    now = await periodState();
    if (now.period > st.period && now.base.mode === 0 && now.uni.mode === 0 && now.base.spent === 0n && now.uni.spent === 0n) break;
    await sleep(3000);
  }
  const blocks = await Promise.all(["base", "uni"].map((k) => chains[k].p.getBlockNumber()));
  const r = { fromPeriod: st.period, toPeriod: now.period, before: { base: MODE[st.base.mode], uni: MODE[st.uni.mode], spentBase: Number(st.base.spent) / 1e6, spentUni: Number(st.uni.spent) / 1e6 }, after: { base: "NORMAL", uni: "NORMAL", spentBase: 0, spentUni: 0 }, observedAt: new Date().toISOString(), blocks: { base: Number(blocks[0]), uni: Number(blocks[1]) } };
  E.rollovers.push(r);
  console.log(`✓ Rollover #${st.period} → #${now.period}: groceries ${r.before.base}/${r.before.uni} → NORMAL on both chains, no transaction sent (Base block ${r.blocks.base}, Unichain block ${r.blocks.uni})`);
  saveEvidence();
  return now;
}

// ---- evidence, accumulated across invocations for the same deployment
const EFILE = join(ROOT, "docs", `evidence.${name}.json`);
const E = (() => {
  if (existsSync(EFILE)) {
    const prev = JSON.parse(readFileSync(EFILE, "utf8"));
    if (prev.reactive === rx.contract) return prev;
  }
  return { network: name, reactive: rx.contract, vaults: { base: chains.base.vault, uni: chains.uni.vault }, periodSeconds: D.period, runs: [], rollovers: [] };
})();
const plain = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? Number(v) : v)));
const stats = (ls) => {
  const lats = ls.flatMap((l) => Object.values(l.callbacks).map((c) => c.ms)).sort((a, b) => a - b);
  return { callbacks: lats.length, medianMs: lats[Math.floor(lats.length / 2)] ?? null, p95Ms: lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] ?? null };
};
function saveEvidence() {
  writeFileSync(EFILE, JSON.stringify(E, null, 2) + "\n");
  if (name !== "local") copyFileSync(EFILE, join(ROOT, "web", `evidence.${name}.json`));
  writeEvidence();
}

async function main() {
  for (const kind of PLAN) {
    if (!["story", "scenarios"].includes(kind)) throw new Error(`unknown plan entry: ${kind}`);
    // an unused period, Pip's 1-hour windows clear, and at least 15 minutes left in the period
    let st;
    for (;;) {
      await waitForDelivery();
      st = await ensureFreshPeriod();
      await waitPipWindows();
      const end = D.epoch + D.period * ((await periodState()).period + 1);
      if (end - (await chainNow()) >= Math.min(900, D.period / 4)) break;
      console.log("Too close to the end of the period; starting in the next one.");
      await waitUntilTs(end);
    }
    st = await periodState();
    loops = [];
    checks = [];
    const startedAt = new Date().toISOString();
    if (kind === "story") await runStory(E.runs.length + 1);
    else {
      console.log(`\nRun ${E.runs.length + 1}: scenarios on ${name}`);
      await runScenarios();
    }
    const s = stats(loops);
    E.runs.push(plain({ run: E.runs.length + 1, kind, period: st.period, startedAt, finishedAt: new Date().toISOString(), loops, checks, ...s }));
    const status = await periodState();
    console.log(`\n${loops.length} loops, ${s.callbacks} callbacks, ${checks.length} checks — median ${(s.medianMs / 1000).toFixed(1)}s, p95 ${(s.p95Ms / 1000).toFixed(1)}s`);
    console.log(`groceries mode: Base ${MODE[status.base.mode]}, Unichain ${MODE[status.uni.mode]}`);
    E.scenarios = SCENARIOS.map(([key, title, proves]) => ({ key, title, proves }));
    saveEvidence();
  }
}

function link(c, hash) {
  const u = txLink(c, hash);
  const short = `${hash.slice(0, 6)}…${hash.slice(-4)}`;
  return u ? `[${short}](${u})` : `\`${short}\``;
}

function writeEvidence() {
  const all = E.runs.flatMap((r) => r.loops);
  const tot = stats(all);
  const L = [];
  L.push(`# Evidence — ${name}`);
  L.push("");
  L.push(`Generated by \`node ops/prove.mjs ${name}\`; last update ${new Date().toISOString()}. Machine-readable: [\`evidence.${name}.json\`](evidence.${name}.json).`);
  if (name === "local") {
    L.push("");
    L.push("> **Local run**: three anvil chains and `ops/relayer.mjs` standing in for Reactive Network. Latencies here measure our tooling, not Reactive. See `EVIDENCE.md` for the testnet run.");
  }
  L.push("");
  L.push(`Reactive contract: \`${rx.contract}\` on ${rx.name}. Vaults: \`${chains.base.vault}\` (${chains.base.name}, home), \`${chains.uni.vault}\` (${chains.uni.name}). Period: ${D.period >= 86400 ? `${D.period / 86400} days` : `${D.period / 60} minutes`}.`);
  L.push("");
  L.push(`**${E.runs.length} run${E.runs.length === 1 ? "" : "s"}, ${all.length} loops, all complete, ${tot.callbacks} callbacks. Callback latency (origin receipt → callback seen): median ${(tot.medianMs / 1000).toFixed(1)} s, p95 ${(tot.p95Ms / 1000).toFixed(1)} s. ${E.rollovers.length} automatic period rollover${E.rollovers.length === 1 ? "" : "s"} observed.**`);
  if (E.rollovers.length) {
    L.push("");
    L.push("## Rollovers (no transaction sent by anyone)");
    L.push("");
    L.push("| Period | Groceries before (Base / Unichain) | After | Observed at | Blocks (Base / Unichain) |");
    L.push("|---|---|---|---|---|");
    for (const r of E.rollovers) L.push(`| #${r.fromPeriod} → #${r.toPeriod} | ${r.before.base} (${r.before.spentBase ?? "?"} spent) / ${r.before.uni} (${r.before.spentUni ?? "?"} spent) | NORMAL (0) / NORMAL (0) | ${r.observedAt} | ${r.blocks.base} / ${r.blocks.uni} |`);
  }
  for (const run of [...E.runs].reverse()) {
    L.push("");
    L.push(`## Run ${run.run} (${run.kind === "scenarios" ? "scenarios" : "the story"}) — period #${run.period}, ${run.startedAt}`);
    L.push("");
    L.push(`${run.loops.length} loops, ${run.callbacks} callbacks, median ${(run.medianMs / 1000).toFixed(1)} s, p95 ${(run.p95Ms / 1000).toFixed(1)} s.`);
    L.push("");
    L.push("| # | Loop | Origin | Reactive tx | Callback(s) | Latency |");
    L.push("|---|---|---|---|---|---|");
    run.loops.forEach((l, i) => {
      const o = chains[l.origin.chain];
      const cbs = Object.entries(l.callbacks).map(([k, v]) => `${chains[k].name}: ${link(chains[k], v.hash)}`).join("<br>");
      const lat = Object.values(l.callbacks).map((v) => `${(v.ms / 1000).toFixed(1)} s`).join(" / ");
      L.push(`| ${i + 1} | ${l.scenario && l.scenario !== "setup" ? `**${E.scenarios?.find((x) => x.key === l.scenario)?.title ?? l.scenario}** · ` : ""}${l.label} | ${o.name}: ${link(o, l.origin.hash)} | ${link(rx, l.reactive.hash)} | ${cbs || "—"} | ${lat || "ledger only"} |`);
    });
    if (run.checks?.length) {
      L.push("");
      L.push("| Check | Result |");
      L.push("|---|---|");
      for (const c of run.checks) L.push(`| ${c.label} | ${c.ok ? "✓" : "✗"} ${c.detail ?? ""} |`);
    }
  }
  L.push("");
  const slow = all.filter((l) => Object.values(l.callbacks).some((c) => c.ms > 120_000));
  if (slow.length) {
    L.push(`> **Slow loops.** ${slow.length} loop${slow.length > 1 ? "s" : ""} took over 2 minutes: ${slow.map((l) => `"${l.label}"`).join(", ")}. On 2026-11-19 Reactive Network stopped delivering callbacks to Base Sepolia and Unichain Sepolia from about 19:30 to 20:49 UTC (Hob kept reacting on Lasna; the callbacks queued and were delivered when the network recovered). The prover now waits for the delivery backlog to clear before starting a run. The median is not affected.`);
    L.push("");
  }
  L.push("Latency is wall-clock from the origin transaction's receipt to the moment the callback's event was visible over RPC (150 ms polling included).");
  const file = join(ROOT, "docs", name === "testnet" ? "EVIDENCE.md" : `EVIDENCE.${name}.md`);
  writeFileSync(file, L.join("\n") + "\n");
  console.log("wrote", file);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e, "\n", e.details ?? "", "\n", (e.stack ?? "").split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});
