// Shared config for deploy / relayer / prove. Works for `local` (3 anvils) and `testnet`.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(join(ROOT, ".env")); // Node >= 21
} catch {}
export const SYSTEM = "0x8888888888888888888888888888888888888888";

// Anvil's well-known public dev keys. LOCAL ONLY — never fund these on a real network.
const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // 0 alice / deployer
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // 1 bob
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // 2 agent
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", // 9 proxy / relayer
];

export const NETWORKS = {
  local: {
    base: { name: "Base (local)", chainId: 84532, rpc: "http://127.0.0.1:8545", explorer: null },
    uni: { name: "Unichain (local)", chainId: 1301, rpc: "http://127.0.0.1:8546", explorer: null },
    reactive: { name: "Reactive (local)", chainId: 5318007, rpc: "http://127.0.0.1:8547", explorer: null },
  },
  testnet: {
    base: {
      name: "Base Sepolia",
      chainId: 84532,
      rpc: process.env.BASE_RPC ?? "https://base-sepolia-rpc.publicnode.com",
      explorer: "https://base-sepolia.blockscout.com",
      proxy: "0x476F44b11F5C942c58f4c8E3d0300E5710743585", // verify with Reactive MCP before deploying
    },
    uni: {
      name: "Unichain Sepolia",
      chainId: 1301,
      rpc: process.env.UNI_RPC ?? "https://unichain-sepolia-rpc.publicnode.com",
      explorer: "https://sepolia.uniscan.xyz",
      proxy: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
    },
    reactive: {
      name: "Reactive Lasna",
      chainId: 5318007,
      rpc: process.env.LASNA_RPC ?? "https://lasna-rpc.rnk.dev/",
      explorer: "https://lasna.reactscan.net",
    },
  },
};

export function net(name) {
  const n = NETWORKS[name];
  if (!n) throw new Error(`unknown network ${name} (local | testnet)`);
  return n;
}

export function keys(name) {
  if (name === "local") {
    return { alice: ANVIL_KEYS[0], bob: ANVIL_KEYS[1], agent: ANVIL_KEYS[2], proxy: ANVIL_KEYS[3] };
  }
  const need = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing ${k} in environment (.env)`);
    return v;
  };
  return { alice: need("PRIVATE_KEY"), bob: need("BOB_KEY"), agent: need("AGENT_KEY") };
}

export function artifact(file, contract) {
  const p = join(ROOT, "out", file, `${contract}.json`);
  if (!existsSync(p)) throw new Error(`missing ${p} — run \`forge build\` first`);
  const j = JSON.parse(readFileSync(p, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, deployed: j.deployedBytecode.object };
}

export const A = {
  vault: () => artifact("HobVault.sol", "HobVault"),
  reactive: () => artifact("HobReactive.sol", "HobReactive"),
  usdc: () => artifact("MockUSDC.sol", "MockUSDC"),
  system: () => artifact("ReactiveSim.sol", "MockSystem"),
};

const chainCache = new Map();
export function chainOf(c) {
  if (!chainCache.has(c.chainId)) {
    chainCache.set(
      c.chainId,
      defineChain({
        id: c.chainId,
        name: c.name,
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [c.rpc] } },
        // Lasna rejects a zero priority fee, and viem's estimate can come back as 0.
        // Always tip 1 gwei and allow for the base fee to double.
        fees: {
          async estimateFeesPerGas({ block }) {
            const tip = 1_000_000_000n;
            const base = block?.baseFeePerGas ?? 0n;
            return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip };
          },
        },
      })
    );
  }
  return chainCache.get(c.chainId);
}

export function pub(c) {
  return createPublicClient({ chain: chainOf(c), transport: http(c.rpc), pollingInterval: 250 });
}

export function wallet(c, key) {
  return createWalletClient({ chain: chainOf(c), transport: http(c.rpc), account: privateKeyToAccount(key) });
}

export function addr(key) {
  return privateKeyToAccount(key).address;
}

export function txLink(c, hash) {
  return c.explorer ? `${c.explorer}/tx/${hash}` : null;
}

export function loadDeployment(name) {
  const p = join(ROOT, "deployments", `${name}.json`);
  if (!existsSync(p)) throw new Error(`no deployment at ${p} — run deploy first`);
  return JSON.parse(readFileSync(p, "utf8"));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CATEGORY = { GROCERIES: 0, RENT: 1 };
export const MODE = ["NORMAL", "TIGHT", "FROZEN"];
