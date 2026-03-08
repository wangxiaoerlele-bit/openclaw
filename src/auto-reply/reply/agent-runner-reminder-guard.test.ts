import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCronStoreMock = vi.fn();

vi.mock("../../cron/store.js", async () => {
  const actual = await vi.importActual<typeof import("../../cron/store.js")>("../../cron/store.js");
  return {
    ...actual,
    loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
  };
});

import {
  appendUnscheduledReminderNote,
  hasSessionRelatedCronJobs,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";

describe("agent-runner reminder guard", () => {
  beforeEach(() => {
    loadCronStoreMock.mockReset();
    loadCronStoreMock.mockResolvedValue({ version: 1, jobs: [] });
  });

  it("detects reminder commitments", () => {
    expect(hasUnbackedReminderCommitment("I'll remind you tomorrow morning.")).toBe(true);
    expect(
      hasUnbackedReminderCommitment(
        "I'll remind you tomorrow morning.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
      ),
    ).toBe(false);
  });

  it("suppresses the note when an enabled cron exists for the same session", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "existing-job",
          enabled: true,
          sessionKey: "main",
        },
      ],
    });

    await expect(hasSessionRelatedCronJobs({ sessionKey: "main" })).resolves.toBe(true);
  });

  it("does not suppress the note for disabled or unrelated cron jobs", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "disabled-job",
          enabled: false,
          sessionKey: "main",
        },
        {
          id: "other-job",
          enabled: true,
          sessionKey: "other",
        },
      ],
    });

    await expect(hasSessionRelatedCronJobs({ sessionKey: "main" })).resolves.toBe(false);
  });

  it("appends the guard note once", () => {
    expect(
      appendUnscheduledReminderNote([
        { text: "I'll remind you tomorrow morning." },
        { text: "Another payload" },
      ]),
    ).toEqual([
      {
        text: "I'll remind you tomorrow morning.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
      },
      { text: "Another payload" },
    ]);
  });
});
