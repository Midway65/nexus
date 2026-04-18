# Fork Divergence Registry

This file is the authoritative record of every file in `my-custom-branch` that intentionally
diverges from upstream (`ProfSynapse/nexus`). Load it at the start of every upstream merge
session to know which files require manual resolution and which can be auto-merged.

**Last audited against:** upstream/main HEAD (`b03e7630`) — v5.8.0 (PRs #141–#157)  
**Audit date:** 2026-04-18  
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
| `src/ui/chat/builders/ChatLayoutBuilder.ts` | Banner removal (beta/experimental warning stripped). Upstream re-added auto-hide banner in v5.8.0. | Take upstream base; delete the `this.createWarningBanner(mainContainer, component)` call and the `createWarningBanner()` method body; rename `component` param to `_component` to satisfy ESLint unused-vars rule. |
| `src/database/adapters/HybridStorageAdapter.ts` | 3 fork patches disabling vault-root migration. See vault-root risk memory for detail. | (1) Remove `backfillVaultEventStore()` call, `let storagePlan` → `const storagePlan`; (2) Replace `shouldBlockStartupHydration` block with `const shouldBlockStartupHydration = false; this.clearStartupHydrationState();`; (3) In `applyStoragePlan`: replace `setVaultEventStoreReadEnabled(plan.state...)` with `setVaultEventStoreReadEnabled(false)`. |
| `src/settings.ts` | Stale update badge fix: clears `availableUpdateVersion` if stored value ≤ current manifest version. | Restore the 15-line version comparison block at end of `applyLoadedData()` (see commit `2c30fd2e`). |
| `src/database/schema/SchemaMigrator.ts` | Convention comment + fork migrations v17–v19 (v12–v16 removed 2026-04-08) | Restore convention comment block + migrations v17–v19. When upstream ships their v12, renumber it to 20 and set `CURRENT_SCHEMA_VERSION = 20`. |

---

## Tier 3 — Fork bug fixes (low conflict risk, but track for awareness)

These files contain fixes for bugs present in upstream or data-quality issues specific to this
installation. They are unlikely to conflict because upstream is not touching the same lines, but
they must be reviewed on each merge to ensure upstream hasn't shipped a conflicting fix.

### Null-safe `workspace.name` fixes
Upstream has a historical record with `name: null` that crashes `.toLowerCase()`. Fixed with
optional chaining. If upstream fixes this themselves, take their version and drop ours.

| File | Change |
|------|--------|
| `src/agents/searchManager/services/MemorySearchProcessor.ts` | `state.name?.toLowerCase()`, `workspace.name?.toLowerCase()` |
| `src/agents/toolManager/services/ToolBatchExecutionService.ts` | `workspace.name?.toLowerCase()` |
| `src/services/WorkspaceService.ts` | `(a.name ?? '').localeCompare(b.name ?? '')`, two `ws.name?.toLowerCase()` guards |

### UI / UX fixes

| File | Change |
|------|--------|
| `src/components/shared/ChatSettingsRenderer.ts` | Removed `void` from `this.syncWorkspacePrompt(value)` call |

**Retired entries:**
- `src/ui/chat/components/MessageActionBar.ts` — **RETIRED 2026-04-18**: action bar feature deprecated and removed in v5.8.0 merge
- `src/ui/chat/components/CreateFileModal.ts` — **RETIRED 2026-04-18**: action bar feature deprecated and removed in v5.8.0 merge
- `src/ui/chat/components/MessageBubble.ts` — **RETIRED 2026-04-18**: no longer fork-divergent after dropping action bar
- `styles.css` — **RETIRED 2026-04-15**: no fork CSS divergence; action button styles absorbed by upstream
- `src/database/storage/JSONLWriter.ts` — **RETIRED 2026-04-15**: streaming fallback removed in v5.7.4 merge
- `eslint.config.mjs` — **RETIRED 2026-04-15**: readline exception removed
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
