# Fork Divergence Registry

This file is the authoritative record of every file in `my-custom-branch` that intentionally
diverges from upstream (`ProfSynapse/nexus`). Load it at the start of every upstream merge
session to know which files require manual resolution and which can be auto-merged.

**Last audited against:** upstream/main HEAD (`ffc55f30`) — v5.8.2 (PRs #169–#170)  
**Audit date:** 2026-04-20  
**Next merge target:** next upstream/main HEAD

---

## Tier 1 — Always conflict on upstream merge

These files contain fork-specific additions that upstream will never have. Every upstream merge
requires manual resolution using the pattern: accept upstream base, then layer back the fork additions.

*No Tier 1 entries.* The action bar feature (MessageBubble.ts integration, MessageActionBar.ts,
CreateFileModal.ts) was deprecated and removed in the v5.8.0 merge (2026-04-18). MessageBubble.ts
now tracks upstream exactly.

---

## Tier 2 — Conflict only when upstream touches them

These files have fork additions that are self-contained. Upstream rarely touches them, but when
they do a conflict will occur. Resolution is always: take upstream base, then restore the fork block.

| File | Fork change | Fork block to restore |
|------|-------------|----------------------|
| `src/database/adapters/HybridStorageAdapter.ts` | 5 fork patches keep all I/O in plugin-scoped storage (`.obsidian/plugins/nexus/data/`). `fullRebuild()` timeout removed (commit `6087f8b9`). | Take upstream base; restore all 5 patches. Do NOT add timeout to fullRebuild. See `e0f0ad9f`. **⚠ Phase 2 BLOCKED**: upstream `backfillVaultEventStore()` reads from `.nexus/` only — our data is in plugin-scoped storage (migrated v5.7.0), so backfill finds nothing, marks 'verified', routes reads to empty vault-root → empty UI. Reverted `593f345b`. |
| `src/database/schema/SchemaMigrator.ts` | Convention comment + fork migrations v17–v19 (v12–v16 removed 2026-04-08) | Restore convention comment block + migrations v17–v19. When upstream ships their v12, renumber it to 20 and set `CURRENT_SCHEMA_VERSION = 20`. |

---

## Tier 3 — Fork bug fixes (low conflict risk, but track for awareness)

*No Tier 3 entries.* All Tier 3 patches retired as of 2026-04-20.

**Retired entries:**
- `src/database/adapters/HybridStorageAdapter.ts` — **ATTEMPTED RETIREMENT 2026-04-20** (commit `ba27d293`), **REVERTED** (`593f345b`): backfill reads from `.nexus/` not plugin-scoped; vault-root got incomplete data; empty UI. Patches re-applied. Blocked pending upstream fix.
- `src/ui/chat/builders/ChatLayoutBuilder.ts` — **RETIRED 2026-04-20** (commit `879bfede`): took upstream exactly; banner restored, `_component` rename removed
- `src/settings/tabs/WorkspacesTab.ts` — **RETIRED 2026-04-20** (commit `879bfede`): took upstream exactly; upstream v5.8.2 has own race-condition mitigation, `waitForReady()` patch no longer needed
- `src/settings.ts` — **RETIRED 2026-04-20** (commit `879bfede`): took upstream exactly; stale badge fix removed (upstream users not reporting this issue)
- `src/agents/searchManager/services/MemorySearchProcessor.ts` — **RETIRED 2026-04-19**: upstream dropped `?.` guards (v5.8.1); taking upstream version
- `src/agents/toolManager/services/ToolBatchExecutionService.ts` — **RETIRED 2026-04-19**: upstream dropped `workspace.name?.` guard (v5.8.1)
- `src/services/WorkspaceService.ts` — **RETIRED 2026-04-19**: upstream dropped `name ?? ''` and `name?.` guards (v5.8.1)
- `src/components/shared/ChatSettingsRenderer.ts` — **RETIRED 2026-04-19**: upstream added `void` back (v5.8.1); taking upstream version
- `src/ui/chat/components/MessageActionBar.ts` — **RETIRED 2026-04-18**: action bar feature deprecated and removed in v5.8.0 merge
- `src/ui/chat/components/CreateFileModal.ts` — **RETIRED 2026-04-18**: action bar feature deprecated and removed in v5.8.0 merge
- `src/ui/chat/components/MessageBubble.ts` — **RETIRED 2026-04-18**: no longer fork-divergent after dropping action bar
- `styles.css` — **RETIRED 2026-04-15**: no fork CSS divergence; action button styles absorbed by upstream
- `src/database/storage/JSONLWriter.ts` — **RETIRED 2026-04-19**: `readEventsStreaming()` dead code fully removed by upstream in v5.8.1 (was documented retired 2026-04-15 but lingered in fork)
- `eslint.config.mjs` — **RETIRED 2026-04-19**: JSONLWriter readline exclusion removed by upstream in v5.8.1
- `src/settings/tabs/ProvidersTab.ts` — **RETIRED 2026-04-09**: superseded by upstream PR #126
- `src/components/LLMProviderModal.ts` — **RETIRED 2026-04-09**: superseded by upstream PR #126
- `src/database/repositories/MessageRepository.ts` — **RETIRED 2026-04-09**: superseded by upstream PR #123
- `src/ui/chat/components/ContextProgressBar.ts` — **RETIRED 2026-04-15**: file deleted by upstream PR #131

---

## Special case — connectorContent.ts

`src/utils/connectorContent.ts` is generated during build (timestamp in header). It should be
**reset to upstream before every merge** with:

```
git restore src/utils/connectorContent.ts
```

Do not treat timestamp-only diffs as fork divergences.

---

## How to use this file

1. Before each upstream merge, run: `git diff --name-status upstream/main..my-custom-branch`
2. Cross-reference each modified file against this registry
3. Files not listed here should match upstream exactly — investigate any that don't
4. After resolving conflicts, re-run the diff to confirm no unintended divergences remain
5. If new fork additions are made, add them to this file before committing

---

## Post-deploy checklist

After every `npm run deploy` + Obsidian reload:

1. Open the Nexus UI — workspaces and conversations should appear within ~5 seconds
2. If the UI shows only "Default" workspace or is empty, **do not reload**. Wait 3–4 minutes for fullRebuild to complete in the background.
3. If still empty after 4 minutes, the sync_state loop has re-triggered. Run the repair script with Obsidian closed:
   ```
   node scripts/repair_sqlite_cache.js
   ```
   Then reopen Obsidian. Data appears immediately (no wait).

**Root cause of the loop:** `sync_state` empty in `cache.db` → `fullRebuild` → `clearAllData()` → rebuild interrupted → `sync_state` never written → same loop on next startup. The JSONL source files are never touched; only SQLite is affected.

**All vault data is in plugin-scoped storage** (`.obsidian/plugins/nexus/data/`). The `00-System/Nexus` path in the Nexus Data tab is ignored by the fork patches. `Nexus_vault_root_REVIEW/` and `NEXUS/` in the vault root are stale backup folders — confirmed up-to-date with plugin-scoped as of 2026-04-20.
