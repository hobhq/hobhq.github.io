// Bundles the viem subset the dashboard needs into one self-hosted file (no CDN at runtime).
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, "vendor-entry.mjs")],
  outfile: join(here, "..", "web", "vendor", "viem.js"),
  bundle: true, format: "esm", minify: true, target: "es2022", legalComments: "eof",
});
console.log("wrote web/vendor/viem.js");
