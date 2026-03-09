import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-store.js";

const tmpRoots: string[] = [];

async function makeTmpRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-store-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("json-store", () => {
  it("returns the fallback and exists=false when the file is missing", async () => {
    const root = await makeTmpRoot();
    const filePath = path.join(root, "missing.json");

    await expect(readJsonFileWithFallback(filePath, { count: 0 })).resolves.toEqual({
      value: { count: 0 },
      exists: false,
    });
  });

  it("returns the fallback and exists=true when the file contains invalid json", async () => {
    const root = await makeTmpRoot();
    const filePath = path.join(root, "invalid.json");
    await fs.writeFile(filePath, "{not-json", "utf-8");

    await expect(readJsonFileWithFallback(filePath, { ok: true })).resolves.toEqual({
      value: { ok: true },
      exists: true,
    });
  });

  it("writes json atomically and reads it back", async () => {
    const root = await makeTmpRoot();
    const filePath = path.join(root, "nested", "state.json");
    const value = {
      channels: ["telegram"],
      retries: 2,
    };

    await writeJsonFileAtomically(filePath, value);

    const raw = await fs.readFile(filePath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    await expect(readJsonFileWithFallback(filePath, null)).resolves.toEqual({
      value,
      exists: true,
    });
  });
});
