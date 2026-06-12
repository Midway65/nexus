# Upstream Merge Plan — v5.11.1 → v5.11.2

**Date prepared:** 2026-06-12
**Local branch:** `my-custom-branch` (at 5.11.1, HEAD `1d3064c2`)
**Target:** `upstream/main` `abf26e03` (v5.11.2)
**Merge base:** `3f0b7a7c` (v5.11.1 tip — clean linear catch-up)
**Scope:** 13 non-merge commits

---

## 1. Verdict: routine merge + one divergence to RETIRE

`git merge-tree` predicts **only 2 conflicts** — the usual pair:

| File | Resolution |
|------|-----------|
| `CLAUDE.md` | **keep ours** (`--ours`) |
| `src/utils/connectorContent.ts` | **take theirs**, regen via build |

Every fork divergence auto-merges. **The headline of this merge:** upstream independently fixed the exact `version-bump.mjs` lint crash the fork patched last merge (`da5d7072`) — so this merge is a chance to **retire** that fork divergence (§3).

---

## 2. Divergence-file survival check (all PASS)

| File | Tier | Upstream touched? | Outcome |
|------|------|-------------------|---------|
| `src/database/schema/SchemaMigrator.ts` | 2 | No | Auto-merges; stays `CURRENT_SCHEMA_VERSION=21` |
| `src/database/storage/JSONLWriter.ts` | 2 | No | Auto-merges; `readEventsStreaming()` preserved |
| `eslint.config.mjs` | 2 | **Yes** (`c47d00d7` rule-disable for `.js`/`.mjs`) | Auto-merges (different region from fork lines) — **but see §3: retire the `version-bump.mjs` ignore** |
| `src/settings/SettingsView.ts` | 3 | No | Auto-merges; `availableUpdateVersion` guard intact |
| `src/ui/chat/ChatView.ts` | 3 | No | Auto-merges; `getChatService` thunk intact (no voice churn this release) |
| `src/ui/chat/services/Chat{Send,Session}Coordinator.ts`, `ChatSubagentIntegration.ts` | 3 | No | Auto-merge |
| `tests/unit/SchemaMigrator.test.ts` | 3 | No | Auto-merges; v20+v21 assertions intact |
| `package.json` | infra | No dep changes | Fast-forwards clean |

### SchemaMigrator: no renumber
Upstream still at v13; fork at 21. No migration added in v5.11.2. **No action.** Gap unchanged (upstream needs 8 more to catch up).

### `globals` import (upstream eslint change) — verified safe
Upstream's new eslint config does `import globals from "globals"` but does **not** add `globals` to package.json. It resolves transitively via eslint (`globals@14.0.0` confirmed present). Post-merge build will **not** break on this. (Upstream hygiene gap, not the fork's problem.)

---

## 3. ⭐ Retire the `version-bump.mjs` eslint ignore (convergence win)

Last merge the fork added `"version-bump.mjs"` to the global `ignores` block (`da5d7072`) to work around the `obsidianmd/no-plugin-as-component` typed-rule crash. **Upstream `c47d00d7` now fixes the same root cause more correctly** — it turns the obsidianmd typed rules **off** for all `**/*.js` / `**/*.mjs` files (and adds Node globals) so `.mjs` files lint cleanly *without* being skipped. Commit message confirms identical root cause ("version-bump.mjs … first non-ignored .mjs", `getParserServices`).

After the merge auto-combines both edits, the fork's `"version-bump.mjs"` ignore line is **redundant and counterproductive** (it skips a file upstream now wants linted). **Action: delete that line** from `eslint.config.mjs` during this merge.

- Result: `eslint.config.mjs` divergence shrinks back to **just the JSONLWriter exemption** (Tier 2).
- Verify post-removal: `npm run lint` still green (upstream's rule-disable carries `version-bump.mjs`).
- Update `docs/fork_divergence.md` + memory to mark the `da5d7072` divergence **RETIRED**.

---

## 4. What's in v5.11.2 (feature/refactor substance)

**Storage internals — HybridStorageAdapter split (the big one)**
- `#261` Phase 0 characterization tests, `#262` extract `HybridStorageAssembly` factory, `#263` extract `lifecycle/StorageMaintenanceService`. `HybridStorageAdapter.ts` shrinks ~370 lines (462-line delta). **Auto-merges** — fork fully converged this file (no competing change). Path resolution (`PluginScopedStorageCoordinator`) **untouched** → data-folder reset risk LOW. This *is* the adapter behind past `waitForQueryReady` incidents → **runtime smoke is important** (§6).

**Secure key storage (`#254`) — opt-in, default OFF**
- New `SecretStore` / `SettingsSecrets`: API keys can move from synced `data.json` to Obsidian's device-local OS-encrypted `app.secretStorage` (Obsidian 1.11.4+), via a new Providers-tab toggle. **No automatic migration** — keys stay in `data.json` until the user enables it. In-memory settings shape unchanged. Low upgrade risk; relevant to the fork's data.json recovery procedures (keys would no longer live there *if* the toggle is later enabled).

**LLM adapter refactors**
- `#253` deduplicate LLM adapters + characterization tests; `#257` route Perplexity + Requesty through shared helpers. Internal; auto-merge.

**Fixes**
- `#264` session `startTime` updates + `updateMessage` conversation scoping.
- `c91631c0` taskManager: clear stale `completedAt` on non-done tasks.
- `c47d00d7` correct Requesty Gemini 3.5 Flash slug (`vertex/gemini-3.5-flash`, not `google/...`) + smoke harness extension + the `.mjs` lint fix (§3).

**Housekeeping**
- `780905f0` CI: `action-gh-release` → v3 (Node 24). `57e16f9f` changelog 5.11.0–5.11.2 + secure-key-storage docs. `abf26e03` nexus-release skill: add `versions.json` to bump list + macOS size-check fix.

---

## 5. Execution steps

> Working tree currently has 4 untracked fork-local docs (`docs/plans/chat-db-load-slow-*`, `docs/review/*`) — leave them; they don't interfere. Confirm `git status` is otherwise clean before merging.

```powershell
# 1. Fetch (done) + merge
git fetch upstream
git merge upstream/main --no-edit

# 2. Resolve the 2 expected conflicts
git checkout --ours   CLAUDE.md
git checkout --theirs src/utils/connectorContent.ts
git add CLAUDE.md src/utils/connectorContent.ts

# 3. Complete the merge
git commit --no-edit

# 4. RETIRE the version-bump.mjs ignore (§3) — edit eslint.config.mjs,
#    delete the "version-bump.mjs" line + its 4-line comment, then:
#    git add eslint.config.mjs && git commit -m "build(eslint): retire version-bump.mjs ignore — upstream c47d00d7 supersedes"

# 5. SchemaMigrator: NO ACTION (verify stays 21)

# 6. Build (reruns connector regen)
npm install        # reconcile package-lock if upstream touched it
npm run build      # lint (now incl. .mjs) + tsc + esbuild + connector regen

# 7. Commit regen
git add src/utils/connectorContent.ts package-lock.json
git commit -m "chore: regen connectorContent.ts + reconcile package-lock post v5.11.2 merge build"

# 8. Verify divergence surface
git diff upstream/main HEAD --name-only
```

### Post-merge verification checklist
- [ ] `version-bump.mjs` ignore removed; `npm run lint` still green (upstream rule-disable covers it)
- [ ] `eslint.config.mjs` retains JSONLWriter exemption + upstream's `.mjs` rule-disable block
- [ ] `getChatService` thunk (3 sites) + `availableUpdateVersion` guard intact
- [ ] `SchemaMigrator.ts` = 21; `SchemaMigrator.test.ts` 8/8 green
- [ ] `npm run build` fully green (tsc, esbuild, connector regen)
- [ ] Divergence surface = expected set, now **minus** any version-bump trace in eslint

### npm audit note
Standing rule: do **not** `npm audit fix --force`. v5.11.1 lockfile was at 0 vulns; expect unchanged.

---

## 6. Risk callouts (post-deploy smoke)

| Risk | Level | Check |
|------|-------|-------|
| **Data-folder reset** | **LOW** | No `PluginScopedStorageCoordinator` touches. Still verify `storage.rootPath = "00-System/Nexus"` + `migration.state = verified` post-deploy per [[project_nexus_data_folder]]. |
| **DB migration on launch** | **NONE** | SchemaMigrator unchanged. |
| **HybridStorageAdapter split** | **MEDIUM-watch** | Large internal refactor of the adapter behind past `waitForQueryReady` hangs. After deploy: confirm chat/workspace/task data loads, no `waitForQueryReady timed out` in console, no stalled hydration. |
| **Secure key storage** | LOW | Opt-in, default off; keys stay in `data.json`. No action unless you choose to enable the toggle. |
| **MCP connection** | LOW | Quick smoke (stdio path unaffected by these refactors). |

---

## 7. Post-merge housekeeping
- Update `docs/fork_divergence.md` audit header → v5.11.2; mark `version-bump.mjs` ignore **RETIRED**.
- Update CLAUDE.md version marker 5.11.1 → 5.11.2 (within the keep-ours resolution or a follow-up).
- Write `project_v5_11_2_merge` memory + MEMORY.md index line; update `project_v5_11_1_merge` note that the eslint workaround was retired one release later.
- Deploy `npm run deploy`, then run the §6 storage smoke (this release touches the storage adapter more than usual).
