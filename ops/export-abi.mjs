// Writes web/abi.json from the Foundry artifacts (run after `forge build`).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { A, ROOT } from "./lib.mjs";
writeFileSync(join(ROOT, "web", "abi.json"), JSON.stringify({ vault: A.vault().abi, reactive: A.reactive().abi }));
console.log("wrote web/abi.json");
