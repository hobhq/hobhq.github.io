// Puts a fresh deployment in the "start of the demo video" state:
// rules ratified (groceries + rent), the AI agent added, a normal week of shopping.
//   node ops/seed.mjs local|testnet
import { A, CATEGORY, keys, loadDeployment, net, pub, sleep, wallet } from "./lib.mjs";

const name = process.argv[2] ?? "local";
const N = net(name);
const K = keys(name);
const D = loadDeployment(name);
const V = A.vault();
const C = { base: { ...N.base, vault: D.chains.base.vault }, uni: { ...N.uni, vault: D.chains.uni.vault } };
const shop = "0x000000000000000000000000000000000000c0DE";

async function tx(k, who, fn, args) {
  const c = C[k];
  const hash = await wallet(c, K[who]).writeContract({ address: c.vault, abi: V.abi, functionName: fn, args });
  const r = await pub(c).waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
  console.log(`  ${who.padEnd(5)} ${fn.padEnd(15)} ${c.name}`);
}
const count = () => pub(C.base).readContract({ address: C.base.vault, abi: V.abi, functionName: "proposalCount" });

async function ratify(cat, rule) {
  const id = await count();
  await tx("base", "alice", "proposeRule", [cat, rule]);
  await tx("base", "bob", "approveProposal", [id]);
}

console.log(`Seeding ${name}`);
await ratify(CATEGORY.GROCERIES, { monthlyCap: 1000_000000n, perTxCap: 200_000000n, coSignAbove: 150_000000n, active: true });
await ratify(CATEGORY.RENT, { monthlyCap: 2000_000000n, perTxCap: 2000_000000n, coSignAbove: 2000_000000n, active: true });
const id = await count();
await tx("base", "alice", "proposeMember", [D.members.agent, 2]);
await tx("base", "bob", "approveProposal", [id]);
await sleep(name === "local" ? 1500 : 15000); // let the mirror learn the agent
await tx("base", "alice", "spend", [CATEGORY.GROCERIES, shop, 140_000000n, "Weekly supermarket shop"]);
await tx("uni", "bob", "spend", [CATEGORY.GROCERIES, shop, 120_000000n, "Bakery and dairy"]);
await tx("base", "agent", "spend", [CATEGORY.GROCERIES, shop, 35_000000n, "Fruit for school lunches"]);
await tx("uni", "bob", "spend", [CATEGORY.GROCERIES, shop, 95_000000n, "Butcher: Sunday roast"]);
console.log("done: ~390 / 1000 groceries spent across both chains");
