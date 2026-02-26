#!/usr/bin/env node
import path from "node:path";
import { searchPersonalMemorySnapshotCached } from "../src/personal-memory/search.ts";
import { FileBackedPersonalMemoryStore } from "../src/personal-memory/store.ts";
import { resolvePersonalContextDir } from "./personal-context-memory.ts";

type Args = {
  dir: string;
  query: string;
  limit: number;
  json: boolean;
  mode: "keyword" | "hybrid" | "semantic";
  cache: boolean;
  rerank: boolean;
  rerankTopK?: number;
  rerankStrategy: "mmr-lite" | "hybrid-v2";
  backend: "sparse-cache" | "sqlite-vec";
  sqliteVecFile?: string;
  sqliteVecExtensionPath?: string;
  layers?: Array<"working" | "episodic" | "semantic">;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-memory-search.ts --query <text> [options]",
    "",
    "Options:",
    "  --dir <dir>             Memory directory (default: personal-context)",
    "  --query <text>          Search query (required)",
    "  --limit <n>            Max hits (default: 8, max: 50)",
    "  --layers <csv>         Filter layers (working,episodic,semantic)",
    "  --mode <mode>          Search mode (keyword, hybrid, semantic; default: hybrid)",
    "  --backend <name>       Semantic backend (sparse-cache, sqlite-vec; default: sparse-cache)",
    "  --rerank              Enable MMR-lite rerank for semantic/hybrid (default: on)",
    "  --no-rerank           Disable rerank",
    "  --rerank-top-k <n>    Candidate pool size for rerank (default: auto)",
    "  --rerank-strategy <s> Rerank strategy (mmr-lite, hybrid-v2; default: hybrid-v2)",
    "  --sqlite-vec-file <p>  sqlite-vec index path (default: personal-context/.semantic-index.sqlite)",
    "  --sqlite-vec-extension <p> Explicit sqlite-vec extension path (optional)",
    "  --no-cache             Disable semantic index cache (semantic/hybrid modes)",
    "  --json                 Output JSON",
    "  -h, --help             Show help",
  ].join("\n");
}

function parseLayers(raw: string): Array<"working" | "episodic" | "semantic"> {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error("--layers requires at least one layer");
  }
  const allowed = new Set(["working", "episodic", "semantic"]);
  for (const part of parts) {
    if (!allowed.has(part)) {
      throw new Error(`invalid layer: ${part}`);
    }
  }
  return [...new Set(parts)] as Array<"working" | "episodic" | "semantic">;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: "personal-context",
    query: "",
    limit: 8,
    json: false,
    mode: "hybrid",
    cache: true,
    rerank: true,
    backend: "sparse-cache",
    rerankStrategy: "hybrid-v2",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--dir":
        if (!next) {
          throw new Error("--dir requires a value");
        }
        args.dir = next;
        i += 1;
        break;
      case "--query":
        if (!next) {
          throw new Error("--query requires a value");
        }
        args.query = next;
        i += 1;
        break;
      case "--limit":
        if (!next) {
          throw new Error("--limit requires a value");
        }
        args.limit = Number.parseInt(next, 10);
        i += 1;
        break;
      case "--layers":
        if (!next) {
          throw new Error("--layers requires a value");
        }
        args.layers = parseLayers(next);
        i += 1;
        break;
      case "--mode":
        if (!next) {
          throw new Error("--mode requires a value");
        }
        if (next !== "keyword" && next !== "hybrid" && next !== "semantic") {
          throw new Error(`invalid mode: ${next}`);
        }
        args.mode = next;
        i += 1;
        break;
      case "--backend":
        if (!next) {
          throw new Error("--backend requires a value");
        }
        if (next !== "sparse-cache" && next !== "sqlite-vec") {
          throw new Error(`invalid backend: ${next}`);
        }
        args.backend = next;
        i += 1;
        break;
      case "--rerank":
        args.rerank = true;
        break;
      case "--no-rerank":
        args.rerank = false;
        break;
      case "--rerank-top-k":
        if (!next) {
          throw new Error("--rerank-top-k requires a value");
        }
        args.rerankTopK = Number.parseInt(next, 10);
        i += 1;
        break;
      case "--rerank-strategy":
        if (!next) {
          throw new Error("--rerank-strategy requires a value");
        }
        if (next !== "mmr-lite" && next !== "hybrid-v2") {
          throw new Error("--rerank-strategy must be one of: mmr-lite, hybrid-v2");
        }
        args.rerankStrategy = next;
        i += 1;
        break;
      case "--sqlite-vec-file":
        if (!next) {
          throw new Error("--sqlite-vec-file requires a value");
        }
        args.sqliteVecFile = next;
        i += 1;
        break;
      case "--sqlite-vec-extension":
        if (!next) {
          throw new Error("--sqlite-vec-extension requires a value");
        }
        args.sqliteVecExtensionPath = next;
        i += 1;
        break;
      case "--json":
        args.json = true;
        break;
      case "--no-cache":
        args.cache = false;
        break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.query.trim()) {
    throw new Error("--query is required");
  }
  if (!Number.isFinite(args.limit) || args.limit < 1 || args.limit > 50) {
    throw new Error("--limit must be an integer between 1 and 50");
  }
  if (
    args.rerankTopK !== undefined &&
    (!Number.isFinite(args.rerankTopK) || args.rerankTopK < 1 || args.rerankTopK > 50)
  ) {
    throw new Error("--rerank-top-k must be an integer between 1 and 50");
  }
  return args;
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    console.error(usage());
    process.exit(2);
    return;
  }

  let baseDir: string;
  try {
    baseDir = resolvePersonalContextDir(process.cwd(), args.dir);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const store = new FileBackedPersonalMemoryStore({ personalContextDir: baseDir });
  try {
    await store.init();
    const snapshot = store.snapshot();
    const status = store.status();
    const result = searchPersonalMemorySnapshotCached(
      snapshot,
      {
        query: args.query,
        limit: args.limit,
        layers: args.layers,
        mode: args.mode,
        rerank: {
          enabled: args.rerank,
          topK: args.rerankTopK,
          strategy: args.rerankStrategy,
        },
      },
      {
        enabled: args.cache,
        backend: args.backend,
        fingerprint: status.lastFingerprint,
        filePath: path.join(baseDir, ".semantic-index-cache.json"),
        sqliteVec: {
          dbPath: args.sqliteVecFile
            ? path.resolve(process.cwd(), args.sqliteVecFile)
            : path.join(baseDir, ".semantic-index.sqlite"),
          extensionPath: args.sqliteVecExtensionPath,
        },
      },
    );

    const payload = {
      personalContextDir: path.resolve(baseDir),
      ...result,
    };

    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Personal memory search: ${payload.personalContextDir}`);
    console.log(`Query: ${result.query}`);
    console.log(`Mode: ${result.mode}`);
    console.log(`Hits: ${result.hits.length}/${result.totalHits}`);
    if (result.cache) {
      console.log(
        `Cache: backend=${result.cache.backend ?? "unknown"} enabled=${String(result.cache.enabled)} hit=${String(result.cache.cacheHit ?? false)} rebuilt=${String(result.cache.rebuilt ?? false)}${result.cache.reason ? ` reason=${result.cache.reason}` : ""}`,
      );
    }
    if (result.rerank) {
      console.log(
        `Rerank: enabled=${String(result.rerank.enabled)} applied=${String(result.rerank.applied)} strategy=${result.rerank.strategy} topK=${result.rerank.topK} moved=${result.rerank.movedCount}${result.rerank.reason ? ` reason=${result.rerank.reason}` : ""}`,
      );
    }
    for (const [idx, hit] of result.hits.entries()) {
      console.log(
        `${idx + 1}. [${hit.layer}] ${hit.title} (score=${hit.score})${hit.tags ? ` tags=${hit.tags.join(",")}` : ""}`,
      );
      if (hit.reasons.length > 0) {
        console.log(`   reasons: ${hit.reasons.join(", ")}`);
      }
      if (hit.snippet) {
        console.log(`   ${hit.snippet}`);
      }
    }
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
