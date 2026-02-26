import fs from "node:fs";
import path from "node:path";
import {
  buildInitialPersonalMemorySnapshot,
  loadPersonalContextSemanticSeed,
  PERSONAL_CONTEXT_FILES,
} from "./personal-context.js";
import type {
  PersonalContextDocument,
  PersonalContextDecisionEntry,
  PersonalContextSemanticSeed,
  PersonalMemoryRefreshResult,
  PersonalMemoryRecord,
  PersonalMemoryStore,
  PersonalMemoryStoreSnapshot,
  PersonalMemoryStoreStatus,
} from "./types.js";

type FileBackedPersonalMemoryStoreOptions = {
  personalContextDir: string;
  runtimeStateFile?: string;
  maxPersistedEpisodic?: number;
  now?: () => Date;
};

type RuntimeOverlayStateV1 = {
  version: 1;
  working: PersonalMemoryRecord[];
  episodic: PersonalMemoryRecord[];
};

function emptySnapshot(): PersonalMemoryStoreSnapshot {
  return { working: [], episodic: [], semantic: [] };
}

function cloneRecord(record: PersonalMemoryRecord): PersonalMemoryRecord {
  return {
    ...record,
    tags: record.tags ? [...record.tags] : undefined,
    metadata: record.metadata ? { ...record.metadata } : undefined,
  };
}

function cloneSnapshot(snapshot: PersonalMemoryStoreSnapshot): PersonalMemoryStoreSnapshot {
  return {
    working: snapshot.working.map(cloneRecord),
    episodic: snapshot.episodic.map(cloneRecord),
    semantic: snapshot.semantic.map(cloneRecord),
  };
}

function cloneDocument(doc: PersonalContextDocument): PersonalContextDocument {
  return {
    ...doc,
    sections: doc.sections.map((section) => ({ ...section })),
  };
}

function cloneDecision(decision: PersonalContextDecisionEntry): PersonalContextDecisionEntry {
  return { ...decision };
}

function cloneSeed(seed: PersonalContextSemanticSeed): PersonalContextSemanticSeed {
  return {
    docs: seed.docs.map(cloneDocument),
    decisions: seed.decisions.map(cloneDecision),
  };
}

function fileFingerprint(baseDir: string): { fingerprint: string; fileCount: number } {
  const rows = Object.keys(PERSONAL_CONTEXT_FILES)
    .toSorted()
    .map((fileName) => {
      const fullPath = path.join(baseDir, fileName);
      const stat = fs.statSync(fullPath);
      return `${fileName}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    });
  return {
    fingerprint: rows.join("|"),
    fileCount: rows.length,
  };
}

export class FileBackedPersonalMemoryStore implements PersonalMemoryStore {
  private readonly personalContextDir: string;
  private readonly runtimeStateFile?: string;
  private readonly maxPersistedEpisodic: number;
  private readonly now: () => Date;
  private currentSnapshot: PersonalMemoryStoreSnapshot = emptySnapshot();
  private currentSeed: PersonalContextSemanticSeed = { docs: [], decisions: [] };
  private workingOverlay: PersonalMemoryRecord[] = [];
  private episodicOverlay: PersonalMemoryRecord[] = [];
  private runtimeOverlaysHydrated = false;
  private state: PersonalMemoryStoreStatus;

  constructor(opts: FileBackedPersonalMemoryStoreOptions) {
    this.personalContextDir = path.resolve(opts.personalContextDir);
    this.runtimeStateFile = opts.runtimeStateFile
      ? path.resolve(opts.runtimeStateFile)
      : path.join(this.personalContextDir, ".runtime-memory.json");
    this.maxPersistedEpisodic = Math.max(1, opts.maxPersistedEpisodic ?? 100);
    this.now = opts.now ?? (() => new Date());
    this.state = {
      personalContextDir: this.personalContextDir,
      runtimeStateFile: this.runtimeStateFile,
      initialized: false,
      refreshCount: 0,
      fileCount: 0,
      workingCount: 0,
      episodicCount: 0,
      semanticCount: 0,
    };
  }

  private sanitizeRuntimeRecord(
    record: unknown,
    expectedLayer: "working" | "episodic",
  ): PersonalMemoryRecord | undefined {
    if (!record || typeof record !== "object") {
      return undefined;
    }
    const value = record as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id : undefined;
    const title = typeof value.title === "string" ? value.title : undefined;
    const content = typeof value.content === "string" ? value.content : undefined;
    const createdAt = typeof value.createdAt === "string" ? value.createdAt : undefined;
    if (!id || !title || !content || !createdAt) {
      return undefined;
    }
    const source = value.source === "runtime" ? "runtime" : "runtime";
    const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : undefined;
    const tags = Array.isArray(value.tags)
      ? value.tags.filter((item): item is string => typeof item === "string")
      : undefined;
    const metadata =
      value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
        ? { ...(value.metadata as Record<string, unknown>) }
        : undefined;
    return {
      id,
      layer: expectedLayer,
      title,
      content,
      source,
      createdAt,
      updatedAt,
      tags,
      metadata,
    };
  }

  private loadRuntimeOverlays() {
    const nowIso = this.now().toISOString();
    if (!this.runtimeStateFile || !fs.existsSync(this.runtimeStateFile)) {
      this.workingOverlay = [];
      this.episodicOverlay = [];
      this.runtimeOverlaysHydrated = true;
      this.state = {
        ...this.state,
        runtimeStateLoadedAt: nowIso,
        runtimeStateLastError: undefined,
      };
      return;
    }
    try {
      const raw = fs.readFileSync(this.runtimeStateFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<RuntimeOverlayStateV1>;
      if (parsed.version !== 1) {
        throw new Error(`unsupported runtime memory state version: ${String(parsed.version)}`);
      }
      this.workingOverlay = Array.isArray(parsed.working)
        ? (parsed.working
            .map((record) => this.sanitizeRuntimeRecord(record, "working"))
            .filter(Boolean) as PersonalMemoryRecord[])
        : [];
      this.episodicOverlay = Array.isArray(parsed.episodic)
        ? (parsed.episodic
            .map((record) => this.sanitizeRuntimeRecord(record, "episodic"))
            .filter(Boolean)
            .slice(0, this.maxPersistedEpisodic) as PersonalMemoryRecord[])
        : [];
      this.state = {
        ...this.state,
        runtimeStateLoadedAt: nowIso,
        runtimeStateLastError: undefined,
      };
      this.runtimeOverlaysHydrated = true;
    } catch (err) {
      this.workingOverlay = [];
      this.episodicOverlay = [];
      this.runtimeOverlaysHydrated = true;
      this.state = {
        ...this.state,
        runtimeStateLoadedAt: nowIso,
        runtimeStateLastError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private ensureRuntimeOverlaysForMutation() {
    // Post-hook writes can happen before init()/refresh(); hydrate disk state first so we do not
    // overwrite existing runtime memory or suggestion-related GC inputs on first mutation.
    if (this.runtimeOverlaysHydrated) {
      return;
    }
    this.loadRuntimeOverlays();
    this.applySnapshot(buildInitialPersonalMemorySnapshot(this.currentSeed));
    this.state = this.updateStatusCounts(this.state);
  }

  private persistRuntimeOverlays() {
    if (!this.runtimeStateFile) {
      return;
    }
    const payload: RuntimeOverlayStateV1 = {
      version: 1,
      working: this.workingOverlay.map(cloneRecord),
      episodic: this.episodicOverlay.slice(0, this.maxPersistedEpisodic).map(cloneRecord),
    };
    try {
      fs.mkdirSync(path.dirname(this.runtimeStateFile), { recursive: true });
      const tmp = `${this.runtimeStateFile}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, this.runtimeStateFile);
      this.state = {
        ...this.state,
        runtimeStateLastError: undefined,
      };
    } catch (err) {
      this.state = {
        ...this.state,
        runtimeStateLastError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private applySnapshot(baseSnapshot: PersonalMemoryStoreSnapshot) {
    const episodicById = new Map<string, PersonalMemoryRecord>();
    for (const record of baseSnapshot.episodic) {
      episodicById.set(record.id, record);
    }
    for (const record of this.episodicOverlay) {
      episodicById.set(record.id, record);
    }

    this.currentSnapshot = {
      working: [...this.workingOverlay],
      episodic: [...episodicById.values()].toSorted((a, b) => {
        const aTs = a.updatedAt ?? a.createdAt;
        const bTs = b.updatedAt ?? b.createdAt;
        if (aTs !== bTs) {
          return bTs.localeCompare(aTs);
        }
        return b.title.localeCompare(a.title, "zh-CN");
      }),
      semantic: [...baseSnapshot.semantic],
    };
  }

  private updateStatusCounts(
    nextState: Omit<PersonalMemoryStoreStatus, "workingCount" | "episodicCount" | "semanticCount">,
  ): PersonalMemoryStoreStatus {
    return {
      ...this.state,
      ...nextState,
      workingCount: this.currentSnapshot.working.length,
      episodicCount: this.currentSnapshot.episodic.length,
      semanticCount: this.currentSnapshot.semantic.length,
    };
  }

  async init(): Promise<PersonalMemoryRefreshResult> {
    return this.refresh({ force: true });
  }

  async refresh(opts: { force?: boolean } = {}): Promise<PersonalMemoryRefreshResult> {
    const loadedAt = this.now().toISOString();
    try {
      const { fingerprint, fileCount } = fileFingerprint(this.personalContextDir);
      const unchanged =
        this.state.initialized && !opts.force && this.state.lastFingerprint === fingerprint;
      if (unchanged) {
        this.state = {
          ...this.state,
          fileCount,
          lastLoadedAt: loadedAt,
          lastError: undefined,
        };
        return { changed: false, fingerprint, loadedAt };
      }

      const seed = loadPersonalContextSemanticSeed(this.personalContextDir);
      const snapshot = buildInitialPersonalMemorySnapshot(seed);
      this.loadRuntimeOverlays();
      this.currentSeed = seed;
      this.applySnapshot(snapshot);
      this.state = this.updateStatusCounts({
        personalContextDir: this.personalContextDir,
        initialized: true,
        lastLoadedAt: loadedAt,
        lastFingerprint: fingerprint,
        refreshCount: this.state.refreshCount + 1,
        fileCount,
      });
      return { changed: true, fingerprint, loadedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = {
        ...this.state,
        lastLoadedAt: loadedAt,
        lastError: message,
      };
      throw err;
    }
  }

  snapshot(): PersonalMemoryStoreSnapshot {
    return cloneSnapshot(this.currentSnapshot);
  }

  seed(): PersonalContextSemanticSeed {
    return cloneSeed(this.currentSeed);
  }

  status(): PersonalMemoryStoreStatus {
    return { ...this.state };
  }

  upsertWorkingRecord(
    params: Omit<PersonalMemoryRecord, "layer" | "source"> & { source?: "runtime" },
  ): PersonalMemoryRecord {
    this.ensureRuntimeOverlaysForMutation();
    const record: PersonalMemoryRecord = {
      ...params,
      layer: "working",
      source: params.source ?? "runtime",
    };
    const next = [...this.workingOverlay];
    const idx = next.findIndex((item) => item.id === record.id);
    if (idx >= 0) {
      next[idx] = record;
    } else {
      next.unshift(record);
    }
    this.workingOverlay = next;
    this.persistRuntimeOverlays();
    this.currentSnapshot = {
      ...this.currentSnapshot,
      working: [...this.workingOverlay],
    };
    this.state = this.updateStatusCounts(this.state);
    return record;
  }

  appendEpisodicRecord(
    params: Omit<PersonalMemoryRecord, "layer" | "source"> & { source?: "runtime" },
  ): PersonalMemoryRecord {
    this.ensureRuntimeOverlaysForMutation();
    const record: PersonalMemoryRecord = {
      ...params,
      layer: "episodic",
      source: params.source ?? "runtime",
    };
    this.episodicOverlay = [
      record,
      ...this.episodicOverlay.filter((item) => item.id !== record.id),
    ].slice(0, this.maxPersistedEpisodic);
    this.persistRuntimeOverlays();
    this.applySnapshot(buildInitialPersonalMemorySnapshot(this.currentSeed));
    this.state = this.updateStatusCounts(this.state);
    return record;
  }

  removeWorkingRecord(id: string): boolean {
    this.ensureRuntimeOverlaysForMutation();
    const next = this.workingOverlay.filter((item) => item.id !== id);
    if (next.length === this.workingOverlay.length) {
      return false;
    }
    this.workingOverlay = next;
    this.persistRuntimeOverlays();
    this.currentSnapshot = {
      ...this.currentSnapshot,
      working: [...this.workingOverlay],
    };
    this.state = this.updateStatusCounts(this.state);
    return true;
  }

  clearWorkingRecords(): void {
    this.ensureRuntimeOverlaysForMutation();
    this.workingOverlay = [];
    this.persistRuntimeOverlays();
    this.currentSnapshot = {
      ...this.currentSnapshot,
      working: [],
    };
    this.state = this.updateStatusCounts(this.state);
  }
}
