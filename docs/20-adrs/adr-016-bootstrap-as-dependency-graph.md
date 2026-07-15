# ADR-016: Bootstrap as a Dependency Graph

- Status: proposed
- Date: 2026-07-15
- Deciders: Linuxify core team
- Context: Alpha-test feedback revealed that the current numbered-stage bootstrap (stages 0-8) creates a coupling between stage numbers and repair logic. `repair` had to know that "stage 6 needs stages 0-5" to avoid suggesting `init --from-stage 6` prematurely. This is fragile.
- Decision: **Proposed** (not yet implemented) — refactor bootstrap from a numbered list of stages into a dependency graph where each stage declares its prerequisites. The bootstrap engine topologically sorts the graph and runs stages in dependency order. `linuxify init` becomes "run all stages whose prerequisites are met but haven't completed yet."
- Consequences:
  - **Positive**: Adding a new stage no longer requires choosing a number. Reordering stages is a graph edit, not a renumber. Repair logic doesn't need to know stage numbers — it just says "run incomplete stages."
  - **Negative**: More complex to implement and debug. The marker files (`stage-N.done`) would need to become `stage-<name>.done`. The doctor check's "Next: stage 0 (preflight)" message becomes "Next: preflight."
- Alternatives Considered:
  - Keep numbered stages but add a `depends_on` field to each stage. Hybrid approach — less migration pain but keeps the coupling.
  - Keep the current design. Works, but every new stage requires manual renumbering and repair-logic updates.

## Context

The current bootstrap subsystem (`src/bootstrap/`) uses a numbered stage model:

```
Stage 0: preflight
Stage 1: host deps
Stage 2: rootfs download
Stage 3: first-boot apt
Stage 4: runtimes
Stage 5: home setup
Stage 6: PATH wiring
Stage 7: verify
Stage 8: tips
```

Each stage writes a `stage-N.done` marker file. `linuxify init` runs stages in
order, skipping those with `.done` markers. `linuxify init --from-stage N`
resumes from stage N.

### The Problem

The numbered model creates coupling:

1. **Repair logic must know stage numbers.** The `path.linuxify_bin` doctor
   check originally suggested `linuxify init --from-stage 6` — but that only
   works if stages 0-5 are done AND state.json exists. The repair engine had
   to learn this dependency manually.

2. **Adding a stage requires renumbering.** If we want to insert a new stage
   between "host deps" (1) and "rootfs" (2), everything downstream shifts.

3. **Stage numbers leak into user messages.** "Next: stage 0 (preflight)" is
   less clear than "Next: preflight." Users shouldn't need to know stage
   numbers.

4. **Parallel stages are impossible.** Stages 3 (first-boot apt) and 4
   (runtimes) both run inside proot and could partially overlap, but the
   numbered model forces strict serialization.

## Decision (Proposed)

Refactor bootstrap into a **dependency graph**:

```yaml
# src/bootstrap/graph.ts (proposed)
stages:
  - id: preflight
    depends_on: []
  - id: host-deps
    depends_on: [preflight]
  - id: rootfs
    depends_on: [host-deps]
  - id: first-boot
    depends_on: [rootfs]
  - id: runtimes
    depends_on: [first-boot]
  - id: home-setup
    depends_on: [first-boot]  # doesn't need runtimes
  - id: path-wiring
    depends_on: [home-setup]
  - id: verify
    depends_on: [runtimes, path-wiring]  # needs both
  - id: tips
    depends_on: [verify]
```

The bootstrap engine:
1. Topologically sorts the graph.
2. Runs stages in order, skipping those with `stage-<id>.done` markers.
3. If a stage fails, downstream stages are skipped (their dependencies
   aren't met).
4. `linuxify init` = "run all stages whose dependencies are met and that
   haven't completed yet." No `--from-stage` needed.

Marker files change from `stage-0.done` to `stage-preflight.done`. The
doctor check message changes from "Next: stage 0 (preflight)" to
"Next: preflight."

### Migration

1. Add a `stageAliases` map: `0 → 'preflight'`, `1 → 'host-deps'`, etc.
2. On `linuxify init`, if old `stage-N.done` markers exist, rename them to
   `stage-<name>.done`.
3. After one release, drop the alias map.

## Consequences

### Positive

- **Adding stages is trivial.** Add a node to the graph with `depends_on`.
  No renumbering.
- **Repair logic is simpler.** "Run incomplete stages" — no stage-number
  knowledge needed.
- **User messages are clearer.** "Next: preflight" instead of "Next: stage 0
  (preflight)."
- **Parallel stages possible.** Stages with no dependency on each other can
  run concurrently (future optimization).
- **Conditional stages possible.** A stage can declare `condition: () =>
  config.bootstrap.distro === 'ubuntu'` and be skipped for other distros.

### Negative

- **Migration cost.** Existing marker files need renaming. State.json's
  `bootstrap_progress.completed_stages` changes from `[0,1,2,...]` to
  `['preflight','host-deps',...]`.
- **More complex to debug.** A graph is harder to introspect than a list.
  Need a `linuxify bootstrap graph` command to visualize dependencies.
- **Topological sort adds code.** Small, but nonzero.

## Alternatives Considered

### A. Keep numbered stages, add `depends_on`

Each stage gets a `depends_on: number[]` field. Hybrid approach.

- **Pro**: Minimal migration — marker files stay the same.
- **Con**: Still coupled to numbers. Adding a stage still requires choosing
  a number. The "Next: stage 0 (preflight)" message still has the number.

### B. Keep the current design

The current numbered model works. The alpha-test bugs were fixed by making
repair logic dependency-aware (priority ordering in the repair engine).

- **Pro**: Zero migration cost.
- **Con**: The coupling remains. Every new stage requires manual renumbering
  and repair-logic updates. The stage numbers will keep leaking into user
  messages.

## Recommendation

Defer to v0.2.0. The current fix (dependency-aware repair engine) addresses
the immediate alpha-test bugs. The graph refactor is a cleanliness improvement
that doesn't block v0.1.0. Revisit after 5+ device tests confirm the current
model is stable.
