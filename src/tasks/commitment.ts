const EXECUTION_COMMITMENT_PATTERNS = [
  /\b(i('|’)ll|i will)\s+(keep working|continue|continue working|continue pushing|keep pushing|follow through|carry this through)\b/i,
  /我(会|先|现在)?(继续推进|继续落实|继续跟进|继续做|先开工|马上处理|持续推进|继续收口)/,
] as const;

const LOW_SIGNAL_UPDATE_PATTERNS = [
  /\b(i('|’)m still working on it|i('|’)ll keep going|i('|’)ll continue)\b/i,
  /我(还在|会继续|继续)(推进|跟进|处理|做)/,
] as const;

export function hasExecutionCommitment(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) {
    return false;
  }
  return EXECUTION_COMMITMENT_PATTERNS.some((pattern) => pattern.test(cleaned));
}

export function isLowSignalExecutionUpdate(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) {
    return true;
  }
  return LOW_SIGNAL_UPDATE_PATTERNS.some((pattern) => pattern.test(cleaned));
}

export function buildTaskAcceptedText(params: {
  queuePosition: number;
  startedImmediately: boolean;
}): string {
  if (params.startedImmediately) {
    return "已登记为持续任务并开始执行。后续只在有新事实、明确阻塞或完成时汇报。";
  }
  return `已登记为持续任务，当前在队列第 ${params.queuePosition} 位。后续只在有新事实、明确阻塞或完成时汇报。`;
}

export function buildTaskTitle(goal: string): string {
  const compact = goal.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "持续任务";
  }
  return compact.length <= 80 ? compact : `${compact.slice(0, 77)}...`;
}
