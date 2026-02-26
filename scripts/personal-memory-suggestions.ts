#!/usr/bin/env node
import path from "node:path";
import {
  applyQueuedPersonalMemorySuggestion,
  dismissPersonalMemorySuggestion,
  listPersonalMemorySuggestions,
} from "../src/personal-memory/suggestion-queue.ts";
import { resolvePersonalContextDir } from "./personal-context-memory.ts";

type Command = "list" | "apply" | "dismiss";

type Args = {
  dir: string;
  command: Command;
  id?: string;
  json: boolean;
  dryRun: boolean;
  status: "pending" | "applied" | "dismissed" | "all";
  limit: number;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/personal-memory-suggestions.ts <list|apply|dismiss> [options]",
    "",
    "Commands:",
    "  list                 List suggestion queue items (default: pending)",
    "  apply --id <id>      Apply queued L2 suggestion by id (decision-log only)",
    "  dismiss --id <id>    Dismiss queued suggestion by id",
    "",
    "Options:",
    "  --dir <dir>          Memory directory (default: personal-context)",
    "  --id <id>            Suggestion id for apply/dismiss",
    "  --status <status>    pending|applied|dismissed|all (list only; default: pending)",
    "  --limit <n>          Max list rows (default: 20, max: 200)",
    "  --dry-run            Preview apply without mutating decision-log or queue status",
    "  --json               Output JSON",
    "  -h, --help           Show help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const first = argv[0];
  if (!first || (first !== "list" && first !== "apply" && first !== "dismiss")) {
    throw new Error("first argument must be one of: list, apply, dismiss");
  }
  const args: Args = {
    dir: "personal-context",
    command: first,
    json: false,
    dryRun: false,
    status: "pending",
    limit: 20,
  };
  for (let i = 1; i < argv.length; i += 1) {
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
      case "--id":
        if (!next) {
          throw new Error("--id requires a value");
        }
        args.id = next;
        i += 1;
        break;
      case "--status":
        if (!next) {
          throw new Error("--status requires a value");
        }
        if (!["pending", "applied", "dismissed", "all"].includes(next)) {
          throw new Error(`invalid --status: ${next}`);
        }
        args.status = next as Args["status"];
        i += 1;
        break;
      case "--limit":
        if (!next) {
          throw new Error("--limit requires a value");
        }
        args.limit = Number.parseInt(next, 10);
        i += 1;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.limit) || args.limit < 1 || args.limit > 200) {
    throw new Error("--limit must be an integer between 1 and 200");
  }
  if ((args.command === "apply" || args.command === "dismiss") && !args.id?.trim()) {
    throw new Error(`--id is required for ${args.command}`);
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

  try {
    if (args.command === "list") {
      const result = listPersonalMemorySuggestions({
        personalContextDir: baseDir,
        status: args.status,
        limit: args.limit,
      });
      const payload = {
        personalContextDir: path.resolve(baseDir),
        filePath: result.filePath,
        status: args.status,
        total: result.items.length,
        items: result.items.map((item) => ({
          id: item.id,
          status: item.status,
          level: item.suggestion.level,
          target: item.suggestion.target,
          title: item.suggestion.title,
          reason: item.suggestion.reason,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          source: item.source,
          structured: item.suggestion.structured,
        })),
      };
      if (args.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`Suggestion queue: ${payload.personalContextDir}`);
      console.log(`Status filter: ${payload.status}`);
      console.log(`Items: ${payload.total}`);
      for (const [idx, item] of payload.items.entries()) {
        console.log(
          `${idx + 1}. ${item.id} [${item.status}] ${item.level} ${item.target ?? "-"} ${item.title ?? item.reason}`,
        );
      }
      return;
    }

    if (args.command === "dismiss") {
      const item = dismissPersonalMemorySuggestion({
        personalContextDir: baseDir,
        id: args.id!,
      });
      if (args.json) {
        console.log(JSON.stringify({ ok: true, item }, null, 2));
        return;
      }
      console.log(`Dismissed suggestion: ${item.id}`);
      return;
    }

    const result = applyQueuedPersonalMemorySuggestion({
      personalContextDir: baseDir,
      id: args.id!,
      dryRun: args.dryRun,
    });
    if (args.json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    console.log(
      `Applied suggestion: ${result.item.id} dryRun=${String(args.dryRun)} target=${result.applyResult.target} title=${result.applyResult.title}`,
    );
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
