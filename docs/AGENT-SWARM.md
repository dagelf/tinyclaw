# Agent Swarm: Batch Processing at Scale

## The Problem

TinyClaw's team model works beautifully for conversational workflows: a user asks a question, agents collaborate, and a response comes back. But some tasks aren't conversations — they're **data processing jobs**. Reviewing 3,000 PRs. Triaging 500 issues. Auditing an entire codebase.

The conversational model breaks down here:
- **Context window limits**: No single agent can hold 3,000 PRs in memory
- **Sequential bottleneck**: Team fan-out caps at ~15 messages (loop protection)
- **Unstructured data**: Free-text responses can't be aggregated programmatically
- **No persistence**: If the process crashes at PR #2,847, you start over

The swarm model solves this by treating agents as **stateless compute workers** in a MapReduce pipeline, processing structured data in batches.

---

## Architecture Overview

```
                        ┌──────────────────────────┐
                        │      SwarmCoordinator     │
                        │  (orchestrates the job)   │
                        └─────────┬────────────────┘
                                  │
               ┌──────────────────┼──────────────────┐
               ▼                  ▼                  ▼
        ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
        │  Phase: Map  │   │Phase: Reduce│   │Phase: Review│
        │  (parallel)  │   │ (aggregate) │   │ (selective)  │
        └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
               │                  │                  │
        ┌──────┴──────┐          │           ┌──────┴──────┐
        ▼      ▼      ▼         ▼           ▼      ▼      ▼
     ┌────┐ ┌────┐ ┌────┐  ┌────────┐   ┌────┐ ┌────┐ ┌────┐
     │ W1 │ │ W2 │ │ W3 │  │Reducer │   │ R1 │ │ R2 │ │ R3 │
     │    │ │    │ │... │  │ Agent  │   │    │ │    │ │... │
     └────┘ └────┘ └────┘  └────────┘   └────┘ └────┘ └────┘
       │      │      │         │           │      │      │
       ▼      ▼      ▼         ▼           ▼      ▼      ▼
    [JSON] [JSON] [JSON]    [JSON]      [JSON] [JSON] [JSON]
```

### Core Concepts

| Concept | Description |
|---------|-------------|
| **Job** | A complete pipeline definition: data source → phases → output |
| **Phase** | A stage in the pipeline (map, reduce, filter, review) |
| **Batch** | A slice of the input data assigned to one worker |
| **Worker** | A stateless agent invocation that processes one batch |
| **Schema** | JSON schema defining the input/output contract for each phase |

### How It Differs from Teams

| | Teams (existing) | Swarm (new) |
|---|---|---|
| **Unit of work** | A conversation | A data processing job |
| **Agent state** | Persistent (conversation history) | Stateless (fresh each batch) |
| **Data format** | Free text | Structured JSON with schemas |
| **Scale** | ~15 messages per conversation | Thousands of items |
| **Concurrency** | Per-agent promise chains | Configurable worker pool |
| **Failure handling** | Conversation aborts | Retry individual batches |
| **Output** | Aggregated text response | Structured report / actions |

---

## The PR Review Pipeline

This is the concrete use case driving the design. The job: scan 3,000+ open PRs on a repo, de-duplicate, rank, deep-review the best candidates, and produce an actionable report.

### Phase 0: Ingest

Not an agent phase — this is pure data fetching.

```
GitHub API (via gh CLI)
    │
    ├── Fetch all open PRs (paginated, 100/page = 30 API calls)
    │   → title, body, author, created_at, updated_at, labels
    │   → files changed (names + stats), comments count
    │   → CI status, review status, merge conflicts
    │
    ├── Optionally fetch diffs for top candidates (Phase 3 only)
    │
    └── Store as JSON array in job working directory
        → ~/.tinyclaw/swarm/jobs/{job_id}/data/prs.json
```

Data per PR (~500 bytes each, 3000 PRs = ~1.5 MB total):

```jsonc
{
  "number": 1234,
  "title": "Add dark mode support",
  "body": "This PR implements...",  // truncated to 500 chars
  "author": "alice",
  "created_at": "2026-02-10T...",
  "updated_at": "2026-02-14T...",
  "labels": ["feature", "ui"],
  "files": ["src/theme.ts", "src/components/App.tsx"],
  "additions": 245,
  "deletions": 12,
  "comments": 3,
  "ci_status": "success",
  "review_status": "approved",
  "has_conflicts": false
}
```

### Phase 1: Map — Scan & Classify

**Goal**: Every PR gets a structured classification. This is the "scatter" step.

```
Config:
  batch_size: 50         # PRs per worker
  concurrency: 20        # parallel workers
  model: sonnet          # fast + cheap for classification
  timeout: 120s          # per batch

Input: batch of 50 PR metadata objects + vision document
Output: 50 classification objects (1:1 with input)
```

**Worker system prompt**:
```
You are a PR classifier. For each PR in the input batch, produce a JSON
classification. You have the project's vision document for alignment scoring.

Output ONLY a JSON array. No commentary.
```

**Worker input** (per batch):
```jsonc
{
  "vision_document": "OpenClaw is a ... (project goals, non-goals, architecture)",
  "prs": [ /* 50 PR objects */ ]
}
```

**Worker output** (per batch):
```jsonc
[
  {
    "number": 1234,
    "category": "feature",           // bug-fix, feature, refactor, docs, test, chore, spam
    "intent": "dark-mode-support",   // normalized short description
    "areas": ["ui", "theming"],      // logical areas touched
    "quality_signals": {
      "has_description": true,
      "has_tests": false,
      "ci_passing": true,
      "small_diff": true,            // < 500 lines
      "single_concern": true         // touches related files only
    },
    "vision_alignment": 8,           // 0-10, how well it fits the project vision
    "vision_notes": "Aligns with UI improvement goals",
    "fingerprint": "dark-mode-theme-ui",  // normalized key for dedup grouping
    "flags": [],                     // ["spam", "off-vision", "massive-diff", "no-description"]
    "quick_verdict": "review"        // merge, review, close, spam
  }
]
```

**Math**: 3,000 PRs / 50 per batch = 60 batches. At 20 concurrent workers, that's 3 waves. ~6 minutes total.

### Phase 2: Reduce — Cluster & De-duplicate

**Goal**: Group similar PRs, identify duplicates, rank within each cluster.

This phase has lower parallelism because it needs to see cross-batch patterns. The reducer works on the *full* set of Phase 1 outputs, but the data is now compressed (classification objects are ~200 bytes each, so 3,000 = ~600 KB — fits in one context window).

```
Config:
  concurrency: 1-3       # reducers (can shard by category)
  model: sonnet           # needs reasoning for clustering
  timeout: 300s
```

**Strategy**: Two-pass reduce.

**Pass 1 — Programmatic pre-clustering** (no agent needed):
- Group by `fingerprint` field (exact match)
- Group by overlapping `files` (Jaccard similarity > 0.5)
- Group by similar `intent` (edit distance / token overlap)
- This produces initial clusters cheaply

**Pass 2 — Agent-assisted refinement**:
```jsonc
// Input: pre-clusters + vision doc
{
  "vision_document": "...",
  "clusters": [
    {
      "id": "cluster-17",
      "theme": "dark-mode",
      "prs": [
        { "number": 1234, "title": "Add dark mode support", "author": "alice", "quality_signals": {...}, "vision_alignment": 8 },
        { "number": 1567, "title": "Dark theme implementation", "author": "bob", "quality_signals": {...}, "vision_alignment": 7 },
        { "number": 2890, "title": "Night mode toggle", "author": "charlie", "quality_signals": {...}, "vision_alignment": 6 }
      ]
    }
  ]
}
```

**Output**:
```jsonc
[
  {
    "cluster_id": "cluster-17",
    "theme": "Dark mode / theming",
    "duplicate_groups": [
      {
        "canonical": 1234,
        "duplicates": [1567, 2890],
        "confidence": 0.9,
        "reasoning": "All three implement the same dark mode toggle feature"
      }
    ],
    "best_candidate": 1234,
    "ranking": [1234, 1567, 2890],
    "ranking_rationale": "PR #1234 has the best test coverage and smallest diff"
  }
]
```

### Phase 3: Deep Review — Top Candidates Only

**Goal**: Full code review of the best PR in each cluster. This is expensive (fetches diffs), so only the top candidates get it.

```
Config:
  batch_size: 5          # PRs per worker (full diffs are large)
  concurrency: 10        # parallel reviewers
  model: opus            # needs deep reasoning for code review
  timeout: 300s
```

**Selective diff fetching**: Only fetch diffs for PRs that made it through Phase 2 as `best_candidate`. If there are 200 clusters, that's 200 diffs to fetch instead of 3,000.

**Worker input**:
```jsonc
{
  "vision_document": "...",
  "pr": {
    "number": 1234,
    "title": "Add dark mode support",
    "author": "alice",
    "diff": "... (full diff) ...",
    "cluster_context": {
      "theme": "Dark mode / theming",
      "duplicate_count": 3,
      "is_best_candidate": true
    },
    "classification": { /* Phase 1 output */ }
  }
}
```

**Worker output**:
```jsonc
{
  "number": 1234,
  "verdict": "merge",              // merge, request-changes, close
  "confidence": 0.85,
  "review": {
    "summary": "Clean implementation of dark mode with CSS variables...",
    "strengths": ["Small, focused diff", "Uses existing theme infrastructure"],
    "concerns": ["Missing tests for toggle persistence", "No RTL support"],
    "vision_alignment_detail": "Directly supports the UI modernization goal...",
    "code_quality": 8,             // 0-10
    "test_coverage": 4,            // 0-10
    "architecture_fit": 9          // 0-10
  },
  "recommended_action": "merge",
  "action_notes": "Merge after adding toggle persistence test"
}
```

### Phase 4: Report — Synthesize

**Goal**: Produce an actionable summary. Single agent, full context.

**Output structure**:
```markdown
# OpenClaw PR Review Report
**Date**: 2026-02-16 | **Total PRs scanned**: 3,127 | **Clusters found**: 203

## Executive Summary
- 3,127 open PRs analyzed across 203 distinct themes
- 847 PRs identified as duplicates (reducible to 203 unique efforts)
- 42 PRs recommended for immediate merge
- 89 PRs recommended for closure (duplicates, off-vision, spam)

## Recommended Actions

### Merge (42 PRs)
| PR | Title | Author | Cluster | Quality | Vision | Notes |
|----|-------|--------|---------|---------|--------|-------|
| #1234 | Add dark mode | alice | Dark mode (3 dupes) | 8/10 | 9/10 | Add tests first |

### Close — Duplicates (847 PRs)
| PR | Duplicate Of | Confidence |
|----|-------------|------------|
| #1567 | #1234 | 90% |
| #2890 | #1234 | 90% |

### Close — Off-Vision (23 PRs)
| PR | Title | Vision Score | Reason |
|----|-------|-------------|--------|
| #999 | Add crypto mining | 0/10 | Completely unrelated to project |

### Needs Human Review (128 PRs)
...

## Cluster Details
### Cluster: Dark Mode (3 PRs)
- **Best**: #1234 by alice — [detailed review]
- **Duplicates**: #1567 (bob), #2890 (charlie)
- **Recommendation**: Merge #1234, close others with comment linking to #1234
```

---

## System Architecture

### Directory Structure

```
src/swarm/
├── coordinator.ts       # Job lifecycle management
├── phase-executor.ts    # Runs map/reduce/review phases
├── worker-pool.ts       # Manages concurrent agent invocations
├── batch-splitter.ts    # Splits input data into batches
├── schema-validator.ts  # Validates worker JSON output against schemas
├── data-store.ts        # Reads/writes phase data to disk
├── reporter.ts          # Generates final reports
├── retry.ts             # Retry logic for failed batches
└── jobs/
    └── pr-review.ts     # PR review job definition (GitHub-specific)

src/swarm/prompts/
├── pr-classifier.md     # Phase 1 system prompt
├── pr-clusterer.md      # Phase 2 system prompt
├── pr-reviewer.md       # Phase 3 system prompt
└── pr-reporter.md       # Phase 4 system prompt
```

### Job Definition

```typescript
interface SwarmJob {
  id: string;
  name: string;
  status: 'pending' | 'ingesting' | 'running' | 'completed' | 'failed';
  created_at: number;
  phases: SwarmPhase[];
  current_phase: number;
  config: {
    repo?: string;                    // e.g. "owner/repo"
    vision_document?: string;         // path or inline
    output_format: 'markdown' | 'json' | 'github-comments';
  };
}

interface SwarmPhase {
  name: string;
  type: 'map' | 'reduce' | 'review' | 'report';
  status: 'pending' | 'running' | 'completed' | 'failed';
  config: {
    batch_size: number;
    concurrency: number;
    model: string;                    // 'sonnet', 'opus', 'haiku'
    provider: string;                 // 'anthropic', 'openai'
    timeout_ms: number;
    retries: number;
    system_prompt: string;            // path to prompt file
    input_schema?: object;            // JSON schema for validation
    output_schema?: object;
  };
  progress: {
    total_batches: number;
    completed_batches: number;
    failed_batches: number;
    items_processed: number;
  };
}
```

### Worker Pool

The worker pool manages concurrent agent invocations with backpressure:

```typescript
interface WorkerPool {
  concurrency: number;        // max simultaneous workers
  active: number;             // currently running
  queue: BatchTask[];         // waiting to be processed
  results: BatchResult[];     // completed results
  errors: BatchError[];       // failed batches (for retry)
}

interface BatchTask {
  batch_id: string;
  phase: string;
  input: any;                 // structured JSON
  system_prompt: string;
  model: string;
  timeout_ms: number;
  attempt: number;            // retry count
}

interface BatchResult {
  batch_id: string;
  output: any;                // parsed JSON from agent
  duration_ms: number;
  tokens_used?: number;
}
```

Key behaviors:
- **Backpressure**: When all workers are busy, new batches wait in queue
- **Retry**: Failed batches go back to queue with exponential backoff (max 3 retries)
- **Timeout**: Workers that exceed timeout are killed and the batch is retried
- **Validation**: Worker output is validated against the phase's output schema; invalid output triggers a retry with the validation error appended to the prompt
- **Progress**: Real-time progress emitted as events (for TUI visualization)

### How Workers Differ from Team Agents

Team agents are **persistent** — they maintain conversation history, work in their own directory, and have a personality (SOUL.md). Swarm workers are **ephemeral**:

```typescript
// Swarm worker invocation (new function, not invokeAgent)
async function invokeWorker(task: BatchTask): Promise<BatchResult> {
  // Each worker gets a fresh, temporary working directory
  const tmpDir = createTempDir(`swarm-${task.batch_id}`);

  // No conversation continuity (-c flag NOT used)
  // No SOUL.md or AGENTS.md
  // System prompt is the phase prompt + input data
  const prompt = `${task.system_prompt}\n\n## Input\n\`\`\`json\n${JSON.stringify(task.input)}\n\`\`\``;

  const args = ['--dangerously-skip-permissions', '--model', task.model, '-p', prompt];

  const result = await runCommandWithTimeout('claude', args, tmpDir, task.timeout_ms);

  // Parse and validate JSON output
  const parsed = extractJSON(result);
  validateSchema(parsed, task.output_schema);

  // Cleanup
  removeTempDir(tmpDir);

  return { batch_id: task.batch_id, output: parsed, duration_ms: elapsed };
}
```

### Data Store

Each phase writes its output to disk as JSON. This enables:
- **Resumability**: If the job crashes, resume from the last completed phase
- **Inspectability**: Human can review intermediate results
- **Debugging**: Replay a single batch with modified prompts

```
~/.tinyclaw/swarm/jobs/{job_id}/
├── job.json                          # Job definition + status
├── data/
│   ├── prs.json                      # Raw ingested data (Phase 0)
│   ├── classifications.json          # Phase 1 output (all batches merged)
│   ├── clusters.json                 # Phase 2 output
│   ├── reviews.json                  # Phase 3 output
│   └── report.md                     # Phase 4 output
├── batches/
│   ├── phase1/
│   │   ├── batch-001-input.json
│   │   ├── batch-001-output.json
│   │   ├── batch-002-input.json
│   │   ├── batch-002-output.json
│   │   └── ...
│   ├── phase2/
│   └── phase3/
├── prompts/                          # Resolved prompts used (for reproducibility)
│   ├── phase1-system.md
│   ├── phase2-system.md
│   └── phase3-system.md
└── events/                           # Swarm-specific events for TUI
    ├── 1708099200000-phase-start.json
    ├── 1708099201000-batch-complete.json
    └── ...
```

---

## CLI Interface

```bash
# Define and run a PR review job
tinyclaw swarm pr-review owner/repo \
  --vision ./VISION.md \
  --concurrency 20 \
  --model sonnet \
  --output report.md

# Generic swarm job from a definition file
tinyclaw swarm run job-definition.json

# Check job status
tinyclaw swarm status {job_id}

# Resume a failed/interrupted job
tinyclaw swarm resume {job_id}

# List all jobs
tinyclaw swarm list

# Live visualization
tinyclaw swarm watch {job_id}

# Re-run a specific phase with modified prompts
tinyclaw swarm rerun {job_id} --phase 2 --prompt ./new-clusterer.md

# Export results
tinyclaw swarm export {job_id} --format json
tinyclaw swarm export {job_id} --format markdown
tinyclaw swarm export {job_id} --format github-comments  # post as PR comments
```

---

## TUI Visualization

Extend the existing team visualizer with a swarm view:

```
┌─ Swarm: PR Review (job_a1b2c3) ─────────────────────────────────────────────┐
│ Repo: openclaw/openclaw | PRs: 3,127 | Vision: VISION.md                    │
│                                                                              │
│ Phase 1: Scan & Classify          ████████████████████░░░░  78% (47/60)      │
│   Workers: 20/20 active | Failed: 1 (retrying) | Avg: 23s/batch             │
│                                                                              │
│ Phase 2: Cluster & De-duplicate   ░░░░░░░░░░░░░░░░░░░░░░░░  waiting         │
│ Phase 3: Deep Review              ░░░░░░░░░░░░░░░░░░░░░░░░  waiting         │
│ Phase 4: Report                   ░░░░░░░░░░░░░░░░░░░░░░░░  waiting         │
│                                                                              │
│ ┌─ Recent Activity ────────────────────────────────────────────────────────┐ │
│ │ 14:23:01  batch-047 completed (50 PRs, 21s, sonnet)                     │ │
│ │ 14:22:58  batch-046 completed (50 PRs, 24s, sonnet)                     │ │
│ │ 14:22:45  batch-012 RETRY #1 (parse error, requeued)                    │ │
│ │ 14:22:40  batch-045 completed (50 PRs, 19s, sonnet)                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ Estimated remaining: ~2 min | Tokens used: ~1.2M | Cost: ~$3.40             │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Cost Estimation

For the 3,000 PR review job:

| Phase | Batches | Model | Input tokens/batch | Output tokens/batch | Total tokens | Estimated cost |
|-------|---------|-------|-------------------|---------------------|-------------|----------------|
| 1: Classify | 60 | Sonnet | ~15K | ~5K | ~1.2M | ~$4.80 |
| 2: Cluster | 3 | Sonnet | ~50K | ~10K | ~180K | ~$0.72 |
| 3: Review | 40 | Opus | ~20K | ~3K | ~920K | ~$20.70 |
| 4: Report | 1 | Opus | ~30K | ~5K | ~35K | ~$0.79 |
| **Total** | | | | | **~2.3M** | **~$27** |

~$27 to review 3,000 PRs. Time: ~15 minutes end-to-end.

---

## Vision Document Integration

The vision document is the project's north star. It tells workers what the project *should* look like, so they can flag PRs that stray.

```markdown
# OpenClaw Vision

## What We Are
- A lightweight, extensible AI agent framework
- Focused on CLI-first workflows
- Multi-provider (Claude, GPT, open-source)

## What We Are Not
- Not a web application framework
- Not a chatbot platform
- Not a model training toolkit

## Architecture Principles
- File-based communication (no databases)
- Agent isolation via working directories
- Minimal dependencies

## Current Priorities (Q1 2026)
1. Agent swarm / batch processing
2. Plugin ecosystem
3. Performance optimization

## Non-Goals
- GUI/web dashboard (CLI + TUI only)
- Cloud hosting / SaaS
- Model fine-tuning
```

Workers use this to:
- Score vision alignment (0-10)
- Flag PRs that introduce non-goals (e.g., "Add web dashboard" → 0/10)
- Prioritize PRs that align with current priorities

---

## Extensibility: Beyond PR Review

The swarm architecture is generic. The PR review pipeline is just one job definition. Other jobs:

### Issue Triage
```
Ingest: Fetch all open issues
Map: Classify (bug, feature request, question, duplicate, stale)
Reduce: Cluster by topic, link duplicates
Report: Triage recommendations
```

### Codebase Audit
```
Ingest: List all source files
Map: Analyze each file (complexity, test coverage, TODOs, security issues)
Reduce: Aggregate by module/directory
Report: Health report with hotspots
```

### Dependency Review
```
Ingest: Parse package.json / requirements.txt
Map: Check each dependency (license, vulnerabilities, maintenance status)
Reduce: Risk assessment
Report: Dependency health report
```

### Documentation Gap Analysis
```
Ingest: List all public APIs + existing docs
Map: Check each API for documentation coverage
Reduce: Identify gaps
Report: Documentation TODO list
```

---

## Implementation Plan

### Milestone 1: Core Infrastructure
- [ ] `SwarmCoordinator` — job lifecycle (create, run, pause, resume)
- [ ] `WorkerPool` — concurrent agent invocations with backpressure
- [ ] `DataStore` — JSON read/write between phases
- [ ] `SchemaValidator` — validate worker output
- [ ] `invokeWorker()` — stateless agent invocation (no history, temp dirs)
- [ ] CLI: `tinyclaw swarm run`, `status`, `list`

### Milestone 2: PR Review Pipeline
- [ ] GitHub data ingestion via `gh` CLI
- [ ] Phase 1 prompt: PR classifier
- [ ] Phase 2 logic: programmatic pre-clustering + agent refinement
- [ ] Phase 3 prompt: deep code reviewer
- [ ] Phase 4 prompt: report synthesizer
- [ ] CLI: `tinyclaw swarm pr-review`

### Milestone 3: Visualization & UX
- [ ] Swarm TUI view (progress bars, activity log, cost tracker)
- [ ] Event emission for swarm phases
- [ ] `tinyclaw swarm watch` command

### Milestone 4: Resilience & Optimization
- [ ] Batch retry with exponential backoff
- [ ] Job resumability (resume from last completed phase/batch)
- [ ] Prompt caching (reuse vision doc across batches)
- [ ] Adaptive batch sizing (larger batches for simpler items)
- [ ] Rate limiting awareness (GitHub API, model API)

### Milestone 5: Actions & Integration
- [ ] `--output github-comments` — post reviews directly as PR comments
- [ ] `--output github-labels` — auto-label PRs based on classification
- [ ] `--auto-close duplicates` — close duplicate PRs with linking comment
- [ ] Webhook trigger — run swarm job on schedule or PR threshold
- [ ] Slack/Discord notifications on job completion

---

## Open Questions

1. **Anthropic Batch API**: Claude has a batch API that processes requests asynchronously at 50% cost. Should we support this as an alternative to real-time worker invocations? Trade-off: cheaper but slower (up to 24h turnaround). For 3,000 PRs this would cut costs from ~$27 to ~$14.

2. **Embedding-based dedup**: For Phase 2 pre-clustering, should we use text embeddings (e.g., `voyage-3-large`) for semantic similarity instead of/in addition to string heuristics? More accurate but adds a dependency and cost.

3. **Human-in-the-loop checkpoints**: Should certain phases pause for human review before proceeding? E.g., review the clusters before running expensive deep reviews. The infrastructure supports this (phases are independent), but the UX needs design.

4. **Multi-repo support**: The PR review pipeline assumes a single repo. Should the job definition support multiple repos in one run? This would help organizations managing many related repos.

5. **Agent SDK vs CLI invocation**: Currently `invokeWorker()` calls the Claude CLI as a subprocess. For high-concurrency swarm work, the [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/agent) (`@anthropic-ai/claude-code`) might be more efficient — it runs Claude Code as a library with direct API calls, avoiding subprocess overhead. Worth investigating for Milestone 4.
