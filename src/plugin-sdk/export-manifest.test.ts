import { describe, expect, it } from "vitest";
import {
  buildPluginSdkPackageExports,
  pluginSdkEntryNames,
  pluginSdkExportEntries,
  pluginSdkScopedExportEntries,
} from "./export-manifest.js";

describe("plugin-sdk export manifest", () => {
  it("keeps package subpaths and entry names unique", () => {
    expect(new Set(pluginSdkExportEntries.map((entry) => entry.packageSubpath)).size).toBe(
      pluginSdkExportEntries.length,
    );
    expect(new Set(pluginSdkEntryNames).size).toBe(pluginSdkEntryNames.length);
  });

  it("keeps scoped entries aligned with the shared manifest", () => {
    expect(pluginSdkScopedExportEntries).toEqual(
      pluginSdkExportEntries.filter((entry) => entry.packageSubpath !== "./plugin-sdk"),
    );
    expect(
      pluginSdkScopedExportEntries.every((entry) =>
        entry.packageSubpath.startsWith("./plugin-sdk/"),
      ),
    ).toBe(true);
  });

  it("builds package exports directly from manifest entries", () => {
    const exportsMap = buildPluginSdkPackageExports();

    expect(Object.keys(exportsMap)).toEqual(
      pluginSdkExportEntries.map((entry) => entry.packageSubpath),
    );
    for (const entry of pluginSdkExportEntries) {
      expect(exportsMap[entry.packageSubpath]).toEqual({
        types: `./dist/plugin-sdk/${entry.entryName}.d.ts`,
        default: `./dist/plugin-sdk/${entry.entryName}.js`,
      });
    }
  });
});
