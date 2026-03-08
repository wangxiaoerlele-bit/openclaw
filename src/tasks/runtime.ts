import type { TaskCreateInput, TaskCreateResult } from "./types.js";

export type ActiveTaskRuntime = {
  create(input: TaskCreateInput): Promise<TaskCreateResult>;
  wake(taskId: string): Promise<void>;
};

let activeTaskRuntime: ActiveTaskRuntime | null = null;

export function setActiveTaskRuntime(next: ActiveTaskRuntime | null): void {
  activeTaskRuntime = next;
}

export function getActiveTaskRuntime(): ActiveTaskRuntime | null {
  return activeTaskRuntime;
}

export function resetActiveTaskRuntimeForTests(): void {
  activeTaskRuntime = null;
}
