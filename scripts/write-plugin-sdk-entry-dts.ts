import fs from "node:fs";
import path from "node:path";
import { pluginSdkEntryNames } from "../src/plugin-sdk/export-manifest.ts";

// `tsc` emits declarations under `dist/plugin-sdk/plugin-sdk/*` because the source lives
// at `src/plugin-sdk/*` and `rootDir` is `src/`.
//
// Our package export map points subpath `types` at `dist/plugin-sdk/<entry>.d.ts`, so we
// generate stable entry d.ts files that re-export the real declarations.
for (const entry of pluginSdkEntryNames) {
  const out = path.join(process.cwd(), `dist/plugin-sdk/${entry}.d.ts`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // NodeNext: reference the runtime specifier with `.js`, TS will map it to `.d.ts`.
  fs.writeFileSync(out, `export * from "./plugin-sdk/${entry}.js";\n`, "utf8");
}
