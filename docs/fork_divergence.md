# Fork Divergence Registry

This file is the authoritative record of every file in `my-custom-branch` that intentionally
diverges from upstream (`ProfSynapse/nexus`). Load it at the start of every upstream merge
session to know which files require manual resolution and which can be auto-merged.

**Goal:** Full congruence with upstream wherever possible. Fork-specific additions should be
retired as soon as they are no longer needed or superseded by upstream. The only permanent
divergences are files that are fork-infrastructure by nature (deploy scripts, fork docs) or
that carry data migrations specific to this vault.

**Last audited against:** upstream/main HEAD (`b40be807`) — v5.9.3 (Obsidian release-review + source-review compliance)  
**Audit date:** 2026-05-13  
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
| `src/database/schema/SchemaMigrator.ts` | Convention comment + fork migrations v17–v19 (v12–v16 removed 2026-04-08) + v20 (renumbered from upstream v12 `shard_cursors`, merged 2026-05-07). `CURRENT_SCHEMA_VERSION = 20`. | Restore convention comment block + migrations v17–v20. When upstream ships their next migration (v13 in upstream numbering), renumber it to 21 and set `CURRENT_SCHEMA_VERSION = 21`. |
| `src/database/storage/JSONLWriter.ts` | `readEventsStreaming()` private method using Node.js `readline` for streaming large JSONL files. Marked retired 2026-04-19 prematurely — method is still present. **Retirement candidate (Phase 4)**: verify no callers, then remove method and take upstream exactly. |
| `eslint.config.mjs` | `"src/database/storage/JSONLWriter.ts"` added to Node.js modules exemption list. Required as long as JSONLWriter.ts carries `readEventsStreaming()`. **Retire together with JSONLWriter.ts.** |

---

## Tier 3 — Fork bug fixes (low conflict risk, but track for awareness)

| File | Fork change | Notes |
|------|-------------|-------|
| `src/settings/SettingsView.ts` | `availableUpdateVersion` stale-clear guard in `renderHeader` (commit `a4922ef4`, 2026-04-28). | As of v5.9.x upstream removed the in-plugin auto-updater and the "Update" button just opens the GitHub release page in a browser — `availableUpdateVersion` is still persisted but never cleared after the user installs, so this guard is universally useful now (not just for direct-deploy users). More upstream-eligible than ever. |
| `tests/unit/SchemaMigrator.test.ts` | Numeric assertions track v20 renumber (upstream tests it at v12). Seed in "starting at prior version" test changed v11 → v19 so only the renumbered migration applies. (commit `be4dd26b`, 2026-05-07) | Will need re-adjustment whenever upstream lands another migration that the fork renumbers. |

**Retired entries:**
- `tests/unit/ModelAgentManager.test.ts` — **RETIRED 2026-05-13** (v5.9.3 merge `f4fe29f1`): upstream switched the assertion from strict `toHaveBeenCalledWith({...})` to `expect.objectContaining({...})`, which tolerates the fork's extra `imageProvider`/`imageModel`/`transcriptionProvider`/`transcriptionModel` fields without adjustment. Took upstream entirely.
- `src/database/adapters/HybridStorageAdapter.ts` — **RETIRED 2026-04-20** (commit `ebd13dba`): pre-migrated 59 files/22,872 events to vault-root via `scripts/migrate_to_vault_root.js`, then took upstream exactly. All 5 patches removed. Data now in `00-System/Nexus/data/`.
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
- `src/database/storage/JSONLWriter.ts` — **INCORRECTLY RETIRED 2026-04-19**: method was never removed from fork. Re-listed as active Tier 2 divergence 2026-04-24.
- `eslint.config.mjs` — **INCORRECTLY RETIRED 2026-04-19**: exemption was never removed from fork. Re-listed as active Tier 2 divergence 2026-04-24.
- `src/agents/searchManager/services/MemorySearchProcessor.ts` — **RE-RETIRED 2026-04-24** (commit `2ecafad2`): `?.` guards re-introduced after v5.8.1 retirement; removed again to match upstream.
- `src/agents/toolManager/services/ToolBatchExecutionService.ts` — **RE-RETIRED 2026-04-24** (commit `2ecafad2`): same as above.
- `src/ui/chat/components/BranchHeader.ts` — **RETIRED 2026-04-24** (commit `2ecafad2`): verbose JSDoc trimmed to match upstream's single-line form.
- `src/database/storage/SQLiteMaintenanceService.ts` — **RETIRED 2026-04-24** (commit `2ecafad2`): trailing blank line removed to match upstream.
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
