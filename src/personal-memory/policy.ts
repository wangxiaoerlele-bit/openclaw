import type {
  PersonalMemoryRecord,
  PersonalMemorySelectionBudget,
  PersonalMemorySelectionRequest,
  PersonalMemorySelectionResult,
  PersonalMemoryStoreSnapshot,
} from "./types.js";

function defaultBudgetForChannel(
  channel: PersonalMemorySelectionRequest["channel"],
): Required<PersonalMemorySelectionBudget> {
  if (channel === "feishu") {
    return {
      maxRecords: 6,
      maxChars: 5000,
      maxWorking: 2,
      maxEpisodic: 2,
      maxSemantic: 3,
    };
  }
  return {
    maxRecords: 10,
    maxChars: 12000,
    maxWorking: 4,
    maxEpisodic: 4,
    maxSemantic: 5,
  };
}

function mergeBudget(
  channel: PersonalMemorySelectionRequest["channel"],
  override?: PersonalMemorySelectionBudget,
): Required<PersonalMemorySelectionBudget> {
  const base = defaultBudgetForChannel(channel);
  return {
    maxRecords: override?.maxRecords ?? base.maxRecords,
    maxChars: override?.maxChars ?? base.maxChars,
    maxWorking: override?.maxWorking ?? base.maxWorking,
    maxEpisodic: override?.maxEpisodic ?? base.maxEpisodic,
    maxSemantic: override?.maxSemantic ?? base.maxSemantic,
  };
}

function semanticKind(record: PersonalMemoryRecord): string | undefined {
  return typeof record.metadata?.kind === "string" ? record.metadata.kind : undefined;
}

function pickSemanticByTask(
  semantic: PersonalMemoryRecord[],
  taskKind: PersonalMemorySelectionRequest["taskKind"],
): { records: PersonalMemoryRecord[]; profile: string } {
  const byKind = new Map<string, PersonalMemoryRecord>();
  for (const r of semantic) {
    const kind = semanticKind(r);
    if (kind) {
      byKind.set(kind, r);
    }
  }

  const orderedKinds =
    taskKind === "daily-qa"
      ? ["current-focus", "working-rules"]
      : taskKind === "project-discussion"
        ? ["projects", "current-focus", "working-rules"]
        : taskKind === "decision-review"
          ? ["decision-log", "working-rules", "current-focus"]
          : taskKind === "planning"
            ? ["identity", "current-focus", "projects", "working-rules"]
            : ["current-focus", "projects", "working-rules"];

  const records = orderedKinds
    .map((kind) => byKind.get(kind))
    .filter(Boolean) as PersonalMemoryRecord[];
  return { records, profile: `${taskKind}:${orderedKinds.join(",")}` };
}

function charCost(record: PersonalMemoryRecord): number {
  return record.title.length + record.content.length + 32;
}

export function selectPersonalMemoryRecords(
  snapshot: PersonalMemoryStoreSnapshot,
  request: PersonalMemorySelectionRequest,
): PersonalMemorySelectionResult {
  const budget = mergeBudget(request.channel, request.budget);
  const semanticPick = pickSemanticByTask(snapshot.semantic, request.taskKind);

  const candidates: PersonalMemoryRecord[] = [
    ...snapshot.working.slice(0, budget.maxWorking),
    ...snapshot.episodic.slice(0, budget.maxEpisodic),
    ...semanticPick.records.slice(0, budget.maxSemantic),
  ];

  const selected: PersonalMemoryRecord[] = [];
  const dropped: Array<{ id: string; reason: "max-records" | "max-chars" }> = [];
  let usedChars = 0;

  for (const record of candidates) {
    if (selected.length >= budget.maxRecords) {
      dropped.push({ id: record.id, reason: "max-records" });
      continue;
    }
    const nextChars = usedChars + charCost(record);
    if (nextChars > budget.maxChars) {
      dropped.push({ id: record.id, reason: "max-chars" });
      continue;
    }
    selected.push(record);
    usedChars = nextChars;
  }

  return {
    selected,
    dropped,
    usedChars,
    budget,
    profile: semanticPick.profile,
  };
}

export function renderPersonalMemoryRecordSnippet(record: PersonalMemoryRecord): string {
  const kind = typeof record.metadata?.kind === "string" ? ` kind=${record.metadata.kind}` : "";
  const source = `[${record.layer}${kind}] ${record.title}`;
  const text = record.content.trim();
  const clipped = text.length > 700 ? `${text.slice(0, 700)}...` : text;
  return `${source}\n${clipped}`;
}
