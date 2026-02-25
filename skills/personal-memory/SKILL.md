---
name: personal-memory
description: "Use a structured local memory system in `personal-context/` for persistent personal/project context. Read only relevant files by scenario; suggest controlled write-back to `04-decision-log.md`."
metadata: { "openclaw": { "emoji": "🧠", "requires": { "bins": ["rg"] } } }
---

# Personal Memory

Use this skill to turn ad-hoc chat context into a maintainable local memory system backed by Markdown files in `personal-context/`.

This skill is designed for:

- long-lived personal AI workflows
- project continuity across sessions/channels
- controlled memory write-back (especially decisions)

This skill is **not** for storing secrets, tokens, passwords, or other sensitive credentials.

## Trigger

Use this skill when the user asks to:

- set up or improve a personal memory system
- make the AI "remember" projects/goals/preferences over time
- organize long-term context for better responses
- persist key facts/decisions into local Markdown files

Also use it implicitly when the user references the `personal-context/` folder.

## Memory Files (default layout)

Expected location:

- `personal-context/00-identity.md`
- `personal-context/01-current-focus.md`
- `personal-context/02-projects.md`
- `personal-context/03-working-rules.md`
- `personal-context/04-decision-log.md`

If the folder is missing, create it from templates before proceeding.

## Core Rule: Read by Scenario (not all files every time)

Do **not** load every memory file on every task. Read only the minimal set needed.

### Suggested read matrix

- Daily quick Q&A / Feishu chat
  - Read: `01-current-focus.md`, `03-working-rules.md`

- Project-specific discussion / planning
  - Read: `02-projects.md`, `01-current-focus.md`

- Decision review / tradeoff discussion
  - Read: `04-decision-log.md`, `03-working-rules.md`

- Long-term planning / first-time setup / identity-aligned advice
  - Read: `00-identity.md`, `01-current-focus.md`, `02-projects.md`

### Read order preference

1. `01-current-focus.md` (what matters now)
2. `03-working-rules.md` (how to collaborate)
3. `02-projects.md` (project state)
4. `04-decision-log.md` (history / rationale)
5. `00-identity.md` (low-frequency background)

## Controlled Write-Back Policy

Default behavior:

- **Do not auto-edit** memory files unless the user asks or clearly expects persistence.
- Prefer **suggested updates** first (show proposed diff/text).

### Best first write-back target

- `personal-context/04-decision-log.md`

This file is the safest and highest-value memory sink for:

- chosen approach
- rejected alternatives
- reasons / constraints
- follow-up actions

### What to write back

Good candidates:

- confirmed decisions
- stable project milestones
- recurring working rules the user explicitly approves

Bad candidates:

- raw brainstorming fragments
- unverified assumptions
- secrets / tokens / private credentials
- transient debugging noise

## Channel-Aware Behavior (important)

- **Feishu / IM channels**: prioritize quick answers + memory lookup only.
  - Avoid heavy local scanning unless needed.
  - Prefer reading `01-current-focus.md` and `03-working-rules.md`.

- **Web GUI / local terminal**: suitable for memory maintenance work.
  - Can read/edit memory files.
  - Can propose structured updates or batch cleanup.

## Common Workflows

## 1) Answer using memory context

1. Identify task type (daily Q&A / project / decision / planning)
2. Read only relevant memory files
3. Answer with explicit references to the current focus/project state
4. If a decision was made, propose a decision-log entry

## 2) Update current focus after a planning conversation

Use when the user confirms a new priority or next-step list.

Typical steps:

1. Read `personal-context/01-current-focus.md`
2. Propose a small edit (top priorities / key blockers / next actions)
3. Apply only after confirmation (or if user explicitly asked to update)

## 3) Record a confirmed decision

Use when the user commits to a path (tool choice, architecture, process, strategy).

Typical steps:

1. Read `personal-context/04-decision-log.md`
2. Append a new entry using the existing template
3. Include:
   - date
   - decision
   - reason
   - impact
   - next actions

## 4) Project memory sync

Use when project status has changed materially.

Typical steps:

1. Read `personal-context/02-projects.md`
2. Update:
   - current stage
   - done / in-progress / next actions
   - risks / blockers
3. If the change reflects a strategic choice, also update `04-decision-log.md`

## Command Snippets (read/search)

### Quick overview of memory files

```bash
ls -1 personal-context
```

### Search memory for a keyword

```bash
rg -n "keyword" personal-context/*.md
```

### Read current focus and rules first (low-noise)

```bash
sed -n '1,220p' personal-context/01-current-focus.md
sed -n '1,260p' personal-context/03-working-rules.md
```

### Read project memory

```bash
sed -n '1,320p' personal-context/02-projects.md
```

### Read decision history

```bash
sed -n '1,320p' personal-context/04-decision-log.md
```

### Append a decision entry (structured, with preview)

```bash
pnpm memory:add-decision --dry-run \
  --title "决策标题" \
  --background "背景" \
  --decision "决策内容" \
  --reason "原因"
```

### Summarize recent decisions

```bash
pnpm memory:summary --limit 5
```

### Refresh last-updated dates (batch)

```bash
pnpm memory:touch --all --dry-run
pnpm memory:touch --file 01-current-focus.md --file 02-projects.md
```

## Response Pattern (recommended)

When using memory context in an answer, prefer:

1. **What I used from memory** (briefly)
2. **Answer / recommendation**
3. **What should be updated in memory** (optional, if applicable)

This makes memory usage transparent and reduces hallucinated context.

## Memory Hygiene

### Weekly maintenance (recommended)

- clean stale priorities in `01-current-focus.md`
- update project stages in `02-projects.md`
- archive or summarize repetitive decisions in `04-decision-log.md`

### Anti-patterns

- storing secrets in memory files
- dumping full chat transcripts into memory
- rewriting `00-identity.md` frequently
- overloading `01-current-focus.md` with too many priorities
- auto-writing uncertain conclusions

## If files are missing or low quality

If the files are sparse or outdated:

- do not block the task
- answer with current info
- propose a minimal memory update afterward

If the user wants, offer to:

- normalize the file structure
- merge duplicate sections
- convert free text into a more structured format
