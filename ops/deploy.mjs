// Deploys the full Hob system and writes deployments/<network>.json.
//   node ops/deploy.mjs local
//   node ops/deploy.mjs testnet     (needs PRIVATE_KEY, BOB_KEY, AGENT_KEY in env)
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseEther } from "viem";
import { A, ROOT, SYSTEM, addr, keys, net, pub, wallet } from "./lib.mjs";

const name = process.argv[2] ?? "local";
const N = net(name);
const K = keys(name);
const alice = addr(K.alice);
const bob = addr(K.bob);
const isLocal = name === "local";
const PERIOD = BigInt(process.env.PERIOD_SECONDS ?? 30 * 24 * 3600);

const depositAbi = [{ type: "function", name: "depositTo", stateMutability: "payable", inputs: [{ type: "address" }], outputs: [] }];

async function deploy(c, art, args = [], value = 0n) {
  const w = wallet(c, K.alice);
  const p = pub(c);
  const hash = await w.deployContract({ abi: art.abi, bytecode: art.bytecode, args, value });
  const r = await p.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`deploy failed on ${c.name}`);
  return { address: r.contractAddress, hash, block: Number(r.blockNumber) };
}

async function send(c, key, address, abi, functionName, args, value = 0n) {
  const w = wallet(c, key);
  const p = pub(c);
  const hash = await w.writeContract({ address, abi, functionName, args, value });
  const r = await p.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted on ${c.name}`);
  return hash;
}

async function main() {
  console.log(`Deploying Hob to ${name}`);
  const out = { network: name, deployedAt: new Date().toISOString(), chains: {}, members: { alice, bob, agent: addr(K.agent) } };

  // 0. local only: install the mock system contract at 0x8888… and a proxy account
  let proxyLocal;
  if (isLocal) {
    proxyLocal = addr(K.proxy);
    await pub(N.reactive).request({ method: "anvil_setCode", params: [SYSTEM, A.system().deployed] });
    console.log("  mock system contract installed at", SYSTEM);
  }

  // 1. reactive contract
  const R = A.reactive();
  const rsc = await deploy(N.reactive, R, [
    8000,
    { maxAmount: 2000_000000n, maxTx: 30, window: 3600, freezeFor: 3600 },
    { maxAmount: 300_000000n, maxTx: 6, window: 3600, freezeFor: 86400 },
  ]);
  console.log("  HobReactive", rsc.address);
  if (!isLocal) {
    const fund = parseEther(process.env.REACTIVE_FUND ?? "2");
    await send(N.reactive, K.alice, SYSTEM, depositAbi, "depositTo", [rsc.address], fund);
    console.log(`  funded reactive contract with ${process.env.REACTIVE_FUND ?? "2"} lREACT`);
  }

  // 2. vaults
  const now = BigInt(Math.floor(Date.now() / 1000));
  const epoch = now - 60n; // shared by every vault
  const V = A.vault();
  const U = A.usdc();
  for (const [key, isHome] of [["base", true], ["uni", false]]) {
    const c = N[key];
    const proxy = isLocal ? proxyLocal : c.proxy;
    const token = await deploy(c, U);
    const vault = await deploy(c, V, [proxy, rsc.address, token.address, isHome, epoch, PERIOD, isHome ? [alice, bob] : []]);
    await send(c, K.alice, token.address, U.abi, "mint", [vault.address, 1_000_000_000000n]);
    if (!isLocal) {
      const fund = parseEther(process.env.CALLBACK_FUND ?? "0.005");
      await send(c, K.alice, proxy, depositAbi, "depositTo", [vault.address], fund);
    }
    out.chains[key] = { ...c, proxy, vault: vault.address, token: token.address, deployTx: vault.hash, deployBlock: vault.block, home: isHome };
    console.log(`  ${c.name}: vault ${vault.address} token ${token.address}${isHome ? " (home)" : ""}`);
  }
  out.chains.reactive = { ...N.reactive, contract: rsc.address, deployTx: rsc.hash, deployBlock: rsc.block };
  out.epoch = Number(epoch);
  out.period = Number(PERIOD);

  // 3. subscribe the reactive contract to both vaults
  for (const key of ["base", "uni"]) {
    const c = out.chains[key];
    await send(N.reactive, K.alice, rsc.address, R.abi, "registerVault", [BigInt(c.chainId), c.vault, c.home]);
  }
  await send(N.reactive, K.alice, rsc.address, R.abi, "seal", []);
  console.log("  vaults registered (subscriptions live), setup sealed: the deployer has no admin powers left");

  // 4. announce the founding adults so the mirror learns them
  const hash = await send(N.base, K.alice, out.chains.base.vault, V.abi, "resync", [[alice, bob], []]);
  out.resyncTx = hash;
  console.log("  founders announced on home:", hash);

  mkdirSync(join(ROOT, "deployments"), { recursive: true });
  const file = join(ROOT, "deployments", `${name}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  writeFileSync(join(ROOT, "web", `deployment.${name}.json`), JSON.stringify(out, null, 2));
  console.log("wrote", file);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
