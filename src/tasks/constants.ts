import path from "node:path";
import { CONFIG_DIR } from "../utils.js";

export const DEFAULT_TASK_DIR = path.join(CONFIG_DIR, "tasks");
export const DEFAULT_TASK_STORE_PATH = path.join(DEFAULT_TASK_DIR, "tasks.json");

export const TASK_RUN_AGAIN_MS = 15_000;
export const TASK_NO_PROGRESS_RETRY_MS = 60_000;
export const TASK_LEASE_TTL_MS = 5 * 60_000;
export const TASK_NO_PROGRESS_LIMIT = 3;
export const TASK_USER_UPDATE_MIN_INTERVAL_MS = 60_000;
