// The only viem APIs the dashboard uses, bundled into web/vendor/viem.js (run: node ops/build-vendor.mjs).
export { createPublicClient, createWalletClient, custom, decodeEventLog, defineChain, formatUnits, http, parseUnits } from "viem";
export { privateKeyToAccount } from "viem/accounts";
