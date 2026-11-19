// LOCAL ONLY. Plays the part of Reactive Network between three anvil chains:
//   1. watches every log on the origin chains,
//   2. delivers the ones matching a subscription to react() on the reactive chain (as 0x8888…),
//   3. reads the CallbackRequest events the system contract emitted,
//   4. posts each callback from the chain's proxy account, with the reactive
//      contract's address injected as the first argument (what the real network does).
//   node ops/relayer.mjs
import { decodeEventLog, encodeFunctionData, getAddress, hexToBigInt, parseEther } from "viem";
import { A, SYSTEM, keys, loadDeployment, net, pub, sleep, wallet } from "./lib.mjs";

const N = net("local");
const K = keys("local");
const D = loadDeployment("local");
const SYS = A.system();
const RSC = A.reactive();

const origins = ["base", "uni"].map((k) => ({ key: k, c: N[k], p: pub(N[k]), from: 0n }));
const reactive = { c: N.reactive, p: pub(N.reactive), from: 0n };
const byChainId = Object.fromEntries(["base", "uni"].map((k) => [N[k].chainId, N[k]]));

async function setup() {
  await reactive.p.request({ method: "anvil_impersonateAccount", params: [SYSTEM] });
  await reactive.p.request({ method: "anvil_setBalance", params: [SYSTEM, "0x" + parseEther("1000").toString(16)] });
  // Start from block 0 so events emitted during deployment (founder resync) are delivered.
  for (const o of origins) o.from = 0n;
  reactive.from = (await reactive.p.getBlockNumber()) + 1n;
}

async function subs() {
  return reactive.p.readContract({ address: SYSTEM, abi: SYS.abi, functionName: "subs" });
}

async function deliverOrigins() {
  const s = await subs();
  for (const o of origins) {
    const head = await o.p.getBlockNumber();
    if (head < o.from) continue;
    const logs = await o.p.getLogs({ fromBlock: o.from, toBlock: head });
    o.from = head + 1n;
    for (const lg of logs) {
      const t0 = lg.topics[0] ? hexToBigInt(lg.topics[0]) : null;
      if (t0 === null) continue;
      for (const sub of s) {
        if (Number(sub.chainId) !== o.c.chainId) continue;
        if (getAddress(sub.emitter) !== getAddress(lg.address)) continue;
        if (sub.topic0 !== t0) continue;
        const rec = {
          chainId: BigInt(o.c.chainId),
          contractAddress: lg.address,
          topic0: t0,
          topic1: lg.topics[1] ? hexToBigInt(lg.topics[1]) : 0n,
          topic2: lg.topics[2] ? hexToBigInt(lg.topics[2]) : 0n,
          topic3: lg.topics[3] ? hexToBigInt(lg.topics[3]) : 0n,
          data: lg.data,
          blockNumber: lg.blockNumber,
          opCode: BigInt(lg.topics.length),
          blockHash: hexToBigInt(lg.blockHash),
          txHash: hexToBigInt(lg.transactionHash),
          logIndex: BigInt(lg.logIndex),
        };
        const hash = await reactive.p.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: SYSTEM,
              to: sub.subscriber,
              gas: "0xDBBA0", // 900k: Reactive's per-transaction cap
              data: encodeReact(rec),
            },
          ],
        });
        const r = await reactive.p.waitForTransactionReceipt({ hash });
        const name = eventName(lg);
        console.log(`react  ${o.c.name.padEnd(17)} ${name.padEnd(14)} → reactive tx ${hash.slice(0, 10)} ${r.status} gas ${r.gasUsed}`);
      }
    }
  }
}

function encodeReact(rec) {
  return encodeFunctionData({ abi: RSC.abi, functionName: "react", args: [rec] });
}

function eventName(lg) {
  for (const art of [A.vault()]) {
    try {
      return decodeEventLog({ abi: art.abi, data: lg.data, topics: lg.topics }).eventName;
    } catch {}
  }
  return "?";
}

async function deliverCallbacks() {
  const head = await reactive.p.getBlockNumber();
  if (head < reactive.from) return;
  const logs = await reactive.p.getLogs({ address: SYSTEM, fromBlock: reactive.from, toBlock: head });
  reactive.from = head + 1n;
  for (const lg of logs) {
    let ev;
    try {
      ev = decodeEventLog({ abi: SYS.abi, data: lg.data, topics: lg.topics });
    } catch {
      continue;
    }
    if (ev.eventName !== "CallbackRequest") continue;
    const { chainId, requester, recipient, gasLimit, payload } = ev.args;
    const dest = byChainId[Number(chainId)];
    if (!dest) continue;
    // inject the requesting reactive contract into the first argument (bytes 4..36)
    const injected = payload.slice(0, 10) + requester.slice(2).toLowerCase().padStart(64, "0") + payload.slice(74);
    const w = wallet(dest, K.proxy);
    const hash = await w.sendTransaction({ to: recipient, data: injected, gas: gasLimit });
    const r = await pub(dest).waitForTransactionReceipt({ hash });
    console.log(`callbk ${dest.name.padEnd(17)} ${payload.slice(0, 10)}     → tx ${hash.slice(0, 10)} ${r.status}`);
  }
}

async function main() {
  await setup();
  console.log(`relayer up: ${origins.map((o) => o.c.name).join(" + ")} ⇄ ${reactive.c.name} (contract ${D.chains.reactive.contract})`);
  for (;;) {
    try {
      await deliverOrigins();
      await deliverCallbacks();
    } catch (e) {
      console.error("relayer error:", e.shortMessage ?? e.message);
    }
    await sleep(200);
  }
}

main();
