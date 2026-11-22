// "How it works": every entity in Hob and every interaction between them, drawn once.
// The wires light up with real on-chain events (app.js sends "hob:events"), and the entity
// cards read live facts (app.js sends "hob:state" after every refresh).
import { icon } from "./icons.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

const PIP = (cls = "") => `<svg viewBox="0 0 120 120" class="pipfig ${cls}" aria-hidden="true"><use href="#pip" /></svg>`;
const HOB = `<svg viewBox="0 0 120 120" class="hobfig" aria-hidden="true"><use href="#hob" /></svg>`;

// ---------------------------------------------------------------- entities
const NODES = {
  alice: {
    col: "people", fig: `<span class="fl-av">A</span>`, title: "Alice", sub: "Adult · co-signer",
    about: "One of the two adults. She proposes and approves the household's rules, members and unfreezes, and she spends from either vault.",
    can: ["Propose and approve rules and members (on Base)", "Co-sign a purchase above the line", "Lift a freeze, once, for every chain", "Spend on Base or Unichain"],
    cannot: ["Change a rule or a member alone: the other adult must approve"],
  },
  bob: {
    col: "people", fig: `<span class="fl-av bob">B</span>`, title: "Bob", sub: "Adult · co-signer",
    about: "The other adult. Nothing the household agrees on exists until both adults have signed it.",
    can: ["Propose and approve rules and members (on Base)", "Co-sign a purchase above the line", "Lift a freeze, once, for every chain", "Spend on Base or Unichain"],
    cannot: ["Change a rule or a member alone: the other adult must approve"],
  },
  pip: {
    col: "people", fig: PIP(), title: "Pip", sub: "AI shopper",
    about: "The household's AI agent. Pip reasons about what to buy and writes why, on-chain, in the same transaction as the money.",
    can: ["Spend on Base or Unichain, with a reason (SpendReason)", "Propose a rule"],
    cannot: ["Buy without a reason (ReasonRequired)", "Approve, co-sign or unfreeze anything", "Go past 6 buys an hour across both chains: Hob freezes it everywhere"],
  },
  base: {
    col: "chains", fig: icon("vault", "fl-ic"), title: "HobVault", sub: "Base Sepolia · home",
    about: "The home vault. The adults govern here, and anyone in the house can spend here. It enforces every rule it can check on its own, synchronously, on each purchase.",
    can: ["Hold the rules the adults ratified (quorum 2 of 2)", "Check each purchase: cap per purchase, co-sign line, pace per role, this chain's slice, Pip's reason", "Emit Spent, RulesRatified and MemberSet"],
    cannot: ["See what was spent on Unichain"],
  },
  uni: {
    col: "chains", fig: icon("mirror", "fl-ic"), title: "HobVault", sub: "Unichain Sepolia · mirror",
    about: "The mirror vault. It enforces the same rules as Base, but it has no admin: rules and members only arrive here through Hob's callbacks.",
    can: ["Check each purchase locally, like Base", "Emit Spent"],
    cannot: ["See what was spent on Base", "Be changed by anyone but Hob, through Reactive Network"],
  },
  hob: {
    col: "rx", fig: HOB, title: "Hob", sub: "HobReactive · Reactive Network (Lasna)",
    about: "The guardian. A reactive contract that watches both vaults, remembers the whole house, and writes back to every chain by itself. No bot, no keeper, no cron.",
    can: ["Keep one ledger per period and category, summed across chains", "Count each member's pace across chains", "Tighten (TIGHT + slice per chain), freeze a category (FROZEN), freeze a member everywhere", "Copy rules and members to Unichain", "Start each new period by itself"],
    cannot: ["Be stopped by anyone going offline: it runs on Reactive Network"],
  },
};

// ---------------------------------------------------------------- interactions
// k: legend item; t: wire style
const EDGES = [
  { id: "gov-alice", from: "alice", to: "base", k: 1, t: "gov" },
  { id: "gov-bob", from: "bob", to: "base", k: 1, t: "gov" },
  { id: "prop-pip", from: "pip", to: "base", k: 2, t: "prop" },
  { id: "sp-alice-base", from: "alice", to: "base", k: 3, t: "spend" },
  { id: "sp-alice-uni", from: "alice", to: "uni", k: 3, t: "spend" },
  { id: "sp-bob-base", from: "bob", to: "base", k: 3, t: "spend" },
  { id: "sp-bob-uni", from: "bob", to: "uni", k: 3, t: "spend" },
  { id: "sp-pip-base", from: "pip", to: "base", k: 3, t: "spend" },
  { id: "sp-pip-uni", from: "pip", to: "uni", k: 3, t: "spend" },
  { id: "ev-base", from: "base", to: "hob", k: 4, t: "event" },
  { id: "ev-uni", from: "uni", to: "hob", k: 4, t: "event" },
  { id: "cb-base", from: "hob", to: "base", k: 6, t: "callback" },
  { id: "cb-uni", from: "hob", to: "uni", k: 6, t: "callback" },
];
const LEGEND = [
  { k: 1, t: "gov", title: "The adults govern", text: "Rules and members need both adults: one proposes, the other approves (2 of 2). Lifting a freeze takes one adult. All of it happens once, on Base.", code: "proposeRule · proposeMember · approveProposal · unfreezeMember" },
  { k: 2, t: "prop", title: "Pip may only propose", text: "Pip can suggest a rule. The vault refuses it any approval, co-sign or unfreeze.", code: "proposeRule" },
  { k: 3, t: "spend", title: "Anyone spends, Pip says why", text: "Each purchase goes to one vault, which checks it on the spot. A purchase by Pip must carry its reason in the same transaction, or it is refused.", code: "spend(category, to, amount, reason) → Spent + SpendReason" },
  { k: 4, t: "event", title: "Reactive Network delivers the events", text: "Hob subscribes to Spent on both vaults, and to RulesRatified and MemberSet on Base. Nobody relays them: Reactive Network does.", code: "Spent · RulesRatified · MemberSet" },
  { k: 5, t: "hob", node: "hob", title: "Hob remembers and decides", text: "One ledger per period and category, summed across chains; each member's pace across chains. Hob reacts only when a chain must change.", code: "react() → LedgerUpdated · CategoryEscalated · VelocityBreach" },
  { k: 6, t: "callback", title: "Callbacks to every chain", text: "Hob's decisions travel back as callbacks. A vault accepts them only from Reactive Network's callback proxy, sent on Hob's behalf.", code: "cbCategoryMode · cbFreezeMember · cbApplyRules · cbSetMember" },
  { k: 7, t: "event", node: "hob", title: "A new period, by itself", text: "No transaction resets anything. The period id travels inside every Spent event, so the first purchase of a new period starts it fresh on every chain.", code: "Spent.period" },
];

// guided replays of three real loops (the same loops the Story chapters record on-chain)
const REPLAYS = {
  pace: {
    label: "Pip's 7th buy",
    steps: [
      { edges: ["sp-pip-base"], cap: "Pip buys three times on Base. Each buy carries Pip's reason; the vault sees nothing wrong." },
      { edges: ["sp-pip-uni"], cap: "Then four times on Unichain. Each vault allows 5 an hour, so neither objects." },
      { edges: ["ev-base", "ev-uni"], cap: "Every Spent reaches Hob through Reactive Network." },
      { node: "hob", cap: "Hob counts 7 buys in an hour across both chains. Pip's pace is 6." },
      { edges: ["cb-base", "cb-uni"], freezePip: true, cap: "Hob sends cbFreezeMember to both vaults: Pip is frozen on every chain." },
      { edges: ["gov-alice"], unfreezePip: true, cap: "Only an adult can lift it: Alice decides once, on Base, and Hob carries it everywhere." },
    ],
  },
  rule: {
    label: "A new rule",
    steps: [
      { edges: ["gov-alice"], cap: "Alice proposes a groceries budget on Base." },
      { edges: ["gov-bob"], cap: "Bob approves: 2 of 2. The rule is live on Base." },
      { edges: ["ev-base"], cap: "Base emits RulesRatified; Reactive Network delivers it to Hob." },
      { edges: ["cb-uni"], cap: "Hob calls cbApplyRules on Unichain. Nobody holds admin rights there." },
    ],
  },
  cap: {
    label: "The tighten line",
    steps: [
      { edges: ["sp-alice-base", "sp-bob-uni"], cap: "Alice shops on Base, Bob on Unichain. Neither vault can see the other." },
      { edges: ["ev-base", "ev-uni"], cap: "Both Spent events reach Hob." },
      { node: "hob", cap: "Hob sums both chains. The house crosses 80% of the cap." },
      { edges: ["cb-base", "cb-uni"], cap: "cbCategoryMode(TIGHT): what's left is split per chain, and Pip now needs a co-sign." },
    ],
  },
};

// ---------------------------------------------------------------- render
let state = null;
let selected = "hob";
let built = false;

function nodeHtml(id) {
  const n = NODES[id];
  return `<button class="fl-node fl-${id}" id="fln-${id}" data-node="${id}" type="button"><span class="fl-fig">${n.fig}</span><span class="fl-txt"><b>${n.title}</b><small>${n.sub}</small><em class="fl-live" id="fll-${id}"></em></span></button>`;
}

function build() {
  const root = $("flow-root");
  if (!root || built) return;
  built = true;
  root.innerHTML = `
    <div class="fl-stage" id="fl-stage">
      <svg class="fl-wires" id="fl-wires" aria-hidden="true"></svg>
      <div class="fl-col fl-col-people"><span class="fl-colk">// The household</span>${["alice", "bob", "pip"].map(nodeHtml).join("")}</div>
      <div class="fl-col fl-col-chains"><span class="fl-colk">// Two chains · two vaults</span>${["base", "uni"].map(nodeHtml).join("")}</div>
      <div class="fl-col fl-col-rx"><span class="fl-colk">// Reactive Network</span>${nodeHtml("hob")}</div>
      <div class="fl-badges" id="fl-badges"></div>
    </div>
    <div class="fl-bar">
      <span class="fl-k">Replay a loop</span>
      ${Object.entries(REPLAYS).map(([k, r]) => `<button class="btn ghost-hud" type="button" data-replay="${k}">${icon("play")}${r.label}</button>`).join("")}
      <p class="fl-cap" id="fl-cap" aria-live="polite">Click any entity or interaction. The wires light up by themselves when a real transaction lands.</p>
    </div>
    <div class="fl-bottom">
      <ol class="fl-legend" id="fl-legend">${LEGEND.map((l) => `<li data-k="${l.k}" tabindex="0"><span class="fl-n t-${l.t}">${l.k}</span><div><b>${l.title}</b><p>${l.text}</p><code>${l.code}</code></div></li>`).join("")}</ol>
      <aside class="fl-panel" id="fl-panel"></aside>
    </div>`;
  root.addEventListener("click", onClick);
  root.addEventListener("mouseover", (e) => { const li = e.target.closest("#fl-legend li"); if (li) focusK(Number(li.dataset.k)); });
  root.addEventListener("mouseout", (e) => { if (e.target.closest("#fl-legend li") && !e.relatedTarget?.closest?.("#fl-legend li")) focusK(null); });
  root.addEventListener("focusin", (e) => { const li = e.target.closest("#fl-legend li"); if (li) focusK(Number(li.dataset.k)); });
  new ResizeObserver(() => wire()).observe($("fl-stage"));
  panel();
  wire();
}

function onClick(e) {
  const n = e.target.closest("[data-node]");
  if (n) { selected = n.dataset.node; panel(); markSelected(); return; }
  const r = e.target.closest("[data-replay]");
  if (r) { replay(r.dataset.replay); return; }
  const li = e.target.closest("#fl-legend li");
  if (li) { const l = LEGEND.find((x) => x.k === Number(li.dataset.k)); caption(`${l.k}. ${l.title}: ${l.text}`); pulseK(l.k); }
  const b = e.target.closest("[data-badge]");
  if (b) { const l = LEGEND.find((x) => x.k === Number(b.dataset.badge)); caption(`${l.k}. ${l.title}: ${l.text}`); pulseK(l.k); }
}

function markSelected() {
  for (const el of document.querySelectorAll(".fl-node")) el.classList.toggle("sel", el.dataset.node === selected);
}

// ---------------------------------------------------------------- wires
function anchor(r, side) {
  return side === "r" ? [r.right, r.top + r.height / 2] : side === "l" ? [r.left, r.top + r.height / 2] : side === "b" ? [r.left + r.width / 2, r.bottom] : [r.left + r.width / 2, r.top];
}
function wire() {
  const stage = $("fl-stage"), svg = $("fl-wires");
  if (!stage || stage.offsetParent === null) return;
  const box = stage.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  const rect = (id) => { const r = $(`fln-${id}`).getBoundingClientRect(); return { left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top, width: r.width, height: r.height }; };
  const peopleIdx = { alice: -1, bob: 0, pip: 1 };
  let paths = "";
  const mids = {};
  for (const e of EDGES) {
    const a = rect(e.from), b = rect(e.to);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const horiz = Math.abs(dx) > Math.abs(dy) * 0.9;
    let [x1, y1] = anchor(a, horiz ? (dx > 0 ? "r" : "l") : dy > 0 ? "b" : "t");
    let [x2, y2] = anchor(b, horiz ? (dx > 0 ? "l" : "r") : dy > 0 ? "t" : "b");
    // spread wires that share an end so they stay readable
    let o1 = 0, o2 = 0;
    if (e.t === "gov" || e.t === "prop") { o1 = -7; o2 = -14 + peopleIdx[e.from] * 5; }
    else if (e.t === "spend") { o1 = 7; o2 = 12 + peopleIdx[e.from] * 9; }
    else if (e.t === "event") { o1 = o2 = -9; }
    else if (e.t === "callback") { o1 = o2 = 9; }
    if (horiz) { y1 += o1; y2 += o2; } else { x1 += o1 * 1.6; x2 += o2 * 1.6; }
    const c = horiz ? Math.abs(x2 - x1) * 0.5 : Math.abs(y2 - y1) * 0.5;
    const d = horiz
      ? `M${x1},${y1} C${x1 + Math.sign(dx) * c},${y1} ${x2 - Math.sign(dx) * c},${y2} ${x2},${y2}`
      : `M${x1},${y1} C${x1},${y1 + Math.sign(dy) * c} ${x2},${y2 - Math.sign(dy) * c} ${x2},${y2}`;
    paths += `<path class="fl-w t-${e.t}" id="flw-${e.id}" data-k="${e.k}" d="${d}" marker-end="url(#fl-arrow-${e.t})"/>`;
    mids[e.id] = d;
  }
  const marker = (t) => `<marker id="fl-arrow-${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 10 5 0 9Z" class="fl-ah t-${t}"/></marker>`;
  svg.innerHTML = `<defs>${["gov", "prop", "spend", "event", "callback"].map(marker).join("")}</defs>${paths}<g id="fl-dots"></g>`;
  // numbered badges, one per interaction, on its first wire
  const badges = [];
  const firstOf = { 1: "gov-alice", 2: "prop-pip", 3: "sp-bob-uni", 4: "ev-uni", 6: "cb-base" };
  for (const [k, id] of Object.entries(firstOf)) {
    const p = $(`flw-${id}`);
    const at = p.getPointAtLength(p.getTotalLength() * (k === "4" || k === "6" ? 0.5 : 0.62));
    badges.push(`<button class="fl-badge t-${LEGEND[k - 1].t}" type="button" data-badge="${k}" style="left:${at.x}px;top:${at.y}px" aria-label="Interaction ${k}">${k}</button>`);
  }
  const hr = rect("hob");
  badges.push(`<button class="fl-badge t-hob" type="button" data-badge="5" style="left:${hr.right - 6}px;top:${hr.top + 6}px" aria-label="Interaction 5">5</button>`);
  $("fl-badges").innerHTML = badges.join("");
  markSelected();
}

function focusK(k) {
  const stage = $("fl-stage");
  if (!stage) return;
  stage.classList.toggle("focus", k !== null);
  for (const w of document.querySelectorAll(".fl-w")) w.classList.toggle("hl", k !== null && (Number(w.dataset.k) === k || (k === 7 && w.dataset.k === "4")));
  for (const li of document.querySelectorAll("#fl-legend li")) li.classList.toggle("hl", Number(li.dataset.k) === k);
  $("fln-hob")?.classList.toggle("hl", k === 5 || k === 7);
}

// ---------------------------------------------------------------- motion
function caption(t) { const c = $("fl-cap"); if (c) c.textContent = t; }
function flashNode(id) {
  const n = $(`fln-${id}`);
  if (!n) return;
  n.classList.remove("ping"); void n.offsetWidth; n.classList.add("ping");
}
function travel(id, ms = 650) {
  const p = $(`flw-${id}`), g = $("fl-dots");
  if (!p || !g) return Promise.resolve();
  p.classList.add("on");
  if (reduce) return sleep(200).then(() => p.classList.remove("on"));
  const t = [...p.classList].find((c) => c.startsWith("t-"));
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("r", "5"); dot.setAttribute("class", `fl-dot ${t}`);
  g.appendChild(dot);
  const L = p.getTotalLength();
  return new Promise((res) => {
    const t0 = performance.now();
    const f = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const pt = p.getPointAtLength(L * e);
      dot.setAttribute("cx", pt.x); dot.setAttribute("cy", pt.y);
      if (k < 1) requestAnimationFrame(f);
      else { dot.remove(); p.classList.remove("on"); res(); }
    };
    requestAnimationFrame(f);
  });
}
async function pulseK(k) {
  const ids = EDGES.filter((e) => e.k === k || (k === 7 && e.k === 4)).map((e) => e.id);
  if (k === 5) { flashNode("hob"); return; }
  await Promise.all(ids.map((id) => travel(id)));
  if (k === 4 || k === 7) flashNode("hob");
}

let replaying = false;
async function replay(key) {
  if (replaying) return;
  replaying = true;
  document.querySelectorAll("[data-replay]").forEach((b) => b.classList.toggle("on", b.dataset.replay === key));
  for (const s of REPLAYS[key].steps) {
    caption(s.cap);
    if (s.node) { flashNode(s.node); await sleep(1500); }
    if (s.edges) await Promise.all(s.edges.map((id) => travel(id, 900)));
    if (s.edges) for (const id of s.edges) flashNode(EDGES.find((e) => e.id === id).to);
    if (s.freezePip) setPip(true);
    if (s.unfreezePip) setPip(false);
    await sleep(1500);
  }
  setPip(state?.pipFrozen ?? false);
  document.querySelectorAll("[data-replay]").forEach((b) => b.classList.remove("on"));
  replaying = false;
}
function setPip(frozen) {
  for (const f of document.querySelectorAll(".pipfig")) f.classList.toggle("frozen", !!frozen);
  $("fln-pip")?.classList.toggle("frozen", !!frozen);
}

// live events from the chains: light the matching wires, in order
const queue = [];
let draining = false;
const WHO = { alice: "alice", bob: "bob", agent: "pip" };
function stepsFor(e) {
  const ch = e.chain === "uni" ? "uni" : "base";
  const who = WHO[e.who];
  if (e.name === "Spent" && who) return [[`sp-${who}-${ch}`], [`ev-${ch}`]];
  if (e.name === "Spent") return [[`ev-${ch}`]];
  if (e.name === "RulesRatified" || e.name === "MemberSet") return [[`ev-base`]];
  if (e.kind === "reaction") return [["@hob"]];
  if (e.kind === "callback") return [[`cb-${ch}`]];
  return [];
}
async function drain() {
  draining = true;
  while (queue.length) {
    const e = queue.shift();
    if ($("tab-flow")?.hidden || replaying) continue;
    if (e.text) caption(`Live: ${e.text}`);
    for (const group of stepsFor(e)) {
      if (group[0] === "@hob") { flashNode("hob"); await sleep(250); continue; }
      await Promise.all(group.map((id) => travel(id, 600)));
      for (const id of group) flashNode(EDGES.find((x) => x.id === id)?.to);
    }
  }
  draining = false;
}

// ---------------------------------------------------------------- entity panel
function panel() {
  const n = NODES[selected];
  const live = state?.facts?.[selected] ?? [];
  const addr = state?.addr?.[selected];
  $("fl-panel").innerHTML = `
    <div class="fl-ph"><span class="fl-fig">${selected === "pip" ? PIP(state?.pipFrozen ? "frozen" : "") : n.fig}</span><div><span class="eyebrow">Entity</span><h3>${n.title}</h3><small>${n.sub}</small></div></div>
    <p>${n.about}</p>
    ${live.length ? `<dl class="fl-facts">${live.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
    <div class="fl-cc"><div><span class="fl-k ok">Can</span><ul>${n.can.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    <div><span class="fl-k no">Cannot</span><ul>${n.cannot.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>
    ${addr ? `<a class="fl-addr" href="${addr.url}" target="_blank" rel="noopener">${icon("link")}<span>${esc(addr.a)}</span></a>` : ""}`;
}
function live() {
  if (!state) return;
  for (const id of Object.keys(NODES)) {
    const el = $(`fll-${id}`);
    if (el) el.textContent = state.line?.[id] ?? "";
  }
  if (!replaying) setPip(state.pipFrozen);
  panel();
}

document.addEventListener("hob:state", (e) => { state = e.detail; build(); live(); });
document.addEventListener("hob:events", (e) => {
  for (const x of e.detail) queue.push(x);
  if (!draining) drain();
});
document.addEventListener("hob:tab", (e) => { if (e.detail === "flow") requestAnimationFrame(() => requestAnimationFrame(wire)); });
// the tab may be the first one shown (#flow link): build as soon as the page is ready
if (document.readyState !== "loading") build(); else addEventListener("DOMContentLoaded", build);
