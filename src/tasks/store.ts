import path from "node:path";
import { expandHomePrefix } from "../infra/home-dir.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "../infra/json-files.js";
import { DEFAULT_TASK_STORE_PATH } from "./constants.js";
import type { TaskStoreFile } from "./types.js";

const STORE_LOCKS = new Map<string, ReturnType<typeof createAsyncLock>>();

function resolveLock(storePath: string) {
  const existing = STORE_LOCKS.get(storePath);
  if (existing) {
    return existing;
  }
  const created = createAsyncLock();
  STORE_LOCKS.set(storePath, created);
  return created;
}

export function resolveTaskStorePath(storePath?: string): string {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return DEFAULT_TASK_STORE_PATH;
}

export async function withTaskStoreLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  return await resolveLock(storePath)(fn);
}

export async function loadTaskStore(storePath: string): Promise<TaskStoreFile> {
  const parsed = await readJsonFile<Partial<TaskStoreFile>>(storePath);
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks.filter(Boolean) : [];
  return {
    version: 1,
    tasks,
  };
}

export async function saveTaskStore(storePath: string, store: TaskStoreFile): Promise<void> {
  await writeJsonAtomic(storePath, store, {
    mode: 0o600,
    ensureDirMode: 0o700,
    trailingNewline: true,
  });
}
