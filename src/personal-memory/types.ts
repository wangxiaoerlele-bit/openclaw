export type PersonalMemoryLayer = "working" | "episodic" | "semantic";

export type PersonalMemoryRecord = {
  id: string;
  layer: PersonalMemoryLayer;
  title: string;
  content: string;
  source: "personal-context" | "runtime";
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type PersonalMemoryStoreSnapshot = {
  working: PersonalMemoryRecord[];
  episodic: PersonalMemoryRecord[];
  semantic: PersonalMemoryRecord[];
};

export type PersonalMemoryStoreStatus = {
  personalContextDir: string;
  runtimeStateFile?: string;
  initialized: boolean;
  lastLoadedAt?: string;
  lastFingerprint?: string;
  refreshCount: number;
  fileCount: number;
  workingCount: number;
  episodicCount: number;
  semanticCount: number;
  lastError?: string;
  runtimeStateLoadedAt?: string;
  runtimeStateLastError?: string;
};

export type PersonalMemoryRefreshResult = {
  changed: boolean;
  fingerprint: string;
  loadedAt: string;
};

export interface PersonalMemoryStore {
  init(): Promise<PersonalMemoryRefreshResult>;
  refresh(opts?: { force?: boolean }): Promise<PersonalMemoryRefreshResult>;
  snapshot(): PersonalMemoryStoreSnapshot;
  status(): PersonalMemoryStoreStatus;
  upsertWorkingRecord(
    params: Omit<PersonalMemoryRecord, "layer" | "source"> & { source?: "runtime" },
  ): PersonalMemoryRecord;
  appendEpisodicRecord(
    params: Omit<PersonalMemoryRecord, "layer" | "source"> & { source?: "runtime" },
  ): PersonalMemoryRecord;
  removeWorkingRecord(id: string): boolean;
  clearWorkingRecords(): void;
}

export type PersonalMemoryChannel =
  | "feishu"
  | "web-gui"
  | "telegram"
  | "discord"
  | "slack"
  | "signal"
  | "imessage"
  | "whatsapp"
  | "matrix"
  | "msteams"
  | "mattermost"
  | "googlechat"
  | "nextcloud-talk"
  | "irc"
  | "zalo"
  | "zalouser"
  | "bluebubbles"
  | "tlon"
  | "twitch"
  | "unknown";

export type PersonalMemoryTaskKind =
  | "daily-qa"
  | "project-discussion"
  | "decision-review"
  | "planning"
  | "unknown";

export type PersonalMemorySelectionBudget = {
  maxRecords?: number;
  maxChars?: number;
  maxWorking?: number;
  maxEpisodic?: number;
  maxSemantic?: number;
};

export type PersonalMemorySelectionRequest = {
  channel: PersonalMemoryChannel;
  taskKind: PersonalMemoryTaskKind;
  budget?: PersonalMemorySelectionBudget;
};

export type PersonalMemorySelectionResult = {
  selected: PersonalMemoryRecord[];
  dropped: Array<{ id: string; reason: "max-records" | "max-chars" }>;
  usedChars: number;
  budget: Required<PersonalMemorySelectionBudget>;
  profile: string;
};

export type PersonalMemorySearchRequest = {
  query: string;
  limit?: number;
  layers?: PersonalMemoryLayer[];
  mode?: "keyword" | "hybrid" | "semantic";
  rerank?: {
    enabled?: boolean;
    topK?: number;
    lambda?: number;
    strategy?: "mmr-lite" | "hybrid-v2";
  };
};

export type PersonalMemorySearchHit = {
  id: string;
  layer: PersonalMemoryLayer;
  title: string;
  score: number;
  keywordScore?: number;
  semanticScore?: number;
  reasons: string[];
  snippet: string;
  tags?: string[];
};

export type PersonalMemorySearchResult = {
  query: string;
  limit: number;
  mode: "keyword" | "hybrid" | "semantic";
  totalHits: number;
  hits: PersonalMemorySearchHit[];
  rerank?: {
    enabled: boolean;
    applied: boolean;
    strategy: "mmr-lite" | "hybrid-v2";
    topK: number;
    rerankedCount: number;
    movedCount: number;
    reason?: string;
  };
  cache?: {
    enabled: boolean;
    backend?: "sparse-cache" | "sqlite-vec";
    filePath?: string;
    cacheHit?: boolean;
    rebuilt?: boolean;
    reason?: string;
    fingerprint?: string;
    builtAt?: string;
    semanticRecordCount?: number;
  };
};

export type PersonalMemoryPreSessionContext = {
  request: PersonalMemorySelectionRequest;
  refresh: PersonalMemoryRefreshResult;
  selection: PersonalMemorySelectionResult;
  snippets: string[];
  search?: PersonalMemorySearchResult;
};

export type PersonalMemoryWriteTarget =
  | "decision-log"
  | "current-focus"
  | "projects"
  | "working-rules"
  | "identity";

export type PersonalMemoryWriteSuggestion = {
  level: "L0" | "L1" | "L2" | "L3";
  target?: PersonalMemoryWriteTarget;
  reason: string;
  title?: string;
  content?: string;
  structured?: Record<string, string>;
};

export type PersonalMemoryPostSessionInput = {
  channel: PersonalMemoryChannel;
  taskKind: PersonalMemoryTaskKind;
  summary: string;
  userConfirmed?: boolean;
  decisionTitle?: string;
  decision?: string;
  reason?: string;
  background?: string;
  next?: string;
  links?: string;
};

export type PersonalContextDocKind =
  | "identity"
  | "current-focus"
  | "projects"
  | "working-rules"
  | "decision-log";

export type PersonalContextSection = {
  heading: string;
  body: string;
};

export type PersonalContextDocument = {
  kind: PersonalContextDocKind;
  fileName: string;
  title?: string;
  lastUpdatedDate?: string;
  applicablePeriod?: string;
  sections: PersonalContextSection[];
  rawText: string;
};

export type PersonalContextDecisionEntry = {
  date: string;
  title: string;
  background?: string;
  decision?: string;
  reason?: string;
  impact?: string;
  next?: string;
  links?: string;
};

export type PersonalContextSemanticSeed = {
  docs: PersonalContextDocument[];
  decisions: PersonalContextDecisionEntry[];
};
