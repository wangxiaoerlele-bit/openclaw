export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_external"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskEvidenceKind = "fact" | "artifact" | "side_effect";

export type TaskEvidence = {
  ts: number;
  text: string;
  kind: TaskEvidenceKind;
};

export type TaskLease = {
  owner: string;
  acquiredAtMs: number;
  expiresAtMs: number;
};

export type TaskRecord = {
  taskId: string;
  agentId: string;
  originSessionKey: string;
  originMessageId?: string;
  title: string;
  goal: string;
  acceptance: string[];
  status: TaskStatus;
  workerSessionKey: string;
  nextWakeAtMs?: number;
  lastActionAtMs?: number;
  lastUserVisibleUpdateAtMs?: number;
  blocker?: string;
  evidence: TaskEvidence[];
  lease?: TaskLease;
  stats: {
    runCount: number;
    sideEffectCount: number;
    noProgressCount: number;
  };
  createdAtMs: number;
  updatedAtMs: number;
};

export type TaskStoreFile = {
  version: 1;
  tasks: TaskRecord[];
};

export type TaskCreateInput = {
  agentId: string;
  originSessionKey: string;
  originMessageId?: string;
  title?: string;
  goal: string;
  acceptance: string[];
};

export type TaskCreateResult = {
  task: TaskRecord;
  queuePosition: number;
  startedImmediately: boolean;
};

export type TaskRunResultStatus =
  | "progress"
  | "waiting_external"
  | "waiting_approval"
  | "completed"
  | "failed";

export type TaskRunResult = {
  status: TaskRunResultStatus;
  update?: string;
  blocker?: string;
  evidence: string[];
  sideEffects: number;
  rawOutput?: string;
};
