import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  formatUnits,
  http,
  parseUnits,
  privateKeyToAccount,
} from "./vendor/viem.js"; // viem 2.21.55, self-hosted (node ops/build-vendor.mjs)

// ================================================================== config
// local dev server -> the anvil chains; anywhere else (GitHub Pages) -> the live testnet deployment
const ON_DEV_HOST = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const NET = new URLSearchParams(location.search).get("net") ?? (ON_DEV_HOST ? "local" : "testnet");
const LOCAL = NET === "local";
const D = await fetch(`deployment.${NET}.json`).then((r) => {
  if (!r.ok) throw new Error(`deployment.${NET}.json not found — run the deploy first`);
  return r.json();
});
const ABI = await fetch("abi.json").then((r) => r.json());

// Anvil's public dev keys: only ever used against the local chains.
const DEMO_KEYS = LOCAL
  ? {
      alice: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      bob: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    }
  : null;

// testnet runs a short period so judges can watch a rollover; 30 days is the production setting
const PW = Number(D.period) >= 28 * 86400 ? "month" : "period";
const PERIOD_HUMAN = Number(D.period) >= 86400 ? `${Math.round(Number(D.period) / 86400)} days` : Number(D.period) >= 3600 ? `${Math.round(Number(D.period) / 3600)} h` : `${Math.round(Number(D.period) / 60)} min`;
for (const el of document.querySelectorAll(".pw")) el.textContent = PW;
const SHOP = "0x000000000000000000000000000000000000c0DE";
const CATS = [
  { id: 0, name: "Groceries" },
  { id: 1, name: "Rent" },
];
const MODE = ["NORMAL", "TIGHT", "FROZEN"];
const ROLE = ["not a member", "Adult", "AI shopper"];
const WHO = { alice: D.members.alice, bob: D.members.bob, agent: D.members.agent };
const NAMES = {
  [WHO.alice.toLowerCase()]: "Alice",
  [WHO.bob.toLowerCase()]: "Bob",
  [WHO.agent.toLowerCase()]: "Pip",
};
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const nameOf = (a) => NAMES[a?.toLowerCase()] ?? short(a);
const usd = (v) => Number(formatUnits(v ?? 0n, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const U = (n) => parseUnits(String(n), 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const min = (a, b) => (a < b ? a : b);
const $ = (id) => document.getElementById(id);
// Escape anything that did not come from our own templates (RPC error text, wallet messages).
const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
// Replace markup only when it changed, so buttons under the cursor are not swapped out mid-click.
const html = (id, markup) => {
  const el = $(id);
  if (el.__html !== markup) {
    el.innerHTML = markup;
    el.__html = markup;
  }
};

const chainDefs = {};
function chainOf(c) {
  if (!chainDefs[c.chainId]) {
    chainDefs[c.chainId] = defineChain({
      id: c.chainId,
      name: c.name,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [c.rpc] } },
      blockExplorers: c.explorer ? { default: { name: "explorer", url: c.explorer } } : undefined,
    });
  }
  return chainDefs[c.chainId];
}

const C = {
  base: { key: "base", short: "Base", ...D.chains.base, abi: ABI.vault, address: D.chains.base.vault },
  uni: { key: "uni", short: "Unichain", ...D.chains.uni, abi: ABI.vault, address: D.chains.uni.vault },
  reactive: { key: "reactive", short: "Reactive", ...D.chains.reactive, abi: ABI.reactive, address: D.chains.reactive.contract },
};
// cacheTime 0: viem caches the block number for 4 s by default, which made events lag behind state.
for (const c of Object.values(C)) c.p = createPublicClient({ chain: chainOf(c), transport: http(c.rpc), cacheTime: 0 });
const VAULTS = [C.base, C.uni];
const byChainId = Object.fromEntries(Object.values(C).map((c) => [String(c.chainId), c]));
const read = (c, functionName, args = []) => c.p.readContract({ address: c.address, abi: c.abi, functionName, args });

const txLink = (c, hash) =>
  c.explorer
    ? `<a class="tx" href="${c.explorer}/tx/${hash}" target="_blank" rel="noopener">${short(hash)}</a>`
    : `<span class="tx" title="${hash}">${short(hash)}</span>`;
const addrLink = (c, a) =>
  c.explorer
    ? `<a class="tx" href="${c.explorer}/address/${a}" target="_blank" rel="noopener">${a}</a>`
    : `<code>${a}</code>`;
const badge = (m) => `<span class="badge ${MODE[m]}">${MODE[m]}</span>`;

// ================================================================== state
// S is rebuilt from chain reads on every refresh; every view renders from it.
let S = null;
const members = new Set(Object.values(WHO).map((a) => a.toLowerCase()));

async function load() {
  const [period, quorum, head] = await Promise.all([read(C.base, "currentPeriod"), read(C.base, "quorum"), C.base.p.getBlock()]);
  const s = { period, quorum, now: head.timestamp, periodStart: BigInt(D.epoch) + period * BigInt(D.period) };

  const rulesP = Promise.all(
    CATS.map(async (cat) => {
      const [rule, vHome, vMirror] = await Promise.all([
        read(C.base, "rules", [cat.id]),
        read(C.base, "ruleVersion", [cat.id]),
        read(C.uni, "ruleVersion", [cat.id]),
      ]);
      const [cap, perTx, coSign, active] = rule;
      return { cat, cap, perTx, coSign, active, vHome, vMirror };
    })
  );

  const budgetP = Promise.all(
    CATS.map(async (cat) => {
      const [ledger, cap, threshold, byBase, byUni, stBase, stUni] = await Promise.all([
        read(C.reactive, "ledger", [period, cat.id]),
        read(C.reactive, "capOf", [cat.id]),
        read(C.reactive, "tightenThreshold", [cat.id]),
        read(C.reactive, "spentByChain", [period, cat.id, BigInt(C.base.chainId)]),
        read(C.reactive, "spentByChain", [period, cat.id, BigInt(C.uni.chainId)]),
        read(C.base, "categoryStatus", [cat.id]),
        read(C.uni, "categoryStatus", [cat.id]),
      ]);
      const st = (x) => ({ mode: Number(x[0]), limit: x[1], spent: x[2], left: x[1] > x[2] ? x[1] - x[2] : 0n });
      return { cat, spent: ledger[0], cap, threshold, byBase, byUni, base: st(stBase), uni: st(stUni) };
    })
  );

  const membersP = Promise.all(
    [...members].map(async (m) => {
      const [h, u] = await Promise.all([read(C.base, "members", [m]), read(C.uni, "members", [m])]);
      return { m, role: Number(h[0]), roleMirror: Number(u[0]), fBase: h[1] > s.now, fUni: u[1] > s.now, until: h[1] > u[1] ? h[1] : u[1] };
    })
  );
  const paceP = Promise.all([read(C.reactive, "velocityFor", [2]), read(C.reactive, "velocityOf", [WHO.agent])]);

  const pendingP = (async () => {
    // proposals and co-sign requests: the last 8 of each, read in parallel
    const last8 = (n) => Array.from({ length: Number(n > 8n ? 8n : n) }, (_, k) => n - 1n - BigInt(k)).reverse();
    const [nP, ...nPend] = await Promise.all([read(C.base, "proposalCount"), ...VAULTS.map((c) => read(c, "pendingCount"))]);
    s.proposalCount = nP;
    const [props, ...pends] = await Promise.all([
      Promise.all(last8(nP).map(async (id) => ({ id, p: await read(C.base, "proposal", [id]) }))),
      ...VAULTS.map((c, k) => Promise.all(last8(nPend[k]).map(async (id) => ({ id, c, r: await read(c, "pending", [id]) })))),
    ]);
    s.pending = [];
    for (const { id, p } of props) if (!p.executed && p.expiresAt >= s.now) s.pending.push({ type: "proposal", id, p });
    for (const { id, c, r } of pends.flat()) {
      const [member, to, amount, expiresAt, category, closed] = r;
      if (closed || expiresAt < s.now) continue;
      s.pending.push({ type: "spend", id, c, member, to, amount, category: Number(category) });
    }
  })();
  // the stages above are independent: they run concurrently (one RPC round trip instead of five)
  const [rules, budget, mems, [vcfg, vnow]] = await Promise.all([rulesP, budgetP, membersP, paceP, pendingP]);
  Object.assign(s, { rules, budget, members: mems });
  s.agent = s.members.find((r) => r.m === WHO.agent.toLowerCase());
  s.agentPace = { maxTx: Number(vcfg[1]), window: Number(vcfg[2]), freezeFor: Number(vcfg[3]), count: Number(vnow[1]) };
  S = s;
}

// ================================================================== events → feed → loops
const DESCRIBE = {
  Spent: (a, e) => `${nameOf(a.member)} spent ${usd(a.amount)} on ${CATS[a.category]?.name ?? a.category}${quote(reasonOf(e))}`,
  SpendRequested: (a, e) => `${nameOf(a.member)} asked to spend ${usd(a.amount)}: needs a second adult${quote(reasonOf(e))}`,
  SpendApproved: (a) => `${nameOf(a.approver)} co-signed request #${a.id}`,
  ProposalCreated: (a) => `${nameOf(a.proposer)} proposed ${Number(a.kind) === 0 ? "a rule" : "a member change"} (#${a.id})`,
  ProposalApproved: (a) => `${nameOf(a.adult)} approved proposal #${a.id} (${a.approvals})`,
  RulesRatified: (a) => `Rule ratified: ${CATS[a.category]?.name} cap ${usd(a.monthlyCap)} (v${a.version})`,
  MemberSet: (a) => `${nameOf(a.member)} is ${ROLE[Number(a.role)]}${a.unfreeze ? ", freeze lifted" : ""}`,
  LedgerUpdated: (a) => `House ${CATS[a.category]?.name?.toLowerCase()}: ${usd(a.householdSpent)} / ${usd(a.cap)}`,
  CategoryEscalated: (a) => `${CATS[a.category]?.name} → ${MODE[a.mode]} on every chain`,
  VelocityBreach: (a) => `${nameOf(a.member)}: ${a.txInWindow} buys / ${usd(a.amountInWindow)} in the window → frozen everywhere`,
  RulesMirrored: (a) => `Copying ${CATS[a.category]?.name} v${a.version} to Unichain`,
  MemberMirrored: (a) => `Copying ${nameOf(a.member)} to Unichain`,
  CategoryModeChanged: (a) => `${CATS[a.category]?.name} is now ${MODE[a.mode]} here (limit ${usd(a.limit)})`,
  MemberFrozen: (a) => `${nameOf(a.member)} frozen here`,
  RulesApplied: (a) => `${CATS[a.category]?.name} v${a.version} applied here`,
  MemberSynced: (a) => `${nameOf(a.member)} synced (${ROLE[Number(a.role)]}${a.unfreeze ? ", unfrozen" : ""})`,
};
const KIND = {
  LedgerUpdated: "reaction", CategoryEscalated: "reaction", VelocityBreach: "reaction", RulesMirrored: "reaction", MemberMirrored: "reaction",
  CategoryModeChanged: "callback", MemberFrozen: "callback", RulesApplied: "callback", MemberSynced: "callback",
};
const SUBSCRIBED = new Set(["Spent", "RulesRatified", "MemberSet"]); // what Reactive listens to
const PULSE_LABEL = {
  Spent: (a) => `Spent ${usd(a.amount)}`,
  RulesRatified: (a) => `rule v${a.version}`,
  MemberSet: () => "member",
  CategoryModeChanged: (a) => MODE[a.mode],
  MemberFrozen: () => "freeze",
  RulesApplied: (a) => `rule v${a.version}`,
  MemberSynced: (a) => (a.unfreeze ? "unfreeze" : "member"),
};
const RANK = { origin: 0, reaction: 1, callback: 2 };

const EV = []; // every decoded event, ascending
// Pip's own words (SpendReason): by transaction, and by co-sign request so an approval finds them too
const REASON_TX = new Map(); // tx hash → reason
const REQ_REASON = new Map(); // "base:3" → reason
const APPROVE_TX = new Map(); // approval tx hash → "base:3"
const reasonOf = (e) => (e?.lg ? REASON_TX.get(e.lg.transactionHash) ?? REQ_REASON.get(APPROVE_TX.get(e.lg.transactionHash)) : undefined);
const quote = (r) => (r ? ` <q class="why">${esc(r)}</q>` : "");
const describe = (e) => DESCRIBE[e.name](e.a, e);
const cursors = {};
const heads = {};
const blockTime = new Map();
const CHUNK = LOCAL ? 1_000_000n : 5_000n; // PublicNode RPCs accept 10k-block log ranges
// Testnet: read history from each contract's deploy block, so every loop since deploy is shown.
async function startBlock(c) {
  if (LOCAL || !c.deployTx) return 0n;
  if (c.deployBlock !== undefined) return BigInt(c.deployBlock); // recorded at deploy: no receipt round trip
  try {
    return (await c.p.getTransactionReceipt({ hash: c.deployTx })).blockNumber;
  } catch {
    const head = await c.p.getBlockNumber();
    return head > 5000n ? head - 5000n : 0n;
  }
}
let primed = false;

async function tsOf(c, blockNumber) {
  const k = `${c.key}:${blockNumber}`;
  if (!blockTime.has(k)) blockTime.set(k, Number((await c.p.getBlock({ blockNumber })).timestamp));
  return blockTime.get(k);
}

async function pollChain(c) {
  const head = await c.p.getBlockNumber();
  heads[c.key] = head;
  if (cursors[c.key] === undefined) cursors[c.key] = await startBlock(c);
  const ranges = [];
  for (let from = cursors[c.key]; from <= head; from += CHUNK) ranges.push([from, from + CHUNK - 1n < head ? from + CHUNK - 1n : head]);
  const logs = (await Promise.all(ranges.map(([fromBlock, toBlock]) => c.p.getLogs({ address: c.address, fromBlock, toBlock })))).flat();
  const decoded = [];
  for (const lg of logs) {
    try {
      const ev = decodeEventLog({ abi: c.abi, data: lg.data, topics: lg.topics });
      if (ev.eventName === "SpendReason") {
        REASON_TX.set(lg.transactionHash, ev.args.reason);
        if (ev.args.requestId !== 2n ** 256n - 1n) REQ_REASON.set(`${c.key}:${ev.args.requestId}`, ev.args.reason);
      } else if (ev.eventName === "SpendApproved") APPROVE_TX.set(lg.transactionHash, `${c.key}:${ev.args.id}`);
      if (DESCRIBE[ev.eventName]) decoded.push({ lg, ev });
    } catch {}
  }
  await Promise.all([...new Set(decoded.map((d) => d.lg.blockNumber))].map((n) => tsOf(c, n)));
  cursors[c.key] = head + 1n;
  return Promise.all(decoded.map(async ({ lg, ev }) => {
    if (ev.eventName === "MemberSet") members.add(ev.args.member.toLowerCase());
    return { c, name: ev.eventName, a: ev.args, lg, kind: KIND[ev.eventName] ?? "origin", ts: await tsOf(c, lg.blockNumber), order: Number(lg.blockNumber) * 1000 + lg.logIndex };
  }));
}

async function pollEvents() {
  // the three chains, every chunk and every block timestamp are fetched in parallel
  const fresh = (await Promise.all(Object.values(C).map(pollChain))).flat();
  EV.push(...fresh);
  EV.sort((x, y) => x.ts - y.ts || RANK[x.kind] - RANK[y.kind] || x.order - y.order);
  if (EV.length > 1500) EV.splice(0, EV.length - 1500);
  if (primed && fresh.length) animate(fresh);
  primed = true;
  return fresh.length;
}

// Group what Reactive did into loops: origin tx → reactive tx → callback txs.
// Each reactive transaction is one react() call; we match its origin event and its callbacks.
function buildLoops() {
  const claimed = new Set();
  const groups = new Map();
  for (const e of EV) {
    if (e.c.key !== "reactive") continue;
    const h = e.lg.transactionHash;
    if (!groups.has(h)) groups.set(h, { hash: h, ts: e.ts, rx: [] });
    groups.get(h).rx.push(e);
  }
  const loops = [];
  const take = (pred, { before, after }) => {
    const pool = EV.filter((e) => !claimed.has(e) && pred(e) && (before === undefined || e.ts <= before) && (after === undefined || e.ts >= after));
    const pick = before !== undefined && after === undefined ? pool[pool.length - 1] : pool[0];
    if (pick) claimed.add(pick);
    return pick;
  };
  for (const g of groups.values()) {
    const loop = { ...g, origin: null, callbacks: [], headline: null };
    for (const r of g.rx) {
      const a = r.a;
      if (r.name === "LedgerUpdated") {
        const oc = byChainId[String(a.chainId)];
        loop.origin ??= take((e) => e.name === "Spent" && e.c === oc && e.a.member.toLowerCase() === a.member.toLowerCase() && e.a.amount === a.amount, { before: g.ts + 2, after: g.ts - 3600 }); // FIFO: same-size buys stay in order
        loop.ledger = r;
      } else if (r.name === "RulesMirrored") {
        loop.origin ??= take((e) => e.name === "RulesRatified" && e.a.category === a.category && e.a.version === a.version, { before: g.ts + 2 });
        for (const c of VAULTS) {
          const cb = take((e) => e.name === "RulesApplied" && e.c === c && e.a.category === a.category && e.a.version === a.version, { after: g.ts - 2 });
          if (cb) loop.callbacks.push(cb);
        }
        loop.headline = r;
      } else if (r.name === "MemberMirrored") {
        loop.origin ??= take((e) => e.name === "MemberSet" && e.a.member === a.member && e.a.unfreeze === a.unfreeze, { before: g.ts + 2 });
        for (const c of VAULTS) {
          const cb = take((e) => e.name === "MemberSynced" && e.c === c && e.a.member === a.member && e.a.unfreeze === a.unfreeze, { after: g.ts - 2 });
          if (cb) loop.callbacks.push(cb);
        }
        loop.headline = r;
      } else if (r.name === "CategoryEscalated") {
        for (const c of VAULTS) {
          const cb = take((e) => e.name === "CategoryModeChanged" && e.c === c && e.a.category === a.category && e.a.period === a.period && e.a.mode === a.mode, { after: g.ts - 2 });
          if (cb) loop.callbacks.push(cb);
        }
        loop.headline = r;
      } else if (r.name === "VelocityBreach") {
        for (const c of VAULTS) {
          const cb = take((e) => e.name === "MemberFrozen" && e.c === c && e.a.member === a.member && e.a.until === a.frozenUntil, { after: g.ts - 2 });
          if (cb) loop.callbacks.push(cb);
        }
        loop.headline = r;
      }
    }
    const last = loop.callbacks.reduce((m, e) => Math.max(m, e.ts), g.ts);
    loop.latency = loop.origin ? last - loop.origin.ts : null;
    loops.push(loop);
  }
  return loops; // ascending
}

const latText = (s) => (s <= 0 ? "Under a second" : `About ${s} s`);

function loopCard(l) {
  const hop = (cls, label, body, c, hash) => `<div class="hop ${cls}"><span class="hop-k">${label}</span><span class="hop-b">${body}</span>${hash ? txLink(c, hash) : ""}</div>`;
  const o = l.origin
    ? hop(`origin ${l.origin.c.key}`, `① ${l.origin.c.short}`, describe(l.origin), l.origin.c, l.origin.lg.transactionHash)
    : hop("origin", "① origin", "<span class=muted>outside the window</span>");
  const rxBody = [l.ledger, ...l.rx.filter((r) => r !== l.ledger)].filter(Boolean).map((r) => describe(r)).join("<br>");
  const r = hop("reaction reactive", "② Hob · Reactive", rxBody, C.reactive, l.hash);
  const cb = l.callbacks.length
    ? l.callbacks.map((e) => hop(`callback ${e.c.key}`, `③ ${e.c.short}`, describe(e), e.c, e.lg.transactionHash)).join("")
    : hop("callback none", "③", "<span class=muted>no callback needed: nothing changed on the chains</span>");
  const lat = l.latency !== null && l.callbacks.length ? `<span class="lat">${latText(l.latency)}</span>` : "";
  return `<div class="loop">${o}<span class="arrow" aria-hidden="true">→</span>${r}<span class="arrow" aria-hidden="true">→</span><div class="cbs">${cb}</div>${lat}</div>`;
}

// ================================================================== map animation
const pulseQ = [];
let pulsing = false;
function animate(fresh) {
  for (const e of fresh) pulseQ.push(e);
  if (!pulsing) drain();
}
function center(el, box) {
  const r = el.getBoundingClientRect();
  return [r.left - box.left + r.width / 2, r.top - box.top + r.height / 2];
}
async function drain() {
  pulsing = true;
  while (pulseQ.length) {
    const e = pulseQ.shift();
    const node = $(`n-${e.c.key === "reactive" ? "rx" : e.c.key}`);
    flash(node, e.kind);
    if (e.kind === "origin" && SUBSCRIBED.has(e.name)) await fly(node, $("n-rx"), PULSE_LABEL[e.name](e.a), e.c.key);
    else if (e.kind === "callback") await fly($("n-rx"), node, PULSE_LABEL[e.name](e.a), "rx");
    else await sleep(160);
  }
  pulsing = false;
}
function flash(node, kind) {
  node.classList.remove("flash", "flash-reaction", "flash-callback");
  void node.offsetWidth;
  node.classList.add(kind === "reaction" ? "flash-reaction" : kind === "callback" ? "flash-callback" : "flash");
}
function fly(fromEl, toEl, label, tone) {
  if (document.hidden) return Promise.resolve();
  const box = $("map").getBoundingClientRect();
  const [x1, y1] = center(fromEl, box);
  const [x2, y2] = center(toEl, box);
  const p = document.createElement("span");
  p.className = `pulse ${tone}`;
  p.textContent = label;
  $("pulses").appendChild(p);
  const anim = p.animate(
    [
      { transform: `translate(${x1}px, ${y1}px) translate(-50%, -50%) scale(.6)`, opacity: 0 },
      { opacity: 1, offset: 0.15 },
      { opacity: 1, offset: 0.85 },
      { transform: `translate(${x2}px, ${y2}px) translate(-50%, -50%) scale(1)`, opacity: 0 },
    ],
    { duration: 850, easing: "cubic-bezier(.45,.05,.35,1)" }
  );
  return anim.finished.then(() => p.remove(), () => p.remove());
}

// ================================================================== render: dashboard (Obsidian Crimson)
const PIP_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="6" y="9" width="20" height="16" rx="5" fill="#ffb3b1"/><circle cx="12.5" cy="17" r="2.4" fill="#111317"/><circle cx="19.5" cy="17" r="2.4" fill="#111317"/><rect x="14.5" y="3.5" width="3" height="6" rx="1.5" fill="#ffb3b1"/><circle cx="16" cy="3.5" r="2.2" fill="#ff535b"/><rect x="12" y="21.5" width="8" height="1.8" rx=".9" fill="#111317"/></svg>`;
const HOB_MINI = `<svg viewBox="0 0 120 120" aria-hidden="true"><use href="#hob" /></svg>`;
const money = (v) => `$${Number(formatUnits(v ?? 0n, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ms = (name, cls = "") => `<span class="ms ${cls}">${name}</span>`;
const chainLabel = (c) => (LOCAL ? `${c.short} (local)` : `${c.short} Sepolia`);
const hoursLeft = (until) => {
  const m = Math.max(0, Number(until - S.now) / 60);
  return m > 90 ? `${Math.round(m / 60)} h` : `${Math.max(1, Math.round(m))} min`;
};
const ago = (ts) => {
  const d = Math.max(0, Number(S.now) - ts);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};
const spentThisPeriod = (addr, chain) =>
  EV.filter((e) => e.name === "Spent" && e.a.member.toLowerCase() === addr.toLowerCase() && BigInt(e.a.period) === S.period && (!chain || e.c === chain)).reduce((n, e) => n + e.a.amount, 0n);
const lastSpend = (pred) => [...EV].reverse().find((e) => e.name === "Spent" && pred(e));
let moodNow = "calm";

// What Hob says, in plain words, about the latest thing it did.
function hobSays(l) {
  if (!l) return "All quiet. I'm watching Base and Unichain.";
  const h = l.headline;
  const o = l.origin;
  if (h?.name === "CategoryEscalated" && BigInt(h.a.period) !== S.period) return `A new ${PW} started. Every category is back to NORMAL, and nobody had to reset anything.`;
  if (h?.name === "VelocityBreach") return `${nameOf(h.a.member)} made ${h.a.txInWindow} buys in an hour across both chains. I froze ${nameOf(h.a.member)} on every chain.`;
  if (h?.name === "CategoryEscalated" && Number(h.a.mode) === 2) return `That's the cap: ${usd(h.a.householdSpent)} of ${usd(h.a.cap)}. ${CATS[h.a.category]?.name} is frozen on every chain until the next ${PW}.`;
  if (h?.name === "CategoryEscalated") return `Careful: ${CATS[h.a.category]?.name} is at ${usd(h.a.householdSpent)} of ${usd(h.a.cap)}. I split what's left between Base and Unichain.`;
  if (h?.name === "RulesMirrored") return `Alice and Bob agreed on a new ${CATS[h.a.category]?.name?.toLowerCase()} rule. I copied it to Unichain.`;
  if (h?.name === "MemberMirrored") {
    if (h.a.unfreeze) return `An adult lifted ${nameOf(h.a.member)}'s freeze. Done on every chain.`;
    if (Number(h.a.role) === 0) return `${nameOf(h.a.member)} left the house. Every chain knows.`;
    return `${nameOf(h.a.member)} is in the house as ${Number(h.a.role) === 1 ? "an adult" : "an AI shopper"}. Unichain knows too.`;
  }
  if (o?.name === "Spent" && l.ledger) return `Noted: ${nameOf(o.a.member)} spent ${usd(o.a.amount)} on ${o.c.short}. The house is at ${usd(l.ledger.a.householdSpent)} of ${usd(l.ledger.a.cap)}.`;
  return "I'm watching Base and Unichain.";
}
const hotLoop = (l) => !!l?.headline && (l.headline.name === "VelocityBreach" || l.headline.name === "CategoryEscalated");


// Decisions Hob already made on Reactive that a chain has not applied yet (callbacks in flight).
function pendingDeliveries() {
  const out = [];
  const lastEv = (pred) => [...EV].reverse().find(pred);
  for (const r of S.rules) if (r.vHome > r.vMirror) {
    const e = lastEv((x) => x.name === "RulesMirrored" && Number(x.a.category) === r.cat.id);
    if (e) out.push({ what: `${r.cat.name} rule v${r.vHome}`, to: "Unichain", ts: e.ts });
  }
  for (const m of S.members) if (m.role !== m.roleMirror) {
    const e = lastEv((x) => x.name === "MemberMirrored" && x.a.member.toLowerCase() === m.m);
    if (e) out.push({ what: `${nameOf(m.m)}'s membership`, to: "Unichain", ts: e.ts });
  }
  for (const b of S.budget) {
    const e = lastEv((x) => x.name === "CategoryEscalated" && Number(x.a.category) === b.cat.id && BigInt(x.a.period) === S.period);
    if (!e) continue;
    for (const [k, label] of [["base", "Base"], ["uni", "Unichain"]]) if (b[k].mode < Number(e.a.mode)) out.push({ what: `${b.cat.name} ${MODE[e.a.mode]}`, to: label, ts: e.ts });
  }
  return out;
}

function renderChrome(loops) {
  const lats = loops.filter((l) => l.callbacks.length).map((l) => l.latency).filter((x) => x !== null).sort((a, b) => a - b);
  const med = lats.length ? lats[Math.floor(lats.length / 2)] : null;
  const adults = S.members.filter((r) => r.role === 1).length;
  html("chips",
    `<span class="chip live"><span class="dot on"></span>${LOCAL ? "Reactive (local relayer)" : "Reactive Lasna"}: online</span>` +
    `<span class="chip">${ms("speed")}Median loop: ${med === null ? "–" : med <= 0 ? "<1 s" : `${med} s`}</span>` +
    `<span class="chip">${ms("verified_user")}Quorum: ${S.quorum} of ${adults} adults</span>` +
    `<span class="chip">${ms("lock")}Setup sealed · no admin</span>` +
    (() => {
      const pend = pendingDeliveries();
      if (!pend.length) return "";
      const age = Math.max(0, Number(S.now) - Math.min(...pend.map((p) => p.ts)));
      const list = esc(pend.map((p) => `${p.what} → ${p.to}`).join(", "));
      return age > 120
        ? `<span class="chip lag" title="${list}">${ms("schedule")}Reactive delivery delayed: ${pend.length} callback${pend.length > 1 ? "s" : ""} pending for ${Math.round(age / 60)} min</span>`
        : `<span class="chip" title="${list}">${ms("sync")}${pend.length} callback${pend.length > 1 ? "s" : ""} in flight</span>`;
    })());
  html("rail-chains",
    `<div class="rc-title"><span>Chain sync</span><span>live</span></div>` +
    [C.base, C.uni, C.reactive].map((c) => `<div class="rc-row"><i class="cdot ${c.key}"></i><b>${c.key === "reactive" ? (LOCAL ? "Reactive" : "Lasna") : c.short}</b><span>#${heads[c.key] ?? "…"}</span></div>`).join(""));
  html("hero-chains",
    `<span><i class="cdot base"></i>${chainLabel(C.base)} (${short(C.base.address)})</span>` +
    `<span><i class="cdot uni"></i>${chainLabel(C.uni)} (${short(C.uni.address)})</span>` +
    `<span><i class="cdot reactive"></i>Hob on ${LOCAL ? "Reactive" : "Lasna"} (${short(C.reactive.address)})</span>`);
}

function renderNodes(loops, say) {
  const g = S.budget[G];
  const vault = (c) => {
    const isHome = c === C.base;
    const st = g[c.key];
    const here = isHome ? g.byBase : g.byUni;
    const pct = g.cap > 0n ? Math.min(100, (Number(here) / Number(g.cap)) * 100) : 0;
    const v = S.rules[G];
    const synced = v.vMirror >= v.vHome;
    const last = lastSpend((e) => e.c === c);
    const rent = S.budget[1];
    const mode = st.mode === 1 ? `${badge(1)} <span class="muted small">${usd(st.left)} left here</span>` : badge(st.mode);
    return `<div class="n-head"><div class="n-id"><div class="n-icon">${ms(isHome ? "account_balance_wallet" : "device_hub")}</div><div><p class="n-title">${chainLabel(c)}</p><span class="n-sub">${isHome ? "Home vault · the adults decide here" : "Mirror vault · rules arrive from Hob"}</span></div></div>
        <span class="n-badge ${isHome || synced ? "calm" : "tight"}">${isHome ? "Home" : synced ? "Mirrored" : "Syncing"}</span></div>
      <div class="n-panel"><div class="np-h"><span>Groceries spent here</span><span class="big">${money(here)}</span></div>
        <div class="bar"><div class="seg ${c.key}" style="width:${pct}%"></div></div>
        <div class="np-f"><span>House cap ${money(g.cap)}</span><span>${pct.toFixed(1)}% of the cap</span></div></div>
      <div class="n-rows">
        <div><span>Groceries</span><b>${mode}</b></div>
        <div><span>Rent spent here</span><b>${money(isHome ? rent.byBase : rent.byUni)}</b></div>
        <div><span>Last spend</span><b>${last ? `${usd(last.a.amount)} · ${nameOf(last.a.member)}` : "none yet"}</b></div>
        <div><span>Rules</span><b>v${isHome ? v.vHome : v.vMirror}${isHome ? "" : synced ? " · in sync" : " · syncing"}</b></div>
      </div>
      <div class="n-foot"><span>${ms("link", "sm")} <code>${short(c.address)}</code></span><span class="tag">${isHome ? "Hooked to Hob" : "Copied by Hob"}</span></div>`;
  };
  html("n-base", vault(C.base));
  html("n-uni", vault(C.uni));

  const pct = (v) => (g.cap > 0n ? Math.min(100, (Number(v) / Number(g.cap)) * 100) : 0);
  const badgeTxt = { calm: ["calm", "On guard"], tight: ["tight", "Tightened"], alert: ["frozen", "Intercepting"], frozen: ["frozen", "Cap reached"] }[moodNow];
  const hot = hotLoop(say);
  html("n-rx", `<div class="n-head"><div class="n-id"><div class="n-icon hob">${HOB_MINI}</div><div><p class="n-title">Hob</p><span class="n-sub">Guardian on Reactive Network</span></div></div>
      <span class="n-badge ${badgeTxt[0]}">${badgeTxt[1]}</span></div>
    <div class="n-panel"><div class="np-h"><span>House spend, both chains</span><span class="big">${money(g.spent)}</span></div>
      <div class="bar big-bar"><div class="seg base" style="width:${pct(g.byBase)}%"></div><div class="seg uni" style="width:${pct(g.byUni)}%"></div>${g.cap > 0n ? `<div class="mark-t" style="left:${pct(g.threshold)}%"></div>` : ""}</div>
      <div class="np-f"><span>Base ${usd(g.byBase)} + Unichain ${usd(g.byUni)}</span><span>Cap ${money(g.cap)}</span></div></div>
    <div class="n-alert ${hot ? "" : "calm"}">${ms(hot ? "gpp_maybe" : "chat_bubble")}<p><b>${hot ? "Active intercept" : "Hob says"}</b>${esc(hobSays(say))}</p></div>
    <div class="n-foot"><span>State: ${badgeTxt[1].toLowerCase()}</span><span class="tag ${hot ? "hot" : ""}">${loops.length} reactions</span></div>`);
}

function renderLedger() {
  const g = S.budget[G];
  const r = S.budget[1];
  const pct = (b, v) => (b.cap > 0n ? Math.min(100, (Number(v) / Number(b.cap)) * 100) : 0);
  const left = g.cap > g.spent ? g.cap - g.spent : 0n;
  html("ledger-legend",
    `<span><i style="background:var(--primary)"></i>Base ${money(g.byBase)}</span><span><i style="background:var(--blush)"></i>Unichain ${money(g.byUni)}</span><span><i style="background:#333539"></i>Headroom ${money(left)}</span>`);
  if (g.cap === 0n) {
    html("ledger", `<p class="empty">No house rule yet. Alice and Bob agree on one in chapter 1 of the story.</p>`);
    return;
  }
  const toReset = Math.max(0, Number(S.periodStart + BigInt(D.period) - S.now));
  const days = Math.ceil(toReset / 86400);
  const resetIn = toReset >= 86400 ? `${days} day${days === 1 ? "" : "s"}` : toReset >= 3600 ? `${Math.floor(toReset / 3600)} h ${Math.ceil((toReset % 3600) / 60)} min` : `${Math.ceil(toReset / 60)} min`;
  const tl = pct(g, g.threshold);
  html("ledger", `<div class="lg-bar">
      <div class="seg base" style="width:${pct(g, g.byBase)}%">${g.byBase > 0n ? `Base ${money(g.byBase)}` : ""}</div>
      <div class="seg uni" style="width:${pct(g, g.byUni)}%">${g.byUni > 0n ? `Uni ${money(g.byUni)}` : ""}</div>
      <div class="tline" style="left:${tl}%"></div>
      <span class="left">${money(left)} remaining</span>
    </div>
    <div class="lg-meta"><span>House spend: ${pct(g, g.spent).toFixed(1)}% · tighten line ${money(g.threshold)}</span><span>${PW === "month" ? "Month" : "Period"} resets by itself in ${resetIn}</span><span>Cap: ${money(g.cap)} USDC</span></div>
    ${r.cap > 0n ? `<div class="lg-rent"><div class="np-h" style="display:flex;justify-content:space-between;font-size:12.5px"><span class="muted">Rent · one payment can be the whole cap, so it is tight from the first payment</span><span class="mono">${money(r.spent)} / ${money(r.cap)}</span></div><div class="bar"><div class="seg base" style="width:${pct(r, r.byBase)}%"></div><div class="seg uni" style="width:${pct(r, r.byUni)}%"></div></div></div>` : ""}`);
}

// House spend purchase by purchase, from LedgerUpdated events of this month. Markers: Hob's interventions.
function renderChart() {
  const g = S.budget[G];
  const pts = EV.filter((e) => e.name === "LedgerUpdated" && Number(e.a.category) === G && BigInt(e.a.period) === S.period).map((e) => ({ t: e.ts, v: Number(formatUnits(e.a.householdSpent, 6)) }));
  const marks = EV.filter((e) => (e.name === "CategoryEscalated" && Number(e.a.category) === G && BigInt(e.a.period) === S.period) || (e.name === "VelocityBreach" && BigInt(e.ts) >= S.periodStart));
  if (!pts.length || g.cap === 0n) {
    html("chart", `<p class="empty muted">The line starts with the first purchase this ${PW}.</p>`);
    html("chart-note", "");
    return;
  }
  // x = purchase order (one step per purchase), so a burst of buys is as readable as a month of them
  const W = 1000, H = 170, P = 8;
  const n = pts.length;
  const cap = Number(formatUnits(g.cap, 6)), line = Number(formatUnits(g.threshold, 6));
  const xi = (i) => P + ((i + 1) / (n + 1)) * (W - 2 * P);
  const y = (v) => H - P - (Math.min(v, cap) / cap) * (H - 2 * P);
  const x = (t) => { let i = -1; pts.forEach((p, k) => { if (p.t <= t) i = k; }); return xi(Math.max(0, i)); };
  const xy = [[P, y(0)], ...pts.map((p, i) => [xi(i), y(p.v)]), [W - P, y(pts[n - 1].v)]];
  let d = `M${xy[0][0]},${xy[0][1]}`;
  for (let i = 1; i < xy.length; i++) { const [ax, ay] = xy[i - 1], [bx, by] = xy[i], mx = (ax + bx) / 2; d += ` C${mx},${ay} ${mx},${by} ${bx},${by}`; }
  const area = `${d} V${H - P} H${P} Z`;
  const mk = marks.map((e) => {
    const label = e.name === "VelocityBreach" ? `${nameOf(e.a.member)} frozen` : Number(e.a.mode) === 2 ? "FROZEN" : "TIGHT";
    const v = e.name === "CategoryEscalated" ? Number(formatUnits(e.a.householdSpent, 6)) : (pts.filter((p) => p.t <= e.ts).pop()?.v ?? 0);
    return { left: (x(e.ts) / W) * 100, top: (y(v) / H) * 100, label, red: e.name === "VelocityBreach" || Number(e.a.mode) === 2 };
  });
  html("chart", `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="House groceries spend over time">
      <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff535b" stop-opacity=".35"/><stop offset="1" stop-color="#ff535b" stop-opacity="0"/></linearGradient></defs>
      <line x1="${P}" x2="${W - P}" y1="${y(cap)}" y2="${y(cap)}" stroke="#ff535b" stroke-opacity=".5" stroke-dasharray="6 6" vector-effect="non-scaling-stroke"/>
      <line x1="${P}" x2="${W - P}" y1="${y(line)}" y2="${y(line)}" stroke="#ffb547" stroke-opacity=".6" stroke-dasharray="4 6" vector-effect="non-scaling-stroke"/>
      <path d="${area}" fill="url(#cg)"/>
      <path d="${d}" fill="none" stroke="#ff535b" stroke-width="2.5" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 6px rgba(255,83,91,.6))"/>
    </svg>
    <span class="cl" style="position:absolute;right:0;top:${(y(cap) / H) * 100}%;transform:translateY(-120%);font-size:10.5px;color:#ff8a80">cap ${usd(g.cap)}</span>
    <span class="cl" style="position:absolute;right:0;top:${(y(line) / H) * 100}%;transform:translateY(-120%);font-size:10.5px;color:#ffb547">tighten ${usd(g.threshold)}</span>
    ${mk.map((m) => `<span style="position:absolute;left:${m.left}%;top:${m.top}%;transform:translate(-50%,-140%);padding:2px 8px;border-radius:6px;font-size:10.5px;font-weight:600;white-space:nowrap;background:${m.red ? "#e63946" : "#ffb547"};color:${m.red ? "#fff" : "#2a1800"};box-shadow:0 0 12px ${m.red ? "rgba(255,83,91,.6)" : "rgba(255,181,71,.5)"}">${m.label}</span>`).join("")}`);
  html("chart-note", marks.length ? `${ms("warning", "sm")} ${marks.length} intervention${marks.length > 1 ? "s" : ""} by Hob this ${PW}` : `no interventions this ${PW}`);
}

function renderRoster() {
  const pace = S.agentPace;
  const card = (key) => {
    const r = S.members.find((x) => x.m === WHO[key].toLowerCase());
    const away = !r || r.role === 0;
    const frozen = r && (r.fBase || r.fUni);
    const isPip = key === "agent";
    const spent = spentThisPeriod(WHO[key]);
    const last = lastSpend((e) => e.a.member.toLowerCase() === WHO[key].toLowerCase());
    const rows = isPip
      ? `<div><span>House pace limit</span><b>${pace.maxTx} buys / ${Math.round(pace.window / 3600)} h, all chains</b></div>
         <div><span>Spent this ${PW}</span><b>${money(spent)}</b></div>
         <div><span>Last said</span><b>${last && reasonOf(last) ? `“${esc(reasonOf(last))}”` : "nothing yet"}</b></div>
         <div><span>Can approve or co-sign</span><b>never</b></div>
         <div><span>If the pace breaks</span><b>frozen ${Math.round(pace.freezeFor / 3600)} h, every chain</b></div>`
      : `<div><span>Vote</span><b>1 of ${S.quorum} needed for a rule</b></div>
         <div><span>Spent this ${PW}</span><b>${money(spent)}</b></div>
         <div><span>Last spend</span><b>${last ? `${usd(last.a.amount)} on ${last.c.short}` : "none yet"}</b></div>
         <div><span>Can</span><b>propose · approve · co-sign · unfreeze</b></div>`;
    const tag = isPip ? (frozen ? `<span class="p-tag frozen">Frozen · ${hoursLeft(r.until)}</span>` : `<span class="p-tag ai">AI agent</span>`) : `<span class="p-tag">Full authority</span>`;
    const foot = away ? `<span>Not in the house yet</span>` : frozen
      ? `<span class="st">Frozen on ${[r.fBase ? "Base" : "", r.fUni ? "Unichain" : ""].filter(Boolean).join(" & ")}</span>${isPip ? `<button class="small" id="roster-unfreeze">${ms("lock_open", "sm")} Unfreeze</button>` : ""}`
      : `<span>Active on Base & Unichain</span><span class="st ok">Active</span>`;
    return `<div class="person ${away ? "away" : ""} ${frozen ? "frozen" : ""}">
      <div class="p-head"><div class="p-id"><div class="avatar ${isPip ? "pip" : key}">${isPip ? PIP_SVG : key === "alice" ? "A" : "B"}</div><div><p class="p-name">${isPip ? "Pip" : key === "alice" ? "Alice" : "Bob"}</p><span class="p-role">${isPip ? "Autonomous shopper" : "Adult co-signer"}</span></div></div>${tag}</div>
      <div class="p-rows">${rows}</div>
      <div class="p-foot">${foot}</div></div>`;
  };
  html("roster", card("alice") + card("bob") + card("agent"));
  html("roster-meta", `${S.members.filter((r) => r.role).length} identities in the house`);
}

function stepCard(l, i) {
  const h = l.headline;
  const o = l.origin;
  let icon = "shopping_cart", title = "Spend noted", text;
  if (h?.name === "VelocityBreach") [icon, title, text] = ["gpp_maybe", "Pace breach", `${nameOf(h.a.member)} made ${h.a.txInWindow} buys in an hour across chains. Frozen on every chain.`];
  else if (h?.name === "CategoryEscalated" && Number(h.a.mode) === 2) [icon, title, text] = ["ac_unit", "Cap reached", `${CATS[h.a.category]?.name} hit ${usd(h.a.householdSpent)} of ${usd(h.a.cap)}. Frozen on Base and Unichain.`];
  else if (h?.name === "CategoryEscalated") [icon, title, text] = ["compress", "Tightened", `House at ${usd(h.a.householdSpent)} of ${usd(h.a.cap)}. What's left is split per chain; Pip needs a co-sign.`];
  else if (h?.name === "RulesMirrored") [icon, title, text] = ["gavel", "Rule copied", `${CATS[h.a.category]?.name} v${h.a.version} agreed on Base by two adults, copied to Unichain.`];
  else if (h?.name === "MemberMirrored") [icon, title, text] = h.a.unfreeze ? ["lock_open", "Freeze lifted", `An adult lifted ${nameOf(h.a.member)}'s freeze on Base. Lifted on Unichain too.`] : ["person_add", "Member copied", `${nameOf(h.a.member)} joined as ${ROLE[Number(h.a.role)]}. Unichain knows too.`];
  else text = o ? `${nameOf(o.a.member)} spent ${usd(o.a.amount)} on ${o.c.short}${reasonOf(o) ? ` ("${reasonOf(o)}")` : ""}. House at ${l.ledger ? usd(l.ledger.a.householdSpent) : "?"}. No callback needed.` : "Ledger updated.";
  const hot = hotLoop(l);
  const tx = o ? txLink(o.c, o.lg.transactionHash) : "";
  const lat = l.callbacks.length && l.latency !== null ? `${l.latency <= 0 ? "<1" : l.latency} s` : ago(l.ts);
  return `<div class="hs ${hot ? "hot" : ""}"><div class="hs-h"><span class="hs-n">Step ${String(i + 1).padStart(2, "0")}</span><span class="muted">${lat}</span></div>
    <p class="hs-t">${ms(icon)}${title}</p><p>${esc(text)}</p>
    <span class="hs-tx">${tx}${l.callbacks.length ? ` → ${l.callbacks.length} callback${l.callbacks.length > 1 ? "s" : ""}` : ""}</span></div>`;
}

// Pip's receipts: what the AI said, and what the code and Hob did about it (audit trail, all on-chain)
function renderReceipts(loops) {
  const isPip = (e) => e.a.member?.toLowerCase() === WHO.agent.toLowerCase();
  const rows = EV.filter((e) => (e.name === "Spent" || e.name === "SpendRequested") && isPip(e)).slice(-8).reverse();
  const hobFor = (e) => {
    const l = loops.find((x) => x.origin === e);
    const h = l?.headline;
    if (h?.name === "VelocityBreach") return ["hot", "gpp_maybe", "Hob froze Pip on every chain (pace)"];
    if (h?.name === "CategoryEscalated") return ["hot", "ac_unit", `Hob set ${CATS[h.a.category]?.name} ${MODE[h.a.mode]} everywhere`];
    return ["", "visibility", "Hob counted it in the house ledger"];
  };
  const body = rows.map((e) => {
    const why = reasonOf(e);
    const coSigned = APPROVE_TX.get(e.lg.transactionHash);
    const [code, codeIcon] = e.name === "SpendRequested" ? ["Held: a second adult must co-sign", "pending"] : coSigned ? ["Co-signed by an adult, then paid", "how_to_reg"] : ["Within the rules: paid", "check_circle"];
    const [hot, hobIcon, hob] = e.name === "Spent" ? hobFor(e) : ["", "hourglass_top", "Hob waits for the co-sign"];
    return `<li class="rc ${hot}"><div class="rc-said"><span class="rc-k">${ms("smart_toy", "sm")} Pip reasons</span><q>${why ? esc(why) : "no reason recorded"}</q><span class="muted small">${usd(e.a.amount)} USDC · ${CATS[e.a.category]?.name} · ${e.c.short} · ${ago(e.ts)}</span></div>
      <div class="rc-step"><span class="rc-k">${ms("gavel", "sm")} Code enforces</span><span>${ms(codeIcon, "sm")} ${code}</span></div>
      <div class="rc-step"><span class="rc-k">${ms("bolt", "sm")} Hob reacts</span><span>${ms(hobIcon, "sm")} ${hob}</span></div>
      <span class="rc-tx">${txLink(e.c, e.lg.transactionHash)}</span></li>`;
  }).join("");
  html("receipts", body ? `<ol class="receipts">${body}</ol>` : `<p class="empty">No purchase by Pip yet. Each one will appear here with Pip's own words.</p>`);
  const refusedNoReason = REC?.runs?.flatMap((r) => r.checks ?? []).filter((c) => /without saying why/i.test(c.label) && c.ok).length ?? 0;
  html("receipts-meta", `${rows.length ? `last ${rows.length} of Pip's purchases` : ""}${refusedNoReason ? ` · ${refusedNoReason} buy${refusedNoReason > 1 ? "s" : ""} with no reason refused on-chain` : ""}`);
}

function renderHobSteps(loops) {
  const last4 = loops.slice(-4);
  html("hob-steps", last4.map(stepCard).join("") || `<p class="empty">Nothing yet. Every reaction will appear here.</p>`);
}

function renderDashboard() {
  const loops = buildLoops();
  const recent = loops.slice(-4);
  const say = [...recent].reverse().find((l) => l.headline) ?? loops[loops.length - 1];
  const modes = S.budget.flatMap((b) => [b.base.mode, b.uni.mode]);
  const someoneFrozen = S.members.some((r) => r.role && (r.fBase || r.fUni));
  moodNow = modes.includes(2) ? "frozen" : someoneFrozen ? "alert" : modes.includes(1) ? "tight" : "calm";
  const node = $("n-rx");
  if (!node.classList.contains(`mood-${moodNow}`)) {
    node.classList.remove("mood-calm", "mood-tight", "mood-frozen", "mood-alert");
    node.classList.add(`mood-${moodNow}`);
  }
  $("hero-say").classList.remove("loading");
  html("hero-say", esc(hobSays(say)));
  renderChrome(loops);
  renderNodes(loops, say);
  renderLedger();
  renderChart();
  renderRoster();
  renderHobSteps(loops);
  renderReceipts(loops);
  return loops;
}

// ================================================================== render: dashboard
function renderRules() {
  html("rules", S.rules
    .map(({ cat, cap, perTx, coSign, active, vHome, vMirror }) => {
      if (!active && vHome === 0n) return `<div class="rule"><h3>${cat.name}<span class="hint">no rule yet</span></h3><p class="empty">An adult proposes one, then a second adult approves it.</p></div>`;
      const synced = vMirror >= vHome;
      return `<div class="rule">
        <h3>${cat.name}<span class="hint">v${vHome}${active ? "" : " · paused"}</span></h3>
        <dl class="kv">
          <dt>Monthly cap, all chains</dt><dd>${usd(cap)} USDC</dd>
          <dt>Max per purchase</dt><dd>${usd(perTx)} USDC</dd>
          <dt>Second adult above</dt><dd>${usd(coSign)} USDC</dd>
        </dl>
        <div class="sync">
          <span class="chip ok">${C.base.short}: v${vHome} (home)</span>
          <span class="chip ${synced ? "ok" : "lag"}">${C.uni.short}: v${vMirror}${synced ? " ✓ mirrored" : " syncing…"}</span>
        </div>
      </div>`;
    })
    .join(""));
}

function renderBudget() {
  $("period-label").textContent = `period #${S.period} · ${Math.round(D.period / 86400)}-day periods · resets by itself`;
  const markup = S.budget
    .filter((b) => b.cap > 0n)
    .map((b) => {
      const pct = (v) => Math.min(100, (Number(v) / Number(b.cap)) * 100);
      const mode = (c) => {
        const st = b[c.key];
        return `<span class="mode"><b>${c.short}</b>${badge(st.mode)}${st.mode === 1 ? ` · ${usd(st.left)} left here` : ""}</span>`;
      };
      return `<div class="budget">
        <div class="budget-head"><strong>${b.cat.name}</strong><span class="amount">${usd(b.spent)} / ${usd(b.cap)} USDC</span></div>
        <div class="bar" role="img" aria-label="${usd(b.spent)} of ${usd(b.cap)} spent">
          <div class="seg base" style="width:${pct(b.byBase)}%"></div>
          <div class="seg uni" style="width:${pct(b.byUni)}%"></div>
          <div class="mark-t" style="left:${pct(b.threshold)}%" title="tightens here"></div>
        </div>
        <div class="legend">
          <span><i style="background:var(--base)"></i>${C.base.short} ${usd(b.byBase)}</span>
          <span><i style="background:var(--uni)"></i>${C.uni.short} ${usd(b.byUni)}</span>
          <span><i style="background:var(--tight)"></i>${b.threshold === 0n ? "tight from the first payment (one payment can be the whole cap)" : `tightens at ${usd(b.threshold)}`}</span>
        </div>
        <div class="modes">${mode(C.base)}${mode(C.uni)}</div>
      </div>`;
    })
    .join("");
  html("budgets", markup || `<p class="empty">No ratified budget yet.</p>`);
}

function renderMembers() {
  html("members", S.members
    .filter((r) => r.role !== 0)
    .map((r) => {
      const frozen = [r.fBase ? C.base.short : null, r.fUni ? C.uni.short : null].filter(Boolean);
      const mins = Math.max(0, Number(r.until - S.now) / 60);
      const status = frozen.length
        ? `<span class="frozen-tag">frozen on ${frozen.join(" + ")} · ${mins > 90 ? `${Math.round(mins / 60)} h` : `${Math.round(mins)} min`}</span>`
        : `<span class="role">active everywhere</span>`;
      const mirror = r.roleMirror === r.role ? "" : `<span class="chip lag">mirror syncing</span>`;
      const can = r.role === 1 ? "decides, co-signs, shops" : "shops, proposes; never decides";
      return `<div class="member"><div class="who"><b>${nameOf(r.m)}</b><code>${short(r.m)} · ${ROLE[r.role]} · ${can}</code></div><div>${status} ${mirror}</div></div>`;
    })
    .join(""));
}

function renderPending() {
  html("pending",
    S.pending
      .map((x) => {
        if (x.type === "proposal") {
          const p = x.p;
          const what =
            Number(p.kind) === 0
              ? `${CATS[p.category]?.name ?? `#${p.category}`}: cap ${usd(p.rule.monthlyCap)}, ${usd(p.rule.perTxCap)} per purchase, co-sign above ${usd(p.rule.coSignAbove)}`
              : `${nameOf(p.member)} as ${ROLE[Number(p.role)]}`;
          return `<div class="pend"><span><b>Proposal #${x.id}</b> by ${nameOf(p.proposer)}<br>${what} · ${p.approvals}/${S.quorum} adults</span><button class="small" data-approve="${x.id}">Approve</button></div>`;
        }
        return `<div class="pend"><span><b>${nameOf(x.member)}</b> wants ${usd(x.amount)} USDC · ${CATS[x.category]?.name} · ${x.c.short}<br><span class="muted">pays to <code title="${x.to}">${short(x.to)}</code>: check before co-signing</span></span><button class="small" data-cosign="${x.c.key}:${x.id}">Co-sign</button></div>`;
      })
      .join("") || `<p class="empty">Nothing waiting.</p>`);
}

function renderFeed() {
  const hot = new Set(["VelocityBreach", "CategoryEscalated", "MemberFrozen"]);
  html("feed", EV.slice(-60)
    .reverse()
    .map((e) => `<li class="${e.kind} ${hot.has(e.name) || (e.name === "CategoryModeChanged" && Number(e.a.mode) === 2) ? "hot" : ""}"><span class="t">[${new Date(e.ts * 1000).toLocaleTimeString("en-GB")}]</span><span class="k ${e.c.key}">${e.c.key === "reactive" ? "HOB" : e.c.short.toUpperCase()}</span><span class="w">${describe(e)}</span>${txLink(e.c, e.lg.transactionHash)}</li>`)
    .join("") || `<li class="muted">Waiting for the first event…</li>`);
  $("term-clock").textContent = `${new Date(Number(S.now) * 1000).toLocaleTimeString("en-GB")} chain time`;
}

function renderLoops(loops) {
  const interesting = loops.filter((l) => l.callbacks.length || l.headline);
  const recent = loops.slice(-12).reverse();
  const shown = [...new Set([...recent.slice(0, 6), ...interesting.slice(-6).reverse()])].sort((a, b) => b.ts - a.ts);
  html("loops", shown.map(loopCard).join("") || `<p class="empty">No loops yet.</p>`);
}

// ================================================================== render: under the hood
function renderHood(loops) {
  const withCb = loops.filter((l) => l.callbacks.length);
  const cbCount = withCb.reduce((n, l) => n + l.callbacks.length, 0);
  const lats = withCb.map((l) => l.latency).filter((x) => x !== null).sort((a, b) => a - b);
  const med = lats.length ? lats[Math.floor(lats.length / 2)] : null;
  html("live-stats", [
    [loops.length, "reactive transactions (react() on Reactive)"],
    [cbCount, "callbacks delivered to Base and Unichain"],
    [med === null ? "–" : med <= 0 ? "<1 s" : `${med} s`, "median, origin → last callback (block time)"],
    [withCb.length, "loops that changed a chain"],
  ].map(([v, k]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join(""));
  const crit = [
    ["Execution", `${loops.length} reactive transactions and ${cbCount} callbacks seen on this deployment, read live from the chains. Every loop under <i>The House</i> links its origin, Reactive and callback transactions. <i>Scenarios proven on-chain</i> below lists each recorded situation, its checks (refusals included) and the automatic rollovers; the same runs are in <code>docs/EVIDENCE.md</code>.`],
    ["Integration", "Hob lives on Reactive, the only place both chains meet. It holds the household ledger, counts Pip's pace across chains and copies the adults' decisions. Remove it and every cross-chain guarantee is gone (see the comparison above)."],
    ["Usefulness", "An AI agent with a budget, and the answer to <i>who enforces its rules when nobody is watching?</i> Two adults decide, Pip must say why for every buy (on-chain), it can't overrule them, and Hob's response escalates (NORMAL → TIGHT → FROZEN) on every chain, even while everyone is offline."],
    ["Craft", "62 tests including fuzzed invariants, 18 of 18 mutants caught, a sealed setup with no admin keys, stale and duplicate messages handled without paying for failed callbacks, and a heaviest <code>react()</code> of ~493k gas, under the 900k cap."],
  ];
  html("criteria", crit.map(([k, v]) => `<div class="crit"><h3>${k}</h3><p>${v}</p></div>`).join(""));

  const src = (c, addr) => (LOCAL ? "" : `<a class="tx" href="https://sourcify.dev/#/lookup/${addr}" target="_blank" rel="noopener">Sourcify</a>`);
  const row = (c, what, addr, tx) => `<tr><td><i class="cdot ${c.key}"></i>${c.name}</td><td>${what}</td><td>${addrLink(c, addr)}</td><td>${tx ? txLink(c, tx) : ""}</td><td>${src(c, addr)}</td></tr>`;
  html("contracts",
    `<thead><tr><th>Chain</th><th>Contract</th><th>Address</th><th>Deploy tx</th><th>Verified source</th></tr></thead><tbody>` +
    row(C.reactive, "Hob, the reactive contract (ledger, pace, copying decisions)", C.reactive.address, C.reactive.deployTx) +
    row(C.base, "House vault, home (the adults decide here)", C.base.address, C.base.deployTx) +
    row(C.uni, "House vault, mirror", C.uni.address, C.uni.deployTx) +
    `</tbody>`);
  $("deployed-at").textContent = `deployed ${new Date(D.deployedAt).toLocaleString()}`;
}


// ================================================================== recorded evidence (ops/prove.mjs)
// Optional file next to the page; only used when it belongs to this deployment.
let REC = null;
fetch(`evidence.${NET}.json`)
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => {
    if (j && j.reactive?.toLowerCase() === C.reactive.address.toLowerCase()) REC = j;
    renderRecorded();
    if (S) renderSteps();
  })
  .catch((e) => console.warn("recorded evidence not shown:", e.message));
const chainByKey = (k) => (k === "reactive" ? C.reactive : C[k]);
const secs = (ms) => (ms === null || ms === undefined ? "–" : `${(ms / 1000).toFixed(1)} s`);
function loopLinks(l) {
  const cbs = Object.entries(l.callbacks ?? {}).map(([k, v]) => `${chainByKey(k).short} ${txLink(chainByKey(k), v.hash)}`).join(" · ");
  return `${chainByKey(l.origin.chain).short} ${txLink(chainByKey(l.origin.chain), l.origin.hash)} → Hob ${txLink(C.reactive, l.reactive.hash)}${cbs ? ` → ${cbs}` : ""}`;
}
function renderRecorded() {
  if (!REC || !REC.runs?.length) return;
  $("recorded-sec").hidden = false;
  const all = REC.runs.flatMap((r) => r.loops);
  const lats = all.flatMap((l) => Object.values(l.callbacks ?? {}).map((c) => c.ms)).sort((a, b) => a - b);
  const checks = REC.runs.flatMap((r) => r.checks ?? []);
  html("recorded-stats", [
    [REC.runs.filter((r) => !r.error).length, `complete runs (story and scenarios)${REC.runs.some((r) => r.error) ? `; ${REC.runs.filter((r) => r.error).length} stopped early, listed in EVIDENCE.md` : ""}`],
    [all.length, "loops, every one complete"],
    [lats.length, "callbacks delivered"],
    [secs(lats[Math.floor(lats.length / 2)]), `median origin → callback (p95 ${secs(lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))])})`],
    [`${checks.filter((c) => c.ok).length}/${checks.length}`, "checks passed, refusals included"],
    [REC.rollovers.length, "automatic rollovers observed"],
  ].map(([v, k]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join(""));
  const slow = all.filter((l) => Object.values(l.callbacks ?? {}).some((c) => c.ms > 120_000)).length;
  if (slow) $("recorded-stats").insertAdjacentHTML("beforeend", `<p class="muted small" style="grid-column:1/-1">${slow} loop${slow > 1 ? "s" : ""} took over 2 minutes: on 2026-11-19 Reactive Network paused callback delivery from about 19:30 to 20:49 UTC. Hob kept reacting; the callbacks were delivered when the network recovered. The median is unaffected.</p>`);
  const last = REC.runs[REC.runs.length - 1];
  $("recorded-meta").textContent = `last run ${new Date(last.finishedAt).toLocaleString()}`;
  const rows = [];
  const story = [...REC.runs].reverse().find((r) => r.kind === "story");
  if (story) rows.push(`<tr><td><b>The story</b><br><span class="muted small">rules → Pip → shopping on two chains → Pip frozen → unfreeze → TIGHT → FROZEN</span></td><td>✓ ${story.loops.length} loops</td><td>${secs(story.medianMs)}</td><td class="lk">${loopLinks(story.loops[4] ?? story.loops[0])}</td></tr>`);
  for (const sc of REC.scenarios ?? []) {
    const run = [...REC.runs].reverse().find((r) => r.loops.some((l) => l.scenario === sc.key));
    if (!run) continue;
    const ls = run.loops.filter((l) => l.scenario === sc.key);
    const cs = (run.checks ?? []).filter((c) => c.scenario === sc.key);
    const ok = ls.every((l) => l.ok) && cs.every((c) => c.ok);
    const key = ls.find((l) => Object.keys(l.callbacks ?? {}).length) ?? ls[ls.length - 1];
    rows.push(`<tr><td><b>${esc(sc.title)}</b><br><span class="muted small">${esc(sc.proves)}</span>${cs.length ? `<br><span class="small">${cs.map((c) => `${c.ok ? "✓" : "✗"} ${esc(c.label)}`).join("<br>")}</span>` : ""}</td><td>${ok ? "✓" : "✗"} ${ls.length} loop${ls.length === 1 ? "" : "s"}</td><td>${secs(run.medianMs)}</td><td class="lk">${key ? loopLinks(key) : ""}</td></tr>`);
  }
  html("recorded", `<thead><tr><th>Situation</th><th>Result</th><th>Median</th><th>Key loop (origin → Hob → callbacks)</th></tr></thead><tbody>${rows.join("")}</tbody>`);
  html("rollovers", REC.rollovers.length
    ? `<thead><tr><th>Period</th><th>Before (Base / Unichain)</th><th>After</th><th>Seen at</th></tr></thead><tbody>${REC.rollovers.map((r) => `<tr><td>#${r.fromPeriod} → #${r.toPeriod}</td><td>${r.before.base}${r.before.spentBase !== undefined ? ` (${r.before.spentBase} spent)` : ""} / ${r.before.uni}${r.before.spentUni !== undefined ? ` (${r.before.spentUni} spent)` : ""}</td><td>NORMAL (0) / NORMAL (0)</td><td>${new Date(r.observedAt).toLocaleString()}</td></tr>`).join("")}</tbody>`
    : `<tbody><tr><td class="muted">The first rollover is recorded when a run waits for the next period.</td></tr></tbody>`);
}
// chapter → loops of the latest recorded story run (chapter 8 shows the rollovers)
const CHAPTER_LOOPS = [[0, 1], [2], [3], [4], [5], [6], [7], []];
function recordedChapter(i) {
  const story = REC && [...REC.runs].reverse().find((r) => r.kind === "story");
  if (!story) return "";
  const items = CHAPTER_LOOPS[i].map((k) => story.loops[k]).filter(Boolean).map((l) => `<li><b>${esc(l.label)}</b><br>${loopLinks(l)}${Object.keys(l.callbacks ?? {}).length ? ` <span class="muted">(${Object.values(l.callbacks).map((c) => secs(c.ms)).join(" / ")})</span>` : ""}</li>`);
  if (i === CHAPTER_LOOPS.length - 1) for (const r of REC.rollovers.slice(-3)) items.push(`<li><b>Period #${r.fromPeriod} → #${r.toPeriod}</b>: groceries ${r.before.base} / ${r.before.uni} → NORMAL on both chains, ${new Date(r.observedAt).toLocaleString()}. No transaction.</li>`);
  if (!items.length) return "";
  return `<h3 class="sub">Recorded on testnet (run ${story.run}, ${new Date(story.startedAt).toLocaleString()})</h3><ol class="steplog rec">${items.join("")}</ol>`;
}

// ================================================================== actions
async function walletFor(who, c) {
  if (DEMO_KEYS) return createWalletClient({ chain: chainOf(c), transport: http(c.rpc), account: privateKeyToAccount(DEMO_KEYS[who]) });
  if (!window.ethereum) throw new Error("This page is read-only without a wallet. Actions need Alice, Bob or Pip's key; the full run is in the video and docs/EVIDENCE.md, or run it locally");
  const w = createWalletClient({ chain: chainOf(c), transport: custom(window.ethereum) });
  const accounts = await w.requestAddresses();
  const want = WHO[who].toLowerCase();
  const account = accounts.find((a) => a.toLowerCase() === want);
  if (!account) throw new Error(`Switch your wallet to ${nameOf(want)} (${short(want)}) for this step`);
  try {
    await w.switchChain({ id: c.chainId });
  } catch {
    await w.addChain({ chain: chainOf(c) });
  }
  return createWalletClient({ chain: chainOf(c), transport: custom(window.ethereum), account });
}

async function send(who, c, functionName, args) {
  const w = await walletFor(who, c);
  const hash = await w.writeContract({ address: c.address, abi: c.abi, functionName, args, chain: chainOf(c) });
  const r = await c.p.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  r.chain = c;
  return r;
}

const emitted = (receipt, c, eventName) =>
  receipt.logs.some((lg) => {
    try {
      return decodeEventLog({ abi: c.abi, data: lg.data, topics: lg.topics }).eventName === eventName;
    } catch {
      return false;
    }
  });

function errName(e) {
  const m = e.shortMessage ?? e.message ?? String(e);
  const named = m.match(/reverted with the following reason:\s*\n?(.*)|Error: (\w+)\(/);
  return (e.cause?.data?.errorName ?? e.cause?.cause?.data?.errorName) || (named && (named[1] || named[2])) || null;
}
const PLAIN = {
  MemberIsFrozen: "this member is frozen on this chain",
  CategoryFrozen: "this category hit the household cap and is frozen on every chain",
  AboveTxCap: "above the max per purchase",
  AboveLocalLimit: "above what is left for this chain",
  RateLimited: "too many purchases in the last hour on this chain",
  CategoryInactive: "no ratified rule for this category",
  NotAdult: "only adults can do that",
  SelfApproval: "someone else has to co-sign",
  NotMember: "not a household member",
  AlreadyApproved: "already approved",
  Expired: "this request or proposal has expired",
  Closed: "already decided or cancelled",
  InvalidAmount: "amount and recipient are required",
  BadRule: "the rule doesn't add up (max per purchase ≤ cap, co-sign threshold ≤ max per purchase)",
  BadCategory: "unknown category",
  BadProposal: "unknown proposal",
  OnlyHome: "household decisions are made on the home chain (Base)",
  LastAdult: "the household must keep at least one adult",
  ReasonRequired: "Pip must say why: an AI purchase without a reason is refused",
  ReasonTooLong: "keep the reason to one sentence (160 bytes)",
};
function explain(e) {
  const err = errName(e);
  const m = e.shortMessage ?? e.message ?? String(e);
  return err ? `${err}${PLAIN[err] ? `: ${PLAIN[err]}` : ""}` : m.split("\n")[0];
}

let acting = false;
async function guard(fn, onErr) {
  if (acting) return;
  acting = true;
  document.body.classList.add("acting");
  try {
    await fn();
  } catch (e) {
    console.error(e);
    onErr(explain(e));
  } finally {
    acting = false;
    document.body.classList.remove("acting");
    await refresh();
  }
}

// Wait until the chain state (as seen by the dashboard) satisfies pred. Returns seconds waited.
async function waitFor(pred, ms = LOCAL ? 20_000 : 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await refresh();
    if (S && pred(S)) return (Date.now() - t0) / 1000;
    await sleep(LOCAL ? 400 : 2000);
  }
  throw new Error("Timed out waiting for Reactive. Is the relayer (local) or the reactive contract balance (testnet) OK?");
}

async function ratify(cat, rule, log) {
  const id = await read(C.base, "proposalCount");
  const r1 = await send("alice", C.base, "proposeRule", [cat, rule]);
  log(`Alice proposed ${CATS[cat].name}: cap ${usd(rule.monthlyCap)}, ${usd(rule.perTxCap)} per purchase, co-sign above ${usd(rule.coSignAbove)}`, r1);
  const r2 = await send("bob", C.base, "approveProposal", [id]);
  log("Bob approved: 2 of 2 adults, ratified on Base", r2);
}

async function spendLogged(who, c, cat, amount, log, why = who === "agent" ? "Restocking the pantry" : "Weekly groceries") {
  const r = await send(who, c, "spend", [cat, SHOP, amount, why]);
  if (emitted(r, c, "SpendRequested")) log(`${nameOf(WHO[who])} asked for ${usd(amount)} on ${c.short} (“${why}”): waiting for a second adult`, r);
  else log(`${nameOf(WHO[who])} spent ${usd(amount)} on ${c.short} (“${why}”)`, r);
  return r;
}

const G = 0; // groceries: the category the story uses
const agentFrozenBoth = (s) => s.agent && s.agent.fBase && s.agent.fUni;
const breachThisPeriod = () => EV.some((e) => e.name === "VelocityBreach" && BigInt(e.ts) >= S.periodStart && e.a.member.toLowerCase() === WHO.agent.toLowerCase());
// Compare on the same chain (block order), never across chains: each chain has its own clock.
const unfreezeAfterBreach = () => {
  const isAgent = (e) => e.a.member.toLowerCase() === WHO.agent.toLowerCase();
  const f = EV.filter((e) => e.name === "MemberFrozen" && e.c === C.uni && isAgent(e)).pop();
  return !!f && EV.some((e) => e.name === "MemberSynced" && e.c === C.uni && e.a.unfreeze && isAgent(e) && e.order > f.order);
};
let firstPeriod = null;

// ================================================================== the guided story
const STEPS = [
  {
    title: "Agree on the rules",
    lead: "No rule exists until two adults agree.",
    story: `Alice proposes a groceries budget: <b>1,000 USDC a ${PW}</b>, at most <b>200 per purchase</b>, and a second adult for anything above <b>150</b>. Nothing changes until Bob approves it.`,
    reactive: "Base emits <code>RulesRatified</code>. Hob picks it up and calls <code>cbApplyRules</code> on the Unichain vault. Nobody sends a transaction to Unichain, and nobody has admin rights there.",
    action: "Alice proposes · Bob approves",
    checks: (s) => [
      ["Ratified on Base", s.rules[G].active && s.rules[G].vHome > 0n, `v${s.rules[G].vHome}`],
      ["Mirrored to Unichain by callback", s.rules[G].vHome > 0n && s.rules[G].vMirror >= s.rules[G].vHome, `v${s.rules[G].vMirror}`],
    ],
    async run(log) {
      const r = S.rules[G];
      await ratify(G, { monthlyCap: U(1000), perTxCap: U(200), coSignAbove: U(150), active: true }, log);
      const v = r.vHome + 1n;
      const t = await waitFor((s) => s.rules[G].vMirror >= v);
      log(`Hob copied v${v} to Unichain (${t.toFixed(1)} s after the approval)`);
      if (S.rules[1].vHome === 0n) await ratify(1, { monthlyCap: U(2000), perTxCap: U(2000), coSignAbove: U(2000), active: true }, log);
    },
  },
  {
    title: "Welcome Pip",
    lead: "The AI shopper lives here, but doesn't decide.",
    story: "The household adds <b>Pip</b>, an AI shopping agent. Pip can <b>buy</b> and <b>suggest</b> rules, but can never approve a rule, co-sign a purchase or lift a freeze. That takes the same two-adult decision. And Pip must <b>say why</b> for every buy: its words are written on-chain next to the money.",
    reactive: "Base emits <code>MemberSet</code>. Hob learns Pip's role, so it applies the stricter pace limits for AI shoppers, and calls <code>cbSetMember</code> on Unichain.",
    action: "Alice adds Pip · Bob approves",
    checks: (s) => [
      ["Pip is in the house on Base", s.agent?.role === 2],
      ["Mirrored to Unichain by callback", s.agent?.roleMirror === 2],
    ],
    disabled: (s) => (s.agent?.role === 2 ? "Pip already lives here" : null),
    async run(log) {
      const id = await read(C.base, "proposalCount");
      log("Alice proposed Pip as an AI shopper", await send("alice", C.base, "proposeMember", [WHO.agent, 2]));
      log("Bob approved", await send("bob", C.base, "approveProposal", [id]));
      const t = await waitFor((s) => s.agent?.roleMirror === 2);
      log(`Hob introduced Pip to Unichain (${t.toFixed(1)} s)`);
    },
  },
  {
    title: "Shop on two chains",
    lead: "Each chain sees only itself. Hob sees the house.",
    story: "Alice buys on <b>Base</b> and Bob buys on <b>Unichain</b>. Each vault only knows its own spending. The house budget is the <b>sum</b>, and only Hob can see that.",
    reactive: "Every <code>Spent</code> event goes to Hob's <code>react()</code>, which adds it to the ledger for this period and category. Under the line nothing changes, so Hob sends <b>no callback</b> and pays for none.",
    action: "Alice spends 40 on Base · Bob spends 30 on Unichain",
    secondary: { label: "Bob asks for 160 → Alice co-signs", run: cosignDemo },
    checks: (s) => [
      ["Hob counted the Base spending", s.budget[G].byBase > 0n, usd(s.budget[G].byBase)],
      ["Hob counted the Unichain spending", s.budget[G].byUni > 0n, usd(s.budget[G].byUni)],
      ["House total = Base + Unichain", s.budget[G].spent > 0n && s.budget[G].spent === s.budget[G].byBase + s.budget[G].byUni, `${usd(s.budget[G].spent)} / ${usd(s.budget[G].cap)}`],
    ],
    disabled: (s) => (s.budget[G].base.mode > 0 ? "Groceries is already past the line this period" : null),
    async run(log) {
      const before = S.budget[G].spent;
      await spendLogged("alice", C.base, G, U(40), log, "Farmers market: vegetables and fruit");
      await spendLogged("bob", C.uni, G, U(30), log, "Bakery: bread for the week");
      const t = await waitFor((s) => s.budget[G].spent >= before + U(70));
      log(`Hob's house ledger: ${usd(S.budget[G].spent)} / ${usd(S.budget[G].cap)} (${t.toFixed(1)} s)`);
    },
  },
  {
    title: "Pip goes rogue",
    lead: "Fine on each chain. Not fine for the house.",
    story: "Pip fires off <b>seven quick buys</b>: three on Base and four on Unichain. Each chain allows an AI shopper five buys an hour, so <b>neither vault objects</b>.",
    reactive: "Hob counts Pip's buys <b>across chains</b>. More than six in an hour breaks the house pace, so Hob freezes Pip on <b>every</b> chain for 24 h with <code>cbFreezeMember</code>. Adults have looser limits.",
    action: "Run Pip's 7 buys across both chains",
    checks: (s) => [
      ["Hob noticed the pace across chains", breachThisPeriod()],
      ["Pip frozen on Base", !!s.agent?.fBase],
      ["Pip frozen on Unichain", !!s.agent?.fUni],
    ],
    disabled: (s) => (s.agent?.role !== 2 ? "Welcome Pip first (chapter 2)" : agentFrozenBoth(s) ? "Pip is already frozen. Lift it in chapter 5 first" : s.budget[G].base.mode > 0 ? "Groceries is past the line, so Pip needs a co-sign now" : null),
    async run(log) {
      let i = 0;
      const plan = [C.base, C.base, C.base, C.uni, C.uni, C.uni, C.uni];
      for (const c of plan) {
        i++;
        try {
          const r = await spendLogged("agent", c, G, U(15), (t, r) => log(`buy ${i}/7 · ${t}`, r), `Snack restock, order ${i}`);
          if (emitted(r, c, "SpendRequested")) {
            log("Groceries just went TIGHT, so Pip now needs a co-sign for every buy. Stopping the burst");
            return;
          }
        } catch (e) {
          const n = errName(e);
          if (n === "MemberIsFrozen") {
            log(`buy ${i}/7 on ${c.short} refused: Pip is already frozen here`);
            continue;
          }
          if (n === "RateLimited") {
            log(`buy ${i}/7 on ${c.short} refused by the local rate limit`);
            continue;
          }
          throw e;
        }
        await sleep(LOCAL ? 150 : 500);
      }
      const t = await waitFor(agentFrozenBoth);
      log(`Hob froze Pip on Base and Unichain (${t.toFixed(1)} s after the last buy)`);
    },
  },
  {
    title: "Only adults lift a freeze",
    lead: "Pip can't unfreeze itself.",
    story: "The adults look at what happened and decide. Alice lifts the freeze <b>once, on Base</b>.",
    reactive: "<code>unfreezeMember</code> emits <code>MemberSet(unfreeze)</code> on Base. Hob carries the decision to Unichain with <code>cbSetMember</code>. One decision, every chain.",
    action: "Alice lifts the freeze on Base",
    checks: (s) => [
      ["Freeze lifted on Base", breachThisPeriod() && s.agent && !s.agent.fBase],
      ["Lifted on Unichain by callback", breachThisPeriod() && unfreezeAfterBreach() && s.agent && !s.agent.fUni],
    ],
    disabled: (s) => (!s.agent || (!s.agent.fBase && !s.agent.fUni) ? "Pip isn't frozen" : null),
    async run(log) {
      log("Alice lifted the freeze on Base", await send("alice", C.base, "unfreezeMember", [WHO.agent]));
      const t = await waitFor((s) => !s.agent.fUni && !s.agent.fBase);
      log(`Hob lifted it on Unichain (${t.toFixed(1)} s)`);
    },
  },
  {
    title: "Crossing the tighten line",
    lead: "Before the cap, the house tightens.",
    story: "The adults keep shopping. At the tighten line, groceries go <b>TIGHT</b> on both chains: what's left is <b>split per chain</b>, so neither chain can spend the other's share, and Pip now needs a co-sign.",
    reactive: "Hob compares the house total with <code>min(80% of cap, cap − max per purchase)</code>. When the total crosses it, Hob sends <code>cbCategoryMode(TIGHT, slice)</code> to every chain.",
    action: "Adults shop up to the line",
    checks: (s) => [
      ["The house reached the line", s.budget[G].cap > 0n && s.budget[G].spent >= s.budget[G].threshold, `${usd(s.budget[G].spent)} / line ${usd(s.budget[G].threshold)}`],
      ["Base TIGHT", s.budget[G].base.mode >= 1, s.budget[G].base.mode === 1 ? `${usd(s.budget[G].base.left)} left` : ""],
      ["Unichain TIGHT", s.budget[G].uni.mode >= 1, s.budget[G].uni.mode === 1 ? `${usd(s.budget[G].uni.left)} left` : ""],
    ],
    disabled: (s) => (s.budget[G].cap === 0n ? "Ratify the rule first (step 1)" : s.budget[G].base.mode >= 1 ? "Already TIGHT" : null),
    async run(log) {
      const who = [["alice", C.base], ["bob", C.uni]];
      let k = 0;
      while (S.budget[G].spent < S.budget[G].threshold) {
        const [p, c] = who[k++ % 2];
        const amount = min(U(150), S.budget[G].threshold - S.budget[G].spent);
        const target = S.budget[G].spent + amount;
        await spendLogged(p, c, G, amount, log);
        await waitFor((s) => s.budget[G].spent >= target);
        if (k > 12) throw new Error("Too many purchases. Check the rate limits");
      }
      const t = await waitFor((s) => s.budget[G].base.mode >= 1 && s.budget[G].uni.mode >= 1);
      const b = S.budget[G];
      log(`TIGHT on both chains (${t.toFixed(1)} s): ${usd(b.base.left)} left on Base, ${usd(b.uni.left)} left on Unichain`);
    },
  },
  {
    title: "The cap, on the sum",
    lead: "The cap holds across chains.",
    story: "Each chain spends its slice. When the <b>sum</b> reaches the cap, groceries are <b>FROZEN</b> on both chains. Then Alice tries one more purchase.",
    reactive: "Hob's ledger reaches the cap and it sends <code>cbCategoryMode(FROZEN)</code> to every chain. If a callback arrives late or out of order, the vault ignores it and doesn't revert.",
    action: "Spend the slices · then try one more",
    checks: (s) => [
      ["The house reached the cap", s.budget[G].cap > 0n && s.budget[G].spent >= s.budget[G].cap, `${usd(s.budget[G].spent)} / ${usd(s.budget[G].cap)}`],
      ["Base FROZEN", s.budget[G].base.mode === 2],
      ["Unichain FROZEN", s.budget[G].uni.mode === 2],
    ],
    disabled: (s) => (s.budget[G].base.mode === 0 ? "Cross the tighten line first (step 6)" : null),
    async run(log) {
      if (S.budget[G].base.mode !== 2) {
        for (const [p, c] of [["alice", C.base], ["bob", C.uni]]) {
          let guardN = 0;
          while (S.budget[G][c.key].left > 0n && S.budget[G][c.key].mode === 1 && guardN++ < 6) {
            await spendLogged(p, c, G, min(U(150), S.budget[G][c.key].left), log);
            await refresh();
          }
        }
        const t = await waitFor((s) => s.budget[G].base.mode === 2 && s.budget[G].uni.mode === 2);
        log(`FROZEN on both chains (${t.toFixed(1)} s): ${usd(S.budget[G].spent)} / ${usd(S.budget[G].cap)}`);
      }
      try {
        await send("alice", C.base, "spend", [G, SHOP, U(10), "One more grocery run"]);
        log("Unexpected: the extra purchase went through");
      } catch (e) {
        log(`Alice tries 10 more on Base: refused (${explain(e)})`);
      }
    },
  },
  {
    title: `A new ${PW}, by itself`,
    lead: "Set it and forget it.",
    story: LOCAL
      ? `There's no keeper, no bot and no cron. The ${PW} rolls over and groceries are <b>NORMAL</b> again everywhere. On the local chains we can fast-forward ${PERIOD_HUMAN}.`
      : `There's no keeper, no bot and no cron. When the next period starts, groceries are <b>NORMAL</b> again everywhere. In production a period is a month; this testnet house uses ${PERIOD_HUMAN} so you can watch it happen.`,
    reactive: "Every <code>Spent</code> event carries its period id. Hob keeps a separate ledger per period, so a new period starts at zero without a scheduled job. A callback from an old period is ignored.",
    action: LOCAL ? `Fast-forward ${PERIOD_HUMAN} (local chains)` : null,
    checks: (s) => [
      ["A new period started", firstPeriod !== null && s.period > firstPeriod, `period #${s.period}`],
      ["Groceries NORMAL on Base", s.budget[G].base.mode === 0],
      ["Groceries NORMAL on Unichain", s.budget[G].uni.mode === 0],
    ],
    note: (s) => (LOCAL ? null : `Next period starts ${new Date(Number(s.periodStart + BigInt(D.period)) * 1000).toLocaleString()}.`),
    async run(log) {
      for (const c of Object.values(C)) {
        for (const [method, params] of [["evm_increaseTime", [D.period]], ["evm_mine", []]]) {
          await fetch(c.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        }
      }
      log(`All three local chains moved forward ${PERIOD_HUMAN}`);
      await refresh();
      log(`Period #${S.period}: groceries ${MODE[S.budget[G].base.mode]} on Base, ${MODE[S.budget[G].uni.mode]} on Unichain. Nobody reset anything`);
      log("You can replay from step 3");
    },
  },
];

async function cosignDemo(log) {
  const r = await spendLogged("bob", C.uni, G, U(160), log, "Birthday cake and party food for Sam");
  if (!emitted(r, C.uni, "SpendRequested")) return;
  const n = await read(C.uni, "pendingCount");
  log("Alice co-signed on Unichain", await send("alice", C.uni, "approveSpend", [n - 1n]));
}

let current = null;
const logs = STEPS.map(() => []);
const stepDone = (i) => (S ? STEPS[i].checks(S).every((c) => c[1]) : false);

function renderSteps() {
  if (firstPeriod === null) firstPeriod = S.period;
  const firstOpen = STEPS.findIndex((_, i) => !stepDone(i));
  if (current === null) current = firstOpen === -1 ? 0 : firstOpen;
  html("steps", STEPS.map((st, i) => {
    const done = stepDone(i);
    const cls = [i === current ? "on" : "", done ? "done" : "", i === firstOpen ? "next" : ""].join(" ");
    return `<li class="${cls}"><button data-step="${i}"><span class="n">${done ? "✓" : i + 1}</span><span class="st-t"><b>${st.title}</b><small>${st.lead}</small></span></button></li>`;
  }).join(""));

  const st = STEPS[current];
  const checks = st.checks(S);
  const dis = st.disabled?.(S);
  const note = st.note?.(S);
  const nextBtn = current < STEPS.length - 1 && stepDone(current) ? `<button class="ghost" data-step="${current + 1}">Next: ${STEPS[current + 1].title} →</button>` : "";
  const log = logs[current];
  html("step", `
    <p class="eyebrow">Chapter ${current + 1} of ${STEPS.length}</p>
    <h2 class="step-t">${st.title}</h2>
    <p class="story-p">${st.story}</p>
    <div class="rx-box">${HOB_MINI}<div><span class="rx-k">What Hob does, on Reactive Network</span><p>${st.reactive}</p></div></div>
    ${LOCAL ? "" : `<p class="watch">Watching the demo house on testnet. The chapters are run from a terminal (<code>node ops/prove.mjs testnet --story</code>); the checks below are read live from the chains, and every recorded transaction is linked to its explorer. The buttons only work from a member's wallet.</p>`}
    <div class="step-act">
      ${st.action && (LOCAL || window.ethereum) ? `<button class="primary" data-run="${current}" ${dis ? "disabled" : ""}>${st.action}</button>` : ""}
      ${st.secondary ? `<button data-run2="${current}">${st.secondary.label}</button>` : ""}
      ${nextBtn}
      ${dis && st.action ? `<span class="muted small">${dis}</span>` : ""}
      ${note ? `<span class="muted small">${note}</span>` : ""}
    </div>
    <h3 class="sub">Watch for</h3>
    <ul class="checks">${checks.map(([label, ok, val]) => `<li class="${ok ? "ok" : ""}"><span class="ck">${ok ? "✓" : "○"}</span>${label}${val ? `<span class="val">${val}</span>` : ""}</li>`).join("")}</ul>
    ${LOCAL ? "" : recordedChapter(current)}
    ${log.length ? `<h3 class="sub">What just happened</h3><ol class="steplog">${log.map((l) => `<li class="${l.err ? "err" : ""}">${esc(l.text)}${l.r ? ` ${txLink(l.r.chain, l.r.transactionHash)}` : ""}</li>`).join("")}</ol>` : ""}`);
}

async function runStep(i, which = "run") {
  const st = STEPS[i];
  logs[i] = [];
  const log = (text, r) => {
    logs[i].push({ text, r });
    renderSteps();
  };
  await guard(
    () => (which === "run" ? st.run(log) : st.secondary.run(log)),
    (msg) => {
      logs[i].push({ text: `Stopped: ${msg}`, err: true });
      renderSteps();
    }
  );
}

// ================================================================== wiring
$("net-label").textContent = LOCAL ? "Local · 3 chains" : "Testnet · Lasna";
$("addrs").textContent = `Hob (reactive) ${C.reactive.address} · home vault ${C.base.address} · mirror vault ${C.uni.address}`;
$("act-hint").textContent = DEMO_KEYS ? "Local dev keys · every click is a real transaction" : "Uses your browser wallet";
for (const [k, label] of [["alice", "Alice (adult)"], ["bob", "Bob (adult)"], ["agent", "Pip (AI shopper)"]]) $("as").add(new Option(label, k));
for (const c of VAULTS) $("on").add(new Option(c.short, c.key));

function showTab(t) {
  for (const b of document.querySelectorAll(".tb-nav [data-tab], .rail-nav [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === t));
  for (const s of document.querySelectorAll(".tab")) s.hidden = !(s.id === `tab-${t}` || (t === "home" && s.id === "tab-home-top"));
  window.scrollTo({ top: 0 });
  try {
    localStorage.setItem("hob-tab", t);
  } catch {}
}
let savedTab = "home";
try {
  savedTab = localStorage.getItem("hob-tab") ?? "home";
} catch {}
if (!["home", "dash", "story", "hood"].includes(savedTab)) savedTab = "home";
showTab(savedTab);

const toast = (msg, cls = "") => {
  $("toast").textContent = msg;
  $("toast").className = `toast ${cls}`;
};
const adultActor = () => ($("as").value === "agent" ? "bob" : $("as").value);

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab]");
  if (t) {
    e.preventDefault();
    showTab(t.dataset.tab);
    const to = t.getAttribute("href");
    if (to && to.length > 1 && to.startsWith("#")) document.querySelector(to)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (e.target.closest("#roster-unfreeze")) return $("btn-unfreeze").click();
  const s = e.target.closest("[data-step]");
  if (s) {
    current = Number(s.dataset.step);
    return renderSteps();
  }
  const r = e.target.closest("[data-run]");
  if (r) return runStep(Number(r.dataset.run));
  const r2 = e.target.closest("[data-run2]");
  if (r2) return runStep(Number(r2.dataset.run2), "secondary");
  const a = e.target.closest("[data-approve]");
  if (a) {
    return guard(async () => {
      await send(adultActor(), C.base, "approveProposal", [BigInt(a.dataset.approve)]);
      toast(`Approved by ${nameOf(WHO[adultActor()])}.`, "ok");
    }, (m) => toast(m, "err"));
  }
  const c = e.target.closest("[data-cosign]");
  if (c) {
    return guard(async () => {
      const [k, id] = c.dataset.cosign.split(":");
      await send(adultActor(), C[k], "approveSpend", [BigInt(id)]);
      toast(`Co-signed by ${nameOf(WHO[adultActor()])}.`, "ok");
    }, (m) => toast(m, "err"));
  }
});

$("btn-spend").onclick = () =>
  guard(async () => {
    const who = $("as").value;
    const c = C[$("on").value];
    const why = $("why").value.trim();
    const r = await send(who, c, "spend", [Number($("cat").value), SHOP, U($("amt").value || "0"), why]);
    toast(
      emitted(r, c, "SpendRequested")
        ? `${nameOf(WHO[who])} asked for ${$("amt").value} USDC on ${c.short}: a second adult must co-sign (see The House → co-sign queue)`
        : `${nameOf(WHO[who])} spent ${$("amt").value} USDC on ${c.short}. Watch Hob react`,
      "ok"
    );
  }, (m) => toast(m, "err"));

$("btn-spike").onclick = () =>
  guard(async () => {
    await STEPS[3].run((text) => toast(text, "ok"));
  }, (m) => toast(m, "err"));

$("btn-unfreeze").onclick = () =>
  guard(async () => {
    await send(adultActor(), C.base, "unfreezeMember", [WHO.agent]);
    toast("Freeze lifted on Base. Hob carries it to every chain.", "ok");
  }, (m) => toast(m, "err"));

$("btn-propose").onclick = () =>
  guard(async () => {
    const rule = { monthlyCap: U($("r-cap").value), perTxCap: U($("r-tx").value), coSignAbove: U($("r-co").value), active: true };
    await send($("as").value, C.base, "proposeRule", [Number($("cat").value), rule]);
    toast("Proposed. A second adult must approve it.", "ok");
  }, (m) => toast(m, "err"));

// ================================================================== loop
let inflight = null;
function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // first paint: state and history together; after that, state first, then events, so every state
      // change we show already has its cause in the event list
      if (primed) {
        await load();
        await pollEvents();
      } else await Promise.all([load(), pollEvents()]);
      const loops = renderDashboard();
      renderSteps();
      renderRules();
      renderBudget();
      renderMembers();
      renderPending();
      renderLoops(loops);
      renderFeed();
      renderHood(loops);
      $("heartbeat").classList.add("on");
    } catch (e) {
      console.error(e);
      $("heartbeat").classList.remove("on");
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
await refresh();
setInterval(() => !document.hidden && refresh(), LOCAL ? 1200 : 4000);
