# Fork Divergence Registry

This file is the authoritative record of every file in `my-custom-branch` that intentionally
diverges from upstream (`ProfSynapse/nexus`). Load it at the start of every upstream merge
session to know which files require manual resolution and which can be auto-merged.

**Last audited against:** upstream/main HEAD (`3f57f235`) — v5.7.3–v5.7.4 (PRs #129–#138)  
**Audit date:** 2026-04-15  
**Next merge target:** next upstream/main HEAD

---

## Tier 1 — Always conflict on upstream merge

These files contain fork-specific additions that upstream will never have. Every upstream merge
requires manual resolution using the pattern: accept upstream base, then layer back the fork additions.

| File | Fork change | Resolution pattern |
|------|-------------|-------------------|
| `src/ui/chat/components/MessageBubble.ts` | Action bar: `import MessageActionBar`, `private actionBar` field, `appendActionBar()`, `cleanupActionBar()`, call sites in `createElement`/`updateWithNewMessage`/`rebuildElement`/`cleanup`. `appendActionBar()` queries `.message-content` and passes it as `contentEl` to the `MessageActionBar` constructor (selection-aware feature). Based on upstream's glass redesign — uses `ThinkingLoader`, no `ProgressiveToolAccordion`, no `ToolBubbleFactory`. | Take upstream as base; add `import { MessageActionBar }`, `private actionBar` field; insert `appendActionBar()` calls after each `this.element = ...` assignment in `createElement()`; add call at end of `updateWithNewMessage()`; add `cleanupActionBar()` in `rebuildElement()` before `branchNavigatorBinder.destroy()`; add `cleanupActionBar()` in `cleanup()`; add `appendActionBar()` and `cleanupActionBar()` method bodies. |

**Fork-only files (no upstream counterpart — always rebase cleanly):**
- `src/ui/chat/components/MessageActionBar.ts` — Copy / Insert / Append / Create buttons. Selection-aware: reads `window.getSelection()` scoped to the bubble's `.message-content` element; falls back to full message text when no selection. All four buttons have `mousedown → preventDefault()` to preserve selection/cursor through click.
- `src/ui/chat/components/CreateFileModal.ts` — modal for creating a new vault file from chat content (or selected text).

---

## Tier 2 — Conflict only when upstream touches them

These files have fork additions that are self-contained. Upstream rarely touches them, but when
they do a conflict will occur. Resolution is always: take upstream base, then restore the fork block.

| File | Fork change | Fork block to restore |
|------|-------------|----------------------|
| `styles.css` | ~~Sticky assistant header rule~~ — **RETIRED 2026-04-15**: `.message-header` is now `display: none` in upstream's glass redesign; sticky rule was moot. No fork CSS divergence in this file beyond the fork's action button styles (which auto-merged). | No action needed for this entry |
| `src/ui/chat/builders/ChatLayoutBuilder.ts` | Banner removal (beta/experimental warning stripped) | Remove the `createWarningBanner` method and any call site after taking upstream |
| `src/database/schema/SchemaMigrator.ts` | Convention comment + fork migrations v17–v19 (v12–v16 removed 2026-04-08) | Restore convention comment block + migrations v17–v19. When upstream ships their v12, renumber it to 20 and set `CURRENT_SCHEMA_VERSION = 20`. |

**Note:** `HybridStorageAdapter.ts` had a fork prune block (removed 2026-04-08). No fork changes remain. Upstream touches this file frequently — take upstream as base with nothing to restore.

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

### JSONL data quality fixes
Fixes for streaming write amplification and large-file read limits. ConversationRepository now
uses upstream's tombstone approach (no fork divergence); pre-tombstone orphan pruning removed 2026-04-08.

| File | Change |
|------|--------|
| ~~`src/database/repositories/MessageRepository.ts`~~ | ~~Skips JSONL write during streaming states (`draft`/`streaming`)~~ — **RETIRED 2026-04-09**: superseded by upstream PR #123 `hasChanges()` dirty-check (more complete fix) |
| ~~`src/database/storage/JSONLWriter.ts`~~ | ~~`readEventsStreaming()` fallback for >50 MB files~~ — **RETIRED 2026-04-15**: upstream PR #134 vault-root storage rewrote `readEvents()` to delegate to `StorageRouter`. The fork's streaming fallback was removed in this merge. No fork divergence remains in this file. |
| ~~`eslint.config.mjs`~~ | ~~JSONLWriter.ts readline exception~~ — **RETIRED 2026-04-15**: readline usage removed from JSONLWriter along with streaming fallback. Verify eslint.config.mjs no longer has this exception. |

### Provider / HTTP fixes

| File | Change |
|------|--------|
| ~~`src/settings/tabs/ProvidersTab.ts`~~ | ~~`onSave` simplified from IIFE~~ — **RETIRED 2026-04-09**: superseded by upstream PR #126 `persistProviderConfig()` helpers |
| ~~`src/components/LLMProviderModal.ts`~~ | ~~`onSave` type widened to `void \| Promise<void>`~~ — **RETIRED 2026-04-09**: superseded by upstream PR #126 `persistConfig()` with full `Promise<void>` + error handling |

### UI / UX fixes

| File | Change |
|------|--------|
| ~~`src/ui/chat/components/ContextProgressBar.ts`~~ | ~~Obsidian API correctness fix~~ — **RETIRED 2026-04-15**: file deleted by upstream PR #131 (glass redesign replaced ContextProgressBar with ContextBadge + ToolStatusBar). File is gone. |
| `src/components/shared/ChatSettingsRenderer.ts` | Removed `void` from `this.syncWorkspacePrompt(value)` call |
**Retired entries (absorbed by upstream PR #119):**
- `ChatView.ts` — `active-leaf-change` handler: now in upstream's ChatView (line 607). No longer fork-divergent.
- `BranchHeader.ts` — JSDoc addition superseded; upstream PR #119 moved `BranchHeader` to `ChatBranchViewCoordinator`. No longer fork-divergent.

---

## Special case — connectorContent.ts

`src/utils/connectorContent.ts` is generated during build (timestamp in header). It should be
**reset to upstream before every merge** with:

```
git checkout upstream/main -- src/utils/connectorContent.ts
```

Do not treat timestamp-only diffs as fork divergences.

---

## How to use this file

1. Before each upstream merge, run: `git diff --name-status upstream/main..my-custom-branch`
2. Cross-reference each modified file against this registry
3. Files not listed here should match upstream exactly — investigate any that don't
4. After resolving conflicts, re-run the diff to confirm no unintended divergences remain
5. If new fork additions are made, add them to this file before committing
