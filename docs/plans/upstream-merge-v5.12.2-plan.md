# Upstream Merge Plan — v5.12.1 → v5.12.2

**Date prepared:** 2026-06-24
**Local branch:** `my-custom-branch` (at 5.12.1, HEAD `0542e23e`)
**Target:** `upstream/main` `fe0ec8b5` (v5.12.2)
**Merge base:** `f9c31b44` (v5.12.1 tip — clean linear catch-up)
**Scope:** 7 non-merge commits

---

## 1. Verdict: routine merge — 1 conflict + one auto-merge to verify

`git merge-tree` predicts **1 conflict** (CLAUDE.md, keep ours). The one thing that needs eyes this release: **upstream's chat fix (#276) edited `ChatSendCoordinator.ts`, a fork Tier-3 thunk-carrier** — it auto-merges (different region), but the `getChatService` thunk survival must be verified post-merge (§2).

| File | Resolution |
|------|-----------|
| `CLAUDE.md` | **keep ours** (`--ours`) |

`connectorContent.ts` fast-forwards to upstream's regen. `package.json` auto-merges (whitespace-only reformat + version — see §2).

---

## 2. Divergence-file survival check

| File | Tier | Upstream touched? | Outcome |
|------|------|-------------------|---------|
| `src/ui/chat/services/ChatSendCoordinator.ts` | 3 | **YES (#276)** | **Auto-merges** — upstream's idle-watchdog/spinner fix is in a different region than the fork's 3 `getChatService` thunk sites. **⚠️ MUST verify thunk count stays 3 post-merge.** |
| `src/database/schema/SchemaMigrator.ts` | 2 | No | Auto-merges; stays `CURRENT_SCHEMA_VERSION=21` |
| `src/database/storage/JSONLWriter.ts` | 2 | No | Auto-merges |
| `eslint.config.mjs` | 2 | No | Auto-merges; JSONLWriter exemption intact. `google-gemini-cli/**` Node-exemption (upstream-shared, not a fork divergence) stays valid — agy swap byte-preserves the provider id/path. |
| `src/settings/SettingsView.ts` | 3 | No | Auto-merges; `availableUpdateVersion` guard intact |
| `src/ui/chat/ChatView.ts` | 3 | No | Auto-merges; thunk intact |
| `ChatSessionCoordinator.ts`, `ChatSubagentIntegration.ts` | 3 | No | Auto-merge |
| `tests/unit/SchemaMigrator.test.ts` | 3 | No | Auto-merges |
| `package.json` | infra | Whitespace (spaces→tabs) + version | Auto-merges. **Dependency set verified IDENTICAL** to fork — no new/removed packages. `deploy` script (postbuild.ps1) is upstream's own, preserved. |

### SchemaMigrator: no renumber
Upstream still v13; fork at 21. **#274 notes-index does NOT add a persisted migration** — its `notes`/`note_properties` tables are `CREATE TABLE IF NOT EXISTS` in an in-memory sql.js instance (commit explicitly: "No schema migration / `CURRENT_SCHEMA_VERSION` bump"). **No action.**

### No new dependencies
Verified the full package key set is identical fork↔upstream. notes-index reuses the existing bundled WASM SQLite (`@dao-xyz/sqlite3-vec`) — no new package, no mobile-compat vector, no bundle bloat.

---

## 3. What's in v5.12.2 (feature/fix substance)

**Chat reliability — idle watchdog + stuck-spinner clear (#276, `415def5b`)** — touches `ChatSendCoordinator.ts` (fork thunk-carrier, §2)
- Bounds the CLI runner with an idle watchdog and clears the chat spinner when a turn gets stuck. Reliability fix; positive for the fork's chat usage.

**notes-index — SQL query engine over notes + frontmatter (#274, `e1353efc`)**
- New SearchManager `queryNotes` tool: SQL over a `notes` + `note_properties` index built in-memory at startup (`NotesIndexBuilder`/`NotesIndexService`, upsert/prune/debounce). No persisted schema, no new dep. Wired via `ServiceDefinitions`/`ServiceRegistrar`. New capability; low risk (in-memory, idempotent DDL).

**Antigravity (agy) replaces deprecated Gemini CLI runtime (#278, `56c05b09`)**
- Swaps the deprecated `gemini` CLI runtime for Google **Antigravity (agy)** *within the existing `google-gemini-cli` provider* — provider id byte-preserved (eslint exemption stays valid). UI relabel "Gemini CLI" → "Antigravity CLI". **Behavior change: agy is TEXT-COMPLETION-ONLY** — no tool/function calling, no streaming (added to `TEXT_ONLY_PROVIDERS`).
- **User impact: minimal** — this vault has `google-gemini-cli` present but **disabled + unauthenticated**. Not in active use.

**Fixes + catalog**
- `#275` taskmanager: drain all pages for workspace/board snapshots (pagination completeness).
- `#273` fix single-wikilink corruption in `setProperty`/array CLI coercion — in the ToolCliNormalizer area the fork's CLAUDE.md pins (no fork code divergence); continues the #200/#201 wikilink-safety lineage. Welcome fix.
- `#177` OpenRouter: add `gpt-5.4-image-2` image model.

---

## 4. Execution steps

```powershell
git checkout -- src/utils/connectorContent.ts   # if timestamp-only churn present
git merge upstream/main --no-edit

# Resolve the single conflict
git checkout --ours CLAUDE.md
git add CLAUDE.md
git commit --no-edit

# ⚠️ VERIFY the thunk survived the ChatSendCoordinator auto-merge:
#   grep -c "getChatService" src/ui/chat/services/ChatSendCoordinator.ts   → expect 3
# SchemaMigrator: NO ACTION (verify stays 21)

npm install        # version-field lockfile sync only
npm run build      # lint + tsc + esbuild + connector regen

git checkout -- src/utils/connectorContent.ts   # if regen is timestamp-only
git add package-lock.json
git commit -m "chore: reconcile package-lock version field post v5.12.2 merge build"

git diff upstream/main HEAD --name-only   # expect fork set only
```

### Post-merge verification checklist
- [ ] `CLAUDE.md` resolved ours; no other conflicts
- [ ] **`ChatSendCoordinator.ts` `getChatService` count = 3** (thunk survived #276 auto-merge)
- [ ] `getChatService` thunk in `ChatView.ts` (×3) + `availableUpdateVersion` guard (×8) + JSONLWriter exemption intact
- [ ] `SchemaMigrator.ts` = 21; `SchemaMigrator.test.ts` 8/8 green
- [ ] `npm run build` fully green (esp. tsc — ChatSendCoordinator is a merge point)
- [ ] Divergence surface = expected fork set only

### npm audit note
Standing rule: no `npm audit fix --force`. esbuild HIGH advisory (GHSA-gv7w-rqvm-qjhr) still carried — build-time devDep, not shipped, upstream pins same version.

---

## 5. Risk callouts (post-deploy smoke)

| Risk | Level | Check |
|------|-------|-------|
| **ChatSendCoordinator thunk auto-merge** | **MEDIUM-watch** | Verify count=3 + `tsc` clean (§4). After deploy: send a chat message, confirm streaming works and the spinner clears (the #276 fix area + the fork's thunk both live here now). |
| **Data-folder reset** | **LOW** | No storage-coordinator touches. Verify `storage.rootPath = "00-System/Nexus"` + `migration.state = verified`. |
| **DB migration on launch** | **NONE** | SchemaMigrator unchanged; notes-index is in-memory. |
| **agy/Gemini CLI text-only** | **LOW** | Provider disabled+unauth in this vault. No action unless you enable it (and note: no tool-calling/streaming via agy). |
| **MCP connection** | LOW | Quick stdio smoke; `queryNotes` is additive. |

---

## 6. Post-merge housekeeping
- Update `docs/fork_divergence.md` audit header → v5.12.2. Note `ChatSendCoordinator.ts` is now a confirmed upstream-touch point (like `ChatView.ts`) — both thunk-carriers are live-overlap files; consider proposing the `getChatService` thunk upstream to retire the divergence before a real conflict lands.
- Update CLAUDE.md version marker 5.12.1 → 5.12.2.
- Write `project_v5_12_2_merge` memory + MEMORY.md index line.
- Deploy `npm run deploy`, then §5 smoke — emphasis on a quick chat round-trip this release.
