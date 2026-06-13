# Upstream Merge Plan — v5.11.2 → v5.12.0

**Date prepared:** 2026-06-13
**Local branch:** `my-custom-branch` (at 5.11.2, HEAD `a90cabd6`)
**Target:** `upstream/main` `949dc233` (v5.12.0)
**Merge base:** `abf26e03` (v5.11.2 tip — clean linear catch-up)
**Scope:** 5 non-merge commits

---

## 1. Verdict: cleanest merge in the series — 1 conflict

`git merge-tree` predicts **exactly 1 conflict**:

| File | Resolution |
|------|-----------|
| `CLAUDE.md` | **keep ours** (`--ours`) |

That's it. `connectorContent.ts` is **no longer a conflict** — last merge converged it to upstream, so it now fast-forwards to upstream's regenerated version cleanly (rebuild will reproduce it). **Every Tier 2/3 divergence is untouched by upstream this release** (verified file-by-file in §2) → all auto-merge.

---

## 2. Divergence-file survival check (all PASS — none touched upstream)

| File | Tier | Upstream touched? | Outcome |
|------|------|-------------------|---------|
| `src/database/schema/SchemaMigrator.ts` | 2 | No | Auto-merges; stays `CURRENT_SCHEMA_VERSION=21` |
| `src/database/storage/JSONLWriter.ts` | 2 | No | Auto-merges |
| `eslint.config.mjs` | 2 | No | Auto-merges; JSONLWriter exemption intact (only remaining eslint divergence post-v5.11.2) |
| `src/settings/SettingsView.ts` | 3 | No | Auto-merges; `availableUpdateVersion` guard intact |
| `src/ui/chat/ChatView.ts` | 3 | No | Auto-merges; `getChatService` thunk intact |
| `src/ui/chat/services/Chat{Send,Session}Coordinator.ts`, `ChatSubagentIntegration.ts` | 3 | No | Auto-merge |
| `tests/unit/SchemaMigrator.test.ts` | 3 | No | Auto-merges |
| `connector.ts` | — | No | Unchanged (connectorContent regen driven by bundled source changes, not connector.ts itself) |
| `package.json` | infra | **No dep changes** (version bump only) | Fast-forwards clean |

### SchemaMigrator: no renumber
Upstream still at v13; fork at 21. **The embeddings feature (#265) adds NO SQLite migration** — its learned adapter persists to a JSON file, not the DB. **No action.** Gap unchanged.

### No new npm dependencies
The "dreaming embeddings" feature reuses the existing (CDN-loaded) MiniLM encoder infra — **zero package.json changes**. No new mobile-crash vectors, no lockfile churn beyond formatting.

---

## 3. What's in v5.12.0 (feature substance)

**⭐ Self-improving local retrieval adapter — "dreaming embeddings" (#265, `7ab3c493`)** — the headline
- A query-side **low-rank adapter over the frozen MiniLM encoder**, learned from implicit search→use feedback by an idle-time "dream" consolidation loop.
- **Ships as IDENTITY (zero behavior change)** until a tuning measurably beats the incumbent on held-out data — so first-launch and steady-state behavior are unchanged unless/until it earns a promotion.
- 8 new files under `src/services/embeddings/adapter/` (Trainer, Evaluator, Store, DreamConsolidationService, EmbeddingAdapter, RetrievalFeedbackMiner/Sources, factory) + edits to `EmbeddingManager`/`EmbeddingService`/`NoteEmbeddingService`/`ToolCallTraceService`/`MemoryTypes`. ~2,400 LoC incl. 11 new test suites.
- **Production wiring:** startup load, scheduled cycle, manual command, **kill-switch**. Anti-reward-hacking guards (skip-above, drop self-confirming hits, coverage-floor promotion gate).
- **Persistence (data-folder relevant):** writes to `<vault-root>/data/embeddings/adapter.json` via `resolveVaultRoot` — for this fork that resolves to **`00-System/Nexus/Data/embeddings/adapter.json`**, synced via vault sync so a desktop-trained model reaches other devices. `load()` returns **identity when the file is absent/unreadable** → no first-launch dependency.
- Fork impact: **none structural** — fork has no divergence in `src/services/embeddings/`; all auto-merges. New folder `embeddings/` appears under the data folder (benign).

**toolManager batch-read nudge (#266, `a277b9d8`)**
- 6-line change to `src/agents/toolManager/tools/useTools.ts` — nudges the agent to batch known multi-file reads into one `useTools` call. Prompt/description only. Fork has CLI-first ToolManager but **no divergence in useTools.ts** → auto-merges.

**Task-board cold-start fix + delete icon (#267, `340ad662`)**
- `src/ui/tasks/` (TaskBoardView + 3 services) + styles.css. Adds a delete-task icon and **fixes the empty-board-on-cold-start** symptom. Relevant: this is in the neighborhood of the long-standing "Task Board: No JSONL→SQLite sync" known-issue in CLAUDE.md — a welcome reliability fix. No fork divergence in `src/ui/tasks/` → auto-merges.

**Housekeeping:** `267f7711` version bump; `949dc233` upstream's own project-memory doc.

---

## 4. Execution steps

> Working tree carries the usual untracked fork-local docs (`docs/plans/chat-db-load-slow-*`, `docs/review/*`, and the prior merge plans) — leave them. If `connectorContent.ts` shows a timestamp-only `M` from the last deploy build, discard it first (`git checkout -- src/utils/connectorContent.ts`).

```powershell
# 1. Fetch (done) + merge
git fetch upstream
git merge upstream/main --no-edit

# 2. Resolve the single expected conflict
git checkout --ours CLAUDE.md
git add CLAUDE.md

# 3. Complete the merge
git commit --no-edit

# 4. SchemaMigrator: NO ACTION (verify stays 21)

# 5. Build (reruns connector regen from merged source)
npm install        # reconcile package-lock formatting if needed
npm run build      # lint + tsc + esbuild + connector regen

# 6. Commit regen if connectorContent changed beyond timestamp
#    (expected: regen matches upstream's committed version — only timestamp differs;
#     if so, discard. Commit package-lock if reconciled.)
git add src/utils/connectorContent.ts package-lock.json
git commit -m "chore: regen connectorContent.ts + reconcile package-lock post v5.12.0 merge build"

# 7. Verify divergence surface
git diff upstream/main HEAD --name-only
```

### Post-merge verification checklist
- [ ] `CLAUDE.md` resolved ours; no other conflicts
- [ ] `SchemaMigrator.ts` = 21; `SchemaMigrator.test.ts` 8/8 green
- [ ] `getChatService` thunk (×3) + `availableUpdateVersion` guard (×8) + JSONLWriter exemption intact
- [ ] `npm run build` fully green (lint, tsc, esbuild, connector regen)
- [ ] Divergence surface = expected fork set only (no new unexpected files)

### npm audit note
Standing rule: do **not** `npm audit fix --force`. No dep changes this release → expect 0 vulns unchanged.

---

## 5. Risk callouts (post-deploy smoke)

| Risk | Level | Check |
|------|-------|-------|
| **Data-folder reset** | **LOW** | No `PluginScopedStorageCoordinator` / storage-coordinator touches. Still verify `storage.rootPath = "00-System/Nexus"` + `migration.state = verified` post-deploy per [[project_nexus_data_folder]]. |
| **DB migration on launch** | **NONE** | SchemaMigrator unchanged. |
| **Dreaming embeddings runtime** | **LOW** | Ships identity by default; learns only on idle-time cycles and only promotes if it beats incumbent on held-out data. Has a kill-switch. New `00-System/Nexus/Data/embeddings/adapter.json` appears once a cycle runs (absent = identity). Optional smoke: confirm search still returns sensible results; no error spam from the scheduled dream cycle. |
| **Task-board cold start** | **LOW (positive)** | #267 should *fix* empty-board-on-cold-start. Smoke: open Task Board on a fresh reload, confirm cards render and the new delete icon works. |
| **MCP connection** | LOW | Quick stdio smoke (useTools nudge is prompt-only). |

---

## 6. Post-merge housekeeping
- Update `docs/fork_divergence.md` audit header → v5.12.0 (note: zero divergence-file touches this release; divergence surface stable).
- Update CLAUDE.md version marker 5.11.2 → 5.12.0 (within keep-ours resolution or follow-up). Consider clearing the stale "Task Board: No JSONL→SQLite sync" known-issue note if #267 resolves the cold-start symptom in practice.
- Write `project_v5_12_0_merge` memory + MEMORY.md index line; note the new `embeddings/adapter.json` data-folder artifact in [[project_nexus_data_folder]].
- Deploy `npm run deploy`, then run the §5 smoke (data-folder check + a quick search/task-board glance).
