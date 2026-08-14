# Upstream Merge Plan — v5.16.1 → v5.16.4

**Date prepared:** 2026-08-14
**Local branch:** `my-custom-branch` (at 5.16.1, HEAD `91b5b9f5`)
**Target:** `upstream/main` `aafcfcce` (v5.16.4 + post-tag commits)
**Merge base:** `0da22573` (v5.16.1 tip)
**Scope:** 57 non-merge commits (spans v5.16.2, v5.16.3, v5.16.4, plus post-tag work)

---

## 1. Verdict: the most significant merge in this fork's history

Two firsts land together:
1. **⭐ The SchemaMigrator renumber finally triggers.** Upstream shipped their first new migration since the fork diverged (**v14**). The fork's documented renumber convention must now be executed for the first time — `CURRENT_SCHEMA_VERSION` 21 → **22**.
2. **⭐ A new runtime dependency (`defuddle`)** — the first in many releases.

`git merge-tree` predicts **4 conflicts**:

| File | Resolution |
|------|-----------|
| `CLAUDE.md` | **keep ours** — but see §5, upstream restructured theirs heavily |
| `package-lock.json` | **take theirs**, then `npm install` regenerates (new `defuddle` dep) |
| `src/database/schema/SchemaMigrator.ts` | **MANUAL** — renumber upstream v14 → fork v22 (§2) |
| `tests/unit/SchemaMigrator.test.ts` | **MANUAL** — update assertions to 22 + add v22 coverage (§2) |

---

## 2. ⭐ THE RENUMBER (the heart of this merge)

### Current state
- **Upstream:** `CURRENT_SCHEMA_VERSION = 14`. Their migrations run 3→14; the new one is **v14 — "Add notes + note_properties tables (notes query index) to the owned schema"** (`75ceaa7d`).
- **Fork:** `CURRENT_SCHEMA_VERSION = 21`. Fork-original migrations at **17, 18, 19**; upstream renumbers at **20** (`[upstream v12]` shard_cursors) and **21** (`[upstream v13]` skills).

### The fork's own documented rule (SchemaMigrator.ts, "FORK MIGRATION NUMBERING CONVENTION")
> *RULE: When merging an upstream migration numbered N where N ≤ 19, renumber it to the next available version above the current MAX (i.e. 20, 21, 22 ...). Once upstream's version counter exceeds the fork's MAX, merge their migrations as-is.*
>
> *This ensures the migrator (which skips anything ≤ MAX(schema_version) in the DB) actually runs the upstream schema change on existing installs.*

Upstream's new migration is **v14 ≤ 19** → **renumber to 22**.

### Required edit
Append after the fork's v21 block, preserving upstream's SQL **verbatim**:

```ts
  {
    version: 22,  // renumbered from upstream v14
    description: '[upstream v14] Add notes + note_properties tables (notes query index) to the owned schema',
    sql: [ /* upstream's v14 SQL unchanged: CREATE TABLE notes, 2 indexes,
              CREATE TABLE note_properties, 3 indexes — all IF NOT EXISTS */ ]
  },
```
Then set `CURRENT_SCHEMA_VERSION = 22` and update the convention comment's example if it still cites 21.

### Why this matters (do not skip)
Without the renumber, the fork's DB is already at 21, so the migrator would **skip upstream's v14 entirely** — the `notes` / `note_properties` tables would never be created by the schema on this install. Upstream's commit explains the exact failure this prevents: after "Nexus: Rebuild cache", `NotesIndexBuilder` keeps writing to tables the rebuild dropped → `SQLite3Error: no such table: notes` on every note create/edit/rename/delete for the rest of the session.

**Safety:** upstream's v14 DDL is additive and fully `IF NOT EXISTS`. On this vault the two tables already exist at runtime (created by `NotesIndexService.ensureSchema()` since v5.12.2), so applying it as v22 is effectively a **no-op that formalizes ownership** — no data change, no rebuild.

### Test file (`tests/unit/SchemaMigrator.test.ts`)
Fork tests assert version numbers explicitly. Update:
- `expect(CURRENT_SCHEMA_VERSION).toBe(21)` → **22**
- The "runs v20 + v21 when starting at v19" test: `toVersion` 21 → 22, applied-set `[20, 21]` → `[20, 21, 22]` (rename the test accordingly)
- The "no-op when already current" test: the `MAX(version)` fixture rows `[[21]]` → `[[22]]`, and both `fromVersion`/`toVersion` 21 → 22
- **Add** a v22 describe block mirroring the v20/v21 pattern: v22 exists, description mentions notes/note_properties, DDL is additive-only (`IF NOT EXISTS`, no DROP/RENAME)

---

## 3. Other divergence files

| File | Tier | Upstream touched? | Outcome |
|------|------|-------------------|---------|
| `eslint.config.mjs` | 2 | **YES (3 commits)** | **Auto-merges** — verify JSONLWriter exemption survives + `eslint .` still green (new arch/mobile checkers land this release). |
| `.gitignore` | infra | YES (1) | Auto-merges (Python bytecode ignore) |
| `JSONLWriter.ts` | 2 | No | Descriptions + `readEventsStreaming` intact |
| `SettingsView.ts` | 3 | No | `availableUpdateVersion` guard intact |
| `ChatView.ts` | 3 | **No** | Thunk untouched this release (breather after 4 straight) |
| `ChatSendCoordinator.ts` / `ChatSessionCoordinator.ts` / `ChatSubagentIntegration.ts` | 3 | No | Auto-merge |
| `connector.ts` | — | No | Unchanged |

### TypeScript stays `^6.0.3` — no toolchain gate this time.

### ⚠️ New runtime dependency: `defuddle@0.19.2`
Added for #338 (web capture extraction, replacing the Web Viewer save command). **Mobile-safe as shipped** — imported lazily via dynamic `import('defuddle')` inside `WebContentExtractor.ts`, never top-level, so it satisfies the project's own mobile rule. `npm install` is required before building.

---

## 4. What's in v5.16.4 (57 commits — the substance)

**Bases support (#330, phases 1–4)** — the flagship feature
- Read/write/update/list `.base` files; **execute a base and return the rows a user would see**; detach the notes index at unload so a reloaded plugin stops writing. New BasesManager surface.

**Notes-index correctness (the reason for the migration)**
- `75ceaa7d` promotes `notes`/`note_properties` into the owned schema (→ fork v22); `76c2d1cb` fails the schema check when a table lives outside `SCHEMA_SQL`.

**Startup hydration fix — directly relevant to this vault's history**
- `7a5428c0` fixes a real bug: a rebuild that reported progress then finished could leave the hydration phase at `running` (not query-ready) **forever**, so every `waitForQueryReady()` caller (notes index, task board, workspaces, agent init) burned its full idle timeout and resolved false. Applies to the *background* rebuild too, not just blocking. Plus `718a0694` opens the gate on fresh vaults. **This is the same symptom family this vault hit historically → net-positive.**

**Reliability / correctness fixes**
- `#333` a mutation must not silently fall back to a store nothing reads; `#339` + follow-up: release the IPC socket at unload so a reload can't orphan its successor (socket ownership no longer relies on inode identity alone); `#336` surface provider error frames instead of ending the stream silently (+ per-provider wiring for openai/github-copilot/groq/mistral); `#316` a note that moved mid-flight is a skip, not an error; `#308` load-state returning stale tags; `#307` merge task metadata updates.
- `aafef03d` takes **pdf-lib off the mobile startup path** + defines every CSS spacing token.

**Search ranking improvements (#312–#315)** — rank real content matches above filename-only fuzzy hits; rank a note *named* for the query above one that merely mentions it; match kebab-cased filenames against spaced queries; tests now fail the way the vault does.

**Workspace resolution (#318, #321)** — accept a workspace by name off the live list; align resolvers and report ambiguous names usefully.

**CLI (#310, #324, #325)** — fix `nexus use` argv parsing; multiline content everywhere (generic transports + verbatim values channel); stop claiming the CLI is on PATH without asking the shell.

**Models** — Gemini 3.7 Flash (Google + OpenRouter) `abe8fdf7`; DeepSeek V4 Pro 0813 (OpenRouter) `340b756a`. Additive.

**Web capture (#338)** — extract with **Defuddle** instead of the Web Viewer save command (the new dep).

**Build/CI** — gate every build on mobile import reachability (#221); package the in-app verification loop + PR-time CI (#331).

**Docs restructure (#335)** — see §5.

---

## 5. CLAUDE.md: upstream stripped theirs (decision point)

Upstream reduced `CLAUDE.md` from ~3800 words to ~560, moving procedural knowledge into `.claude/skills/` + `.skills/` (nexus-agents, nexus-llm-adapters, nexus-mobile-compat, nexus-storage, nexus-testing, etc.).

**Recommendation: still `--ours`** for this merge — the fork's CLAUDE.md carries fork-specific context (divergence pointers, vault specifics) that upstream's strip would discard, and changing that is out of scope for a version merge. The new `.claude/skills/` and `.skills/` directories arrive as **new files** regardless (no conflict), so you gain the skills either way.

**Follow-up worth considering later** (not this merge): adopt upstream's slimmer CLAUDE.md and relocate the fork's procedural content into a fork-owned skill, which would shrink a permanent Tier-1 divergence.

---

## 6. Execution steps

```powershell
git checkout -- src/utils/connectorContent.ts   # if timestamp-only churn present
git merge upstream/main --no-edit

# 1. Routine conflicts
git checkout --ours   CLAUDE.md
git checkout --theirs package-lock.json
git add CLAUDE.md package-lock.json

# 2. ⭐ MANUAL: SchemaMigrator.ts — resolve to fork's superset, then append upstream v14 as v22
#    - keep fork migrations 17,18,19,20,21 + the convention comment
#    - append the v22 block (upstream v14 SQL verbatim, description prefixed '[upstream v14]')
#    - set CURRENT_SCHEMA_VERSION = 22
# 3. ⭐ MANUAL: tests/unit/SchemaMigrator.test.ts — 21→22 assertions + new v22 describe block (§2)
git add src/database/schema/SchemaMigrator.ts tests/unit/SchemaMigrator.test.ts

git commit --no-edit

npm install        # REQUIRED — pulls new defuddle dep + regenerates lockfile
npm run build      # lint (new checkers) + cli-build + tsc + esbuild + connector/cli regen

npx jest tests/unit/SchemaMigrator.test.ts   # must be green with the new v22 expectations

git add package-lock.json src/utils/connectorContent.ts src/utils/cliAssets.ts
git commit -m "chore: regen build artifacts + reconcile package-lock (defuddle) post v5.16.4 merge"

git diff upstream/main HEAD --name-only   # expect fork set only
```

### Post-merge verification checklist
- [ ] `SchemaMigrator.ts`: `CURRENT_SCHEMA_VERSION = 22`; migrations 17–22 present; v22 SQL byte-identical to upstream v14; convention comment updated
- [ ] `SchemaMigrator.test.ts`: all assertions at 22; new v22 block; **suite green** (expect 11–12 tests, up from 8)
- [ ] `eslint.config.mjs` JSONLWriter exemption intact; `eslint .` green (new mobile/arch checkers pass)
- [ ] `getChatService` thunk (×3) + `availableUpdateVersion` guard (×8) intact
- [ ] `npm run build` fully green under TS6 (2 known JSONLWriter warnings OK)
- [ ] `defuddle` installed; build's mobile-import-reachability gate (#221) passes
- [ ] Divergence surface = expected fork set only

### npm audit
Standing rule: no `npm audit fix`. Re-check the set after `defuddle` lands but do not apply.

---

## 7. Risk callouts (post-deploy smoke — highest-attention merge in a while)

| Risk | Level | Check |
|------|-------|-------|
| **Schema migration v22 runs on first launch** | **MEDIUM-watch (the headline)** | First real migration this fork has run in a long time. DDL is additive + `IF NOT EXISTS`, and the tables already exist → expect a silent no-op. **After deploy: confirm no `SQLite3Error` in console, and that chat/workspaces/tasks all load.** |
| **Startup hydration change** | **LOW-positive** | Fixes the `waitForQueryReady` timeout family this vault has hit. Confirm no stalled hydration / no 60s timeouts on first launch. |
| **Data-folder reset** | **LOW** | `PluginScopedStorageCoordinator`/`VaultRootResolver` untouched. Verify `rootPath = "00-System/Nexus"` + `migration.state = verified`. |
| **New `defuddle` dep on mobile** | **LOW** | Lazily imported; upstream added a build gate for mobile import reachability. Desktop unaffected. |
| **Notes-index detach at unload (#330 p4)** | **LOW-positive** | Prevents a reloaded plugin from writing to a dropped table. |
| **MCP connection** | LOW | Quick stdio smoke. |

---

## 8. Post-merge housekeeping
- Update `docs/fork_divergence.md`: audit header → v5.16.4 **and update the SchemaMigrator Tier-2 entry** — fork now at v22, upstream at v14, convergence gap narrowed to 8 (upstream needs 8 more to catch up).
- Update `project_convergence_plan` memory: Phase 3 (SchemaMigrator) has now had its **first renumber executed** — the convention works as designed; record the precedent.
- Write `project_v5_16_4_merge` memory + MEMORY.md index line; note the v22 renumber prominently as the reference example for future merges.
- Consider (separately) the CLAUDE.md slimming follow-up from §5.
- Deploy `npm run deploy`, then §7 smoke — **emphasis on first-launch migration + data loading**.
