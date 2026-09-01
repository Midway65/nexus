# Upstream Merge Plan — v5.16.4 → v5.18.2

**Date prepared:** 2026-09-01
**Local branch:** `my-custom-branch` (at 5.16.4, HEAD `d77b28c4`)
**Target:** `upstream/main` `92b4447a` (v5.18.2)
**Merge base:** `aafcfcce` (v5.16.4 post-tag tip — the fork is 0 behind on that base)
**Scope:** 49 non-merge commits (spans v5.17.0, v5.17.1, v5.17.2, v5.18.0, v5.18.1, v5.18.2)

---

## 1. Verdict: the merge that shrinks the fork

Two structural events, in opposite directions:

1. **⭐ A Tier-3 divergence retires itself.** Upstream's `d3e473ba` (#358) independently
   reimplements the fork's `getChatService` thunk — same root cause, same fix, **stricter**. Four
   fork files conflict and the resolution for all four is **take theirs**. The fork's code
   divergence surface drops from 13 files to 9.
2. **⭐ The second schema renumber — two migrations this time.** Upstream shipped **v15** and
   **v16**. Both are ≤ 19, so both renumber: **23 and 24**, `CURRENT_SCHEMA_VERSION = 24`.

`git merge-tree` predicts **7 conflicts**:

| File | Hunks | Resolution |
|------|-------|-----------|
| `package-lock.json` | — | **take theirs**, then `npm install` regenerates |
| `src/database/schema/SchemaMigrator.ts` | 1 | **MANUAL** — renumber upstream v15/v16 → fork 23/24 (§2) |
| `tests/unit/SchemaMigrator.test.ts` | 11 | **MANUAL** — the real work; take theirs as the base, then renumber (§2) |
| `src/ui/chat/ChatView.ts` | 3 | **take theirs** — retires the thunk divergence (§3) |
| `src/ui/chat/services/ChatSendCoordinator.ts` | 3 | **take theirs** |
| `src/ui/chat/services/ChatSessionCoordinator.ts` | 3 | **take theirs** |
| `src/ui/chat/services/ChatSubagentIntegration.ts` | 1 | **take theirs** |

**`CLAUDE.md` does not conflict this time** — upstream has not touched it since the merge base, so
the fork's version carries forward untouched. First clean pass in 10 merges. The §5 follow-up from
the v5.16.4 plan (adopt upstream's slim CLAUDE.md) is still open and still optional.

---

## 2. ⭐ THE RENUMBER (two migrations)

### Current state
- **Upstream:** `CURRENT_SCHEMA_VERSION = 16`, with two new migrations since v14:
  - **v15** — `Add durable tool operation receipts for duplicate suppression` (the #356
    receipts table: `tool_operation_receipts` + 3 indexes, all `IF NOT EXISTS`)
  - **v16** — `Add isArchived column to states table so getStates filters without reading JSONL`
    (issue #219; the column is deliberately **NULLABLE WITH NO DEFAULT** — see the warning below)
- **Fork:** `CURRENT_SCHEMA_VERSION = 22`. Fork-original at 17–19; upstream renumbers at 20
  (`[upstream v12]`), 21 (`[upstream v13]`), 22 (`[upstream v14]`).

### The conflict is exactly the shape the v5.16.4 precedent predicted
The only conflict hunk in `SchemaMigrator.ts` is the `CURRENT_SCHEMA_VERSION` line:

```
<<<<<<< HEAD
export const CURRENT_SCHEMA_VERSION = 22;
=======
export const CURRENT_SCHEMA_VERSION = 16;
>>>>>>> upstream/main
```

Upstream's v15 and v16 blocks **auto-merge to the end of the array, out of order** — verified in the
merge-tree preview, they land after the fork's v22. Renumber them in place; do not reorder the file.

### Required edits
1. Resolve the conflict to **`CURRENT_SCHEMA_VERSION = 24`**.
2. On the auto-merged block currently reading `version: 15`:
   - `version: 23`
   - prefix the description: `'[upstream v15] Add durable tool operation receipts for duplicate suppression'`
   - add a `// renumbered from upstream v15` comment
   - **leave the SQL byte-identical**
3. Same for the `version: 16` block → **24**, `'[upstream v16] Add isArchived column to states table …'`.
   Keep upstream's long explanatory comment above it verbatim — it documents why the column is
   nullable, and that reasoning does not change under renumbering.
4. Update the convention comment's worked example (it currently cites 22).

### ✅ Verified safe: the v16 backfill is **not** version-coupled
Upstream's v16 depends on `StateRepository.backfillDerivedStateMetadata()` running at first init
after the migration. Checked: it is gated on **data**, not on a version number —
`SELECT id, workspaceId, description FROM states WHERE isArchived IS NULL` — and
`HybridStorageAdapter.ts:409` calls it unconditionally during init. Renumbering 16 → 24 cannot
desynchronise it. This was the one thing that could have made this renumber unsafe; it is not.

### ✅ Verified safe: v16's bare `ALTER TABLE` is covered by the migrator's own guard

v16 is the first renumbered migration whose SQL is **not** pure `CREATE … IF NOT EXISTS`:

```sql
ALTER TABLE states ADD COLUMN isArchived INTEGER
CREATE INDEX IF NOT EXISTS idx_states_archived ON states(isArchived)
```

SQLite has no `ADD COLUMN IF NOT EXISTS`, so this statement errors with *duplicate column name* if
the column is already there — and the migrator rethrows on a failed migration
(`SchemaMigrator.ts:736-739`). That would matter, except the fork's migrator already special-cases
exactly this: it regex-matches `ALTER TABLE (\w+) ADD COLUMN (\w+)` and **skips the statement when
`columnExists()` reports the column present** (`SchemaMigrator.ts:716-724`). Verified present in the
merge preview at line 825. So v24 is safe both on this vault (column absent → applied) and on a
fresh install (SCHEMA_SQL created it → skipped).

It also carries a `migrationFn` — executable JS that derives `isArchived`/`description` from cached
`stateJson` rows. The fork's migrator already supports `migrationFn`; it comes across with the
auto-merge and needs no change beyond the version renumber.

### ⚠️ Pre-existing hygiene bug to fix while you are in here
`src/database/schema/schema.ts:514` stamps fresh installs with a **literal**:

```sql
INSERT OR IGNORE INTO schema_version VALUES (14, strftime('%s', 'now') * 1000);
```

The fork is at `CURRENT_SCHEMA_VERSION = 22` but stamps fresh installs at **14** — the v5.16.4
merge renumbered the migration and missed this literal (upstream's own header comment, step 4, says
to bump it). This auto-merges to upstream's `16` and the mismatch simply continues.

**Impact is real but narrow:** existing installs (including this vault) are unaffected — they are
already stamped 22. Only a *fresh* install is wrong, and there it is currently benign: SCHEMA_SQL
creates every table, then the migrator redundantly replays 17–24, and all of those are additive
`IF NOT EXISTS` except migration 18's `DROP TABLE IF EXISTS embedding_metadata` + recreate, which
drops a table that is empty on a fresh install. So: harmless today. It stays harmless only because of two separate safety nets — every
renumbered migration so far is `IF NOT EXISTS`, and the one that is not (v24's `ALTER TABLE`) is
caught by the `columnExists` skip above. Fix the stamp rather than keep relying on both.

**Fix in this merge:** set the literal to **24** and update the `Current Version:` line in the
schema.ts header comment. Add it to the fork's SchemaMigrator convention block as a **STEP 5**, so
the next renumber cannot miss it again. This makes `schema.ts` a new (small) Tier-2 divergence —
register it.

### Test file — the actual labour (11 conflict hunks)
`tests/unit/SchemaMigrator.test.ts` conflicts in 11 places because upstream added coverage for both
new migrations while the fork's numbers moved. **Do not hand-merge hunk by hunk.** Take upstream's
file as the base (`git checkout --theirs`), then apply the renumber to it:

- `expect(CURRENT_SCHEMA_VERSION).toBe(16)` → **24**
- Re-add the fork's v17–v19 fixtures and the v20/v21/v22 describe blocks (recover them from
  `git show HEAD:tests/unit/SchemaMigrator.test.ts`)
- Upstream's v15 describe → **v23**; upstream's v16 describe → **v24**
- "starting at v19" → applied `[20, 21, 22, 23, 24]`, `toVersion` 24
- "starting at v22" (new, mirroring the v5.16.4 pattern) → applied `[23, 24]`, proving both fire on
  this install
- No-op fixture: `MAX(version)` rows `[[22]]` → `[[24]]`
- v24's DDL assertion must allow `ALTER TABLE … ADD COLUMN` — unlike every previous renumbered
  migration, v16 is **not** pure `CREATE … IF NOT EXISTS`. A blanket "additive-only means no ALTER"
  assertion copied from the v22 block will fail here.

Expect roughly **15–17 tests**, up from 11.

---

## 3. ⭐ Retiring the `getChatService` thunk (take theirs, all four files)

Upstream `d3e473ba` — *"fix: resolve chatService lazily so subagents survive a plugin reload"* —
diagnoses precisely what the fork's `d242630d` fixed in June: `ChatUIManager.registerViewEarly`
constructs `ChatView` with a still-null `chatService`, and the constructor copied it **by value**
into three collaborator dependency bags, so the later real assignment never reached them.

**Upstream's version is a strict superset of the fork's:**

| | Fork (`d242630d`) | Upstream (`d3e473ba`) |
|---|---|---|
| Accessor type | `() => ChatService` | `() => ChatService \| null` |
| ChatView sites | `() => this.chatService` | `() => this.chatService ?? null` |
| Null guard | `ChatSubagentIntegration` only | every consumer, incl. `ChatSessionCoordinator`'s `?.hasConfiguredProviders() ?? false` |
| Tests | none | `ChatViewChatServiceWiring.test.ts`, `ChatSubagentIntegration.test.ts` |

Confirmed by diffing `aafcfcce..HEAD`: the fork's changes to these four files are **thunk-only**
(6/6/6/12 lines). There is nothing of the fork's to layer back. `git checkout --theirs` on all
four, and delete the Tier-3 entry from the divergence registry.

This is the outcome the registry has been aiming at since June ("Upstream-eligible — propose
upstream or retire"). It retired without the fork having to propose anything.

---

## 4. Other divergence files

| File | Tier | Upstream touched? | Outcome |
|------|------|-------------------|---------|
| `eslint.config.mjs` | 2 | Yes | **Auto-merges**; JSONLWriter exemption verified present in the merge preview (line ~197) |
| `JSONLWriter.ts` | 2 | Yes | Auto-merges; `readEventsStreaming` intact. Still the Phase-4 retirement candidate. |
| `SettingsView.ts` | 3 | Yes | Auto-merges; `availableUpdateVersion` guard verified — **8 references** in the merge preview |
| `CLAUDE.md` | — | **No** | No conflict; fork version carries forward |
| `.gitignore`, `postbuild.ps1` | infra | No | Untouched |

### No new dependencies
`package.json`'s `dependencies` and `devDependencies` are **byte-identical** between HEAD and
upstream. TypeScript stays `^6.0.3`. `package-lock.json` conflicts on the version field and
churn only.

### ⚠️ Two toolchain/manifest gates that are NOT no-ops

**(a) `minAppVersion` 1.8.7 → 1.10.0.** `manifest.json` auto-merges to upstream's value. v5.17.2
raised it because the Bases API (`base` agent) only exists in Obsidian 1.10.0, and the old claim
failed Obsidian's automated review in 23 places. **Check the Obsidian version on the deploy target
before merging** — if it is below 1.10.0, this build will not load. (Obsidian 1.10.0 shipped
October 2025.)

**(b) New build gate: `npm run schemas:check` now runs FIRST in `build`.**
```
"build": "npm run schemas:check && npm run lint && …"
```
It regenerates the tool catalogue from the running code and fails the build if the committed bundle
for the current `package.json` version differs. New `schemas/` directory with per-release snapshots
(`5.17.2` … `5.18.2`). The fork has **zero fork-original tools**, so this should pass unchanged — but
if it fails, the fix is `npm run schemas:release`, not editing JSON by hand. Note the `version` npm
script now also stages `cli-first-tool-schemas.json`, `tool-schemas.json` and `schemas/` — relevant
to `/nexus-release`.

**Node:** upstream moved CI to Node 22 (`78a5b665`) because the test suite requires it. Local Node
is **v26.7.0** — fine.

---

## 5. What is in v5.17.0 → v5.18.2 (49 commits)

**Tool operation receipts + reversible tooling (#356)** — the v15 migration. Every mutating command
writes a durable receipt before it runs; replaying the same operation id replays the receipt instead
of redoing the work, and reusing that id for a *different* command is rejected. Receipts live in the
vault event log, so they survive a reload and a cache rebuild. Read-only commands record nothing.
Batches mixing reads with writes are now refused by name rather than raced.

**Deletes that stick (#347, #348)** — permanently deleting a workspace used to leave its sessions,
states, traces, projects and tasks behind, and the next cache rebuild resurrected the whole orphaned
set. Session deletion wasn't recorded at all. Both now write ownership-aware deletion events.
**Directly relevant to this vault's "Workspace Delete Persistence" known issue (Feb 2), which is
plausibly the same bug.**

**Reasoning display, unified (#354, #357)** — consistent thinking across Anthropic, Gemini, OpenAI,
OpenRouter, LM Studio. Anthropic's signed thinking blocks are now replayed unchanged after a tool
call (previously a thinking model that used a tool could fail mid-turn). Gemini thought summaries
are now requested, so Gemini reasoning renders at all.

**Storage / startup (#341, #342, #360, #361, #363, #355)** — the startup rebuild watchdog is now
armed on the background branch too (#158); corrupt-cache recovery stops reporting success when it
failed; background indexing no longer outlives the plugin instance; conversations are re-derived
first after a rebuild so chat search returns in seconds instead of hours; states load after an
incomplete storage migration. **This is the same symptom family as the fork's slow-rebuild notes —
see [`chat-db-load-slow-rebuild-plan.md`](./chat-db-load-slow-rebuild-plan.md) §0.**

**States performance (#219, #346, #359)** — the v16 migration. `listStates` on a 200-state workspace
went from ~500 ms and 180k parsed events to ~6 ms and none. State lookup by name is now SQL, not a
scan of the first page.

**Search scope (#340)** — semantic search applied the folder scope *after* ranking the whole vault,
so a folder full of relevant notes could return nothing. Scope is now part of the query.

**Groq/compat adapters (#368, #370)** — Groq sent no conversation history into tool continuations, so
Groq chat went silently blank on first tool use. Requesty and Perplexity had the same latent gap.
All compatible providers now share one history-aware message builder.

**`content remove-property` (#365)** — the missing frontmatter delete. `set-property` with null wrote
`property: null` instead of dropping the line.

**Models** — Claude 5 family (Fable/Opus/Sonnet 5) on the Claude Code provider, defaulting to
Sonnet 5; Claude Opus 5 on the Anthropic provider with Sonnet 5 pricing corrected to $2/$10 per M;
GLM 5.3 + GLM 5.3 Flash; Qwen3.8 27B / Qwen 3.6 27B; **five dead Groq models pruned and the Groq
default changed to GPT-OSS 120B**. Check the vault's configured models against the prune.

**Chat UI (#377, #378)** — the tool ticker went dark after the first completed turn and now re-arms
per turn, showing the `useTools` goal sentence; Thinking blocks read left-aligned on mobile.

**Housekeeping** — `919d725f` stops outbound headers identifying as `Synaptic-Lab-Kit`;
`fecda0ef` adds a README network-disclosure section; `51fe4143` makes the mobile gate a Node checker
so a clean build no longer needs Python. Neither of the first two relates to the fork's security
audit — see that document's status section.

---

## 6. Execution steps

```bash
git checkout -- src/utils/connectorContent.ts   # if timestamp-only churn present
git merge upstream/main --no-edit

# 1. Routine
git checkout --theirs package-lock.json
git add package-lock.json

# 2. ⭐ Retire the thunk — take upstream wholesale (§3)
git checkout --theirs src/ui/chat/ChatView.ts \
                      src/ui/chat/services/ChatSendCoordinator.ts \
                      src/ui/chat/services/ChatSessionCoordinator.ts \
                      src/ui/chat/services/ChatSubagentIntegration.ts
git add src/ui/chat/ChatView.ts src/ui/chat/services/Chat{Send,Session}Coordinator.ts \
        src/ui/chat/services/ChatSubagentIntegration.ts
grep -rn "getChatService" src/ui/chat/ | grep -c "?? null"   # sanity: upstream's shape, not the fork's

# 3. ⭐ MANUAL: SchemaMigrator.ts (§2)
#    - resolve CURRENT_SCHEMA_VERSION conflict to 24
#    - renumber the auto-merged v15 block -> 23, v16 block -> 24 (SQL verbatim, '[upstream vN]' prefix)
#    - update the convention comment's worked example, and add STEP 5 (schema.ts stamp)
# 4. ⭐ MANUAL: tests/unit/SchemaMigrator.test.ts — checkout --theirs, then renumber onto it (§2)
# 5. ⭐ schema.ts hygiene: INSERT OR IGNORE INTO schema_version VALUES (24, ...) + header comment
git add src/database/schema/SchemaMigrator.ts src/database/schema/schema.ts \
        tests/unit/SchemaMigrator.test.ts

git commit --no-edit

npm install
npm run build          # NOTE: schemas:check runs FIRST now — see §4(b)

npx jest tests/unit/SchemaMigrator.test.ts    # green with 23/24 expectations
npx jest tests/unit/ChatViewChatServiceWiring.test.ts tests/unit/ChatSubagentIntegration.test.ts

git add package-lock.json src/utils/connectorContent.ts src/utils/cliAssets.ts
git commit -m "chore: regen build artifacts post v5.18.2 merge"

git diff upstream/main HEAD --name-only    # expect the SHRUNKEN fork set (§8)
```

### Post-merge verification checklist
- [ ] `SchemaMigrator.ts`: `CURRENT_SCHEMA_VERSION = 24`; migrations 17–24 present; v23/v24 SQL
      byte-identical to upstream v15/v16; convention comment updated with STEP 5
- [ ] `schema.ts`: stamp literal = **24**; header `Current Version: 24`
- [ ] `SchemaMigrator.test.ts` green (~15–17 tests), incl. a "starting at v22 runs 23+24" case
- [ ] **Thunk is GONE**: `grep -rn "getChatService" src/ui/chat/` shows upstream's
      `ChatService | null` shape everywhere; zero fork-shaped `() => this.chatService` without `?? null`
- [ ] `eslint.config.mjs` JSONLWriter exemption intact; `eslint .` green
- [ ] `availableUpdateVersion` guard intact (8 refs)
- [ ] `npm run build` fully green **including the new `schemas:check` gate**
- [ ] `manifest.json` `minAppVersion` = 1.10.0 **and the deploy target is on Obsidian ≥ 1.10.0**
- [ ] Divergence surface = the shrunken fork set only

### npm audit
Standing rule: no `npm audit fix`. Current set is 9 (0 critical, 7 high); dependencies are identical
to upstream so the set will not move. **One item deserves a separate decision, not a merge action:
`pdfjs-dist` HIGH (arbitrary JS execution on a malicious PDF) is the only shipped runtime
vulnerability** — tracked in the security audit's status section.

---

## 7. Risk callouts

| Risk | Level | Check |
|------|-------|-------|
| **`minAppVersion` 1.10.0** | **MEDIUM — check BEFORE merging** | The only change that can hard-block the deploy. Confirm the target Obsidian is ≥ 1.10.0; if not, stop at 5.17.1. |
| **Two migrations run on first launch (23 + 24)** | **MEDIUM-watch** | v23 is additive `IF NOT EXISTS` (no-op-ish). **v24 is an `ALTER TABLE states ADD COLUMN isArchived`, deliberately NULL-with-no-default**, followed by a one-time `backfillDerivedStateMetadata()` that reads each workspace JSONL once. On this vault (70 workspace shards, 132 MB) that backfill is a real first-launch cost — expect a slower first start, once. **After deploy: confirm no `SQLite3Error`, and that saved states still list with correct archive status and descriptions.** |
| **Groq model prune + default change** | **MEDIUM** | Five Groq models removed, default → GPT-OSS 120B. Verify the vault's configured chat/agent/image/transcription models all still resolve (the v5.12.1 prune precedent: verify, don't assume). |
| **Thunk retirement** | **LOW-positive** | Taking upstream's stricter version. The regression risk is *not* taking it — leaving fork code where upstream now has tests. |
| **Receipts table (#356)** | **LOW-watch** | New durable write path on every mutating command. Watch for receipt-write errors in console on first heavy tool session. |
| **Streaming rebuilt on a typed event contract** | **LOW-watch** | Large refactor under the chat surface. Smoke: stream a reply, stream one with a tool call, abort one mid-stream (aborted turns are now recorded as failed, not success). |
| **Data-folder reset** | **LOW** | Verify `rootPath = "00-System/Nexus"` + `migration.state = verified` post-launch. |
| **MCP connection** | LOW | stdio smoke. |

---

## 8. Post-merge housekeeping
- **`docs/fork_divergence.md`**: audit header → v5.18.2; **DELETE the Tier-3 `ChatView.ts` +
  3-coordinator entry** (retired, take-theirs — add it to "Retired entries" with the reason:
  upstream landed the same fix independently in `d3e473ba`/#358, stricter, with tests); update the
  Tier-2 SchemaMigrator entry to v24 and record that upstream needs **6 more** migrations before
  their counter exceeds the fork MAX (was 8); **ADD a Tier-2 entry for `src/database/schema/schema.ts`**
  if the stamp fix lands as described in §2.
- Record the second renumber as precedent: the first one moved one migration, this one moved two,
  and the conflict shape held both times (single `CURRENT_SCHEMA_VERSION` hunk; new blocks
  auto-merge out of order to the end).
- The fork's code divergence goes **13 files → 9** (10 if the schema.ts stamp fix is kept). Best
  convergence movement since the HybridStorageAdapter retirement.
- Re-check the vault's **Workspace Delete Persistence** known issue (Feb 2) against #347/#348 — it
  may now be fixed upstream and removable from the known-issues list.
- Bump `package.json`/`manifest.json` and run `/nexus-release` — note the `version` script now also
  stages the schema catalogue files.
- Deploy, then §7 smoke, with emphasis on **first-launch migration + the v24 state backfill**.
