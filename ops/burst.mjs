// Demo helper: the AI agent makes 7 quick buys split across both chains.
//   node ops/burst.mjs local|testnet
import { A, keys, loadDeployment, net, pub, wallet } from "./lib.mjs";
const name = process.argv[2] ?? "local";
const N = net(name), K = keys(name), D = loadDeployment(name), V = A.vault();
const shop = "0x000000000000000000000000000000000000c0DE";
for (const [k, n] of [["base", 3], ["uni", 4]]) {
  const c = { ...N[k], vault: D.chains[k].vault };
  for (let i = 0; i < n; i++) {
    const hash = await wallet(c, K.agent).writeContract({ address: c.vault, abi: V.abi, functionName: "spend", args: [0, shop, 20_000000n] });
    const r = await pub(c).waitForTransactionReceipt({ hash });
    console.log(`agent buy on ${c.name}: ${r.status}`);
  }
}
