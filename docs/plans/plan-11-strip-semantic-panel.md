# Plan 11 — Strip Semantic Panel and Embedding Indexing

**Status**: Ready to implement  
**Created**: 2026-04-03  
**Goal**: Remove all semantic panel, note embedding indexing, Connections tab, and Embeddings tab code added on the `local-fixes` branch. Preserve all code associated with the Nexus Chat window itself.

---

## What to Preserve

All of these must survive the stripping:

| Feature | Key files |
|---|---|
| Chat action buttons (insert/append/create) | `src/ui/chat/components/MessageActionBar.ts`, `src/ui/chat/modals/CreateFileModal.ts`, `src/ui/chat/services/EditorInsertService.ts` |
| Chat UI bug fixes (accordion, beta warning, input resize, ConversationList) | `src/ui/chat/ChatView.ts`, `src/ui/chat/components/*` |
| Ingest banner in chat window | `ChatLayoutBuilder.ts` `ingestBannerContainer` — shows ingestion progress inside chat |
| `chat-header-right` flex group | `ChatLayoutBuilder.ts` — `AgentStatusMenu` uses `settingsButton.parentElement` which is this div |
| Ingester, Composer, WebTools apps | `src/agents/apps/ingestManager/`, `src/agents/apps/composer/`, `src/agents/apps/webTools/` |
| FilePickerRenderer folder selection | `src/components/workspace/FilePickerRenderer.ts` |
| All LLM adapter fixes | `src/services/llm/adapters/**` |
| DefaultsTab chat actions section | `src/settings/tabs/DefaultsTab.ts` (`defaultNewFileLocation` field) |
| `shouldCompactBeforeSending(conversationOrMessage \| string)` overload | `ModelAgentManager.ts` — **upstream change from ingester merge (c64e6502), do NOT revert** |
| `enableIngestion?: boolean` in `MCPSettings` | `PluginTypes.ts` — ingester setting, not semantic |
| Task note-link data model | `linkNote` MCP tool, `task_note_links` table, `TaskService.linkNote/unlinkNote` — all upstream, no semantic dependency |
| `postbuild.ps1` | root |

---

## Step 1 — Delete Files Entirely

These files are 100% semantic work.

> **Note on uncommitted changes**: `EmbeddingExclusionService.ts`, `EmbeddingIndexCoordinator.ts`, `EmbeddingModelCatalog.ts`, `EmbeddingsTab.ts`, and `SemanticFeedbackPipeline.ts` all have uncommitted working-tree modifications (LCSH-related tuning from Plan-08/09). These are also being removed, so discard them. Use `git rm -f` (not plain `git rm`) for those 5 files, or delete via filesystem first and then `git rm`. The LCSH changes in `EmbeddingUtils.ts` are handled by the `git checkout origin/main` restore in Step 2.

### Semantic Panel UI (10 files)
```
src/ui/semanticPanel/ConnectionsService.ts
src/ui/semanticPanel/ConnectionsSettings.ts
src/ui/semanticPanel/SemanticFeedbackPipeline.ts
src/ui/semanticPanel/SemanticFeedbackService.ts
src/ui/semanticPanel/SemanticPanelNavigation.ts
src/ui/semanticPanel/SemanticPanelTypes.ts
src/ui/semanticPanel/SemanticPanelView.ts
src/ui/semanticPanel/SemanticResultLoader.ts
src/ui/semanticPanel/SemanticResultRow.ts
src/ui/semanticPanel/SemanticSendModal.ts
```

### Settings Tabs (2 files)
```
src/settings/tabs/ConnectionsTab.ts
src/settings/tabs/EmbeddingsTab.ts
```

### UI Manager (1 file — `ChatUIManager.ts` and `TaskBoardUIManager.ts` are upstream; leave them)
```
src/core/ui/SemanticPanelUIManager.ts
```

### New Embedding Services (6 files — not present in upstream)
```
src/services/embeddings/EmbeddingExclusionService.ts
src/services/embeddings/EmbeddingIndexCoordinator.ts
src/services/embeddings/EmbeddingModelCatalog.ts
src/services/embeddings/EmbeddingPreprocessor.ts
src/services/embeddings/EmbeddingRuntime.ts
src/services/embeddings/NoteChunker.ts
```

### MCP Tool (1 file)
```
src/agents/searchManager/tools/findRelated.ts
```

### Utilities (2 files)
```
src/utils/noteSearch.ts
src/ui/tasks/NoteInputSuggester.ts
```
Note: `noteSearch.ts` wraps EmbeddingService semantic search with fuzzy fallback. `NoteInputSuggester.ts` uses it for the task board note-link input. Both are entirely new and semantic.

### Docs / Plans (git-tracked semantic research — 8 files, use `git rm`)
```
docs/plans/nexus-smartconnections-integration-plan-v5.md
docs/plans/nexus-smartconnections-integration-plan-v6.md
docs/plans/plan-04-semantic-database.md
docs/plans/plan-04-semantic-database-final.md
docs/plans/plan-05-semantic-panel.md
docs/plans/plan-05-semantic-panel-final.md
docs/plans/plan-07-semantic-matching-investigation.md
docs/plans/plan-08-semantic-panel-ux-improvements.md
```

### Docs / Plans (untracked filesystem-only — 2 files, `rm` only, NOT `git rm`)
```
docs/plans/plan-09-lcsh-prefix-mismatch.md
docs/plans/plan-10-external-indexer.md
```

> **Do NOT delete**: `docs/plans/plan-11-strip-semantic-panel.md`, `docs/plans/plan-12-strip-vault-ancillary.md`, `docs/plans/plan-06-upstream-merge-5.6.5.md` — these are current work plans and must be kept.
> **Do NOT delete**: `docs/plans/plan-01-chat-layout-bugs.md`, `docs/plans/plan-02-perplexity-integration.md`, `docs/plans/plan-03-chat-action-buttons.md` — these are non-semantic plans, tracked in git, keep them.

---

## Step 2 — Restore Files to Upstream State

Restore verbatim from `origin/main`. These were either wholly rewritten or have semantic additions that are easiest to discard entirely.

```bash
git checkout origin/main -- \
  src/services/embeddings/NoteEmbeddingService.ts \
  src/services/embeddings/EmbeddingManager.ts \
  src/services/embeddings/EmbeddingService.ts \
  src/services/embeddings/EmbeddingUtils.ts \
  src/services/embeddings/IndexingQueue.ts \
  src/services/embeddings/index.ts \
  src/services/embeddings/EmbeddingWatcher.ts \
  src/services/embeddings/EmbeddingIframe.ts \
  src/database/schema/schema.ts \
  src/database/schema/SchemaMigrator.ts \
  src/settings/SettingsRouter.ts \
  src/ui/chat/components/suggesters/TextAreaNoteSuggester.ts \
  src/ui/chat/components/suggesters/initializeSuggesters.ts \
  src/ui/tasks/TaskBoardEditModal.ts \
  src/ui/tasks/TaskBoardView.ts \
  src/agents/taskManager/tools/tasks/updateTask.ts
```

**Notes per file:**

| File | Why restore |
|---|---|
| `NoteEmbeddingService.ts` | Rewritten 294→812 lines for semantic indexing |
| `EmbeddingManager.ts` | Rewired with EmbeddingRuntime, EmbeddingIndexCoordinator, HF token |
| `EmbeddingService.ts` | Added EmbeddingRuntime injection; restore to engine-only upstream |
| `EmbeddingUtils.ts` | `preprocessContent` gained `maxChars` param for model-aware truncation |
| `IndexingQueue.ts` | Added `this.embeddingService.getRuntime().maxChars` call |
| `index.ts` | Removed `EmbeddingWatcher` export, added new semantic exports |
| `EmbeddingWatcher.ts` | **Deleted** by our work — must be restored |
| `EmbeddingIframe.ts` | 4 trivial comment lines added; restore for cleanliness |
| `schema.ts` | Added block embedding tables, `embedding_config`, `semantic_feedback` |
| `SchemaMigrator.ts` | Added v12–v16 migrations; upstream is v11 |
| `SettingsRouter.ts` | Only added `'embeddings' \| 'connections'` to tab type — no other changes |
| `TextAreaNoteSuggester.ts` | Replaced inline fuzzy with `noteSearch.ts` + `embeddingService` param |
| `initializeSuggesters.ts` | Added `embeddingService` lookup + passing to `TextAreaNoteSuggester` |
| `TaskBoardEditModal.ts` | Added linked-notes section using `NoteInputSuggester` + `embeddingService` |
| `TaskBoardView.ts` | Added note-link display on cards + `embeddingService` passing to edit modal |
| `updateTask.ts` | Added `addNoteLinks`/`removeNoteLinks` parameters |

---

## Step 3 — Surgical Edits to Shared Files

Files with semantic additions mixed in with other legitimate changes.

---

### 3a. `src/constants/branding.ts`

Remove the `SEMANTIC_PANEL_VIEW_TYPE` constant (3 lines):
```typescript
/** View type for the semantic discovery panel (Plan 05). */
export const SEMANTIC_PANEL_VIEW_TYPE = 'nexus-semantic-panel';
```
Only referenced in deleted `SemanticPanelUIManager.ts` and `src/ui/semanticPanel/` files.

---

### 3b. `src/main.ts`

Remove these 3 public methods added solely for semantic panel access:
```typescript
public getEmbeddingManager() { ... }     // used by EmbeddingsTab
public getSQLiteManager() { ... }        // used by SemanticFeedbackService
public openSettings(_tab?: string) { ... } // used by SemanticPanelView
```

---

### 3c. `src/core/PluginLifecycleManager.ts`

Remove:
- `import { SemanticPanelUIManager } from './ui/SemanticPanelUIManager'`
- `private semanticPanelUIManager: SemanticPanelUIManager` field
- `this.semanticPanelUIManager = new SemanticPanelUIManager({ ... })` in `initialize()`
- `await this.semanticPanelUIManager.registerViewEarly()` call
- `await this.semanticPanelUIManager.registerSemanticPanelUI()` call
- `getSemanticPanelUIManager(): SemanticPanelUIManager` public method

Restore EmbeddingManager constructor to 2-arg upstream form — remove `huggingFaceToken` and exclusion patterns lambda:
```typescript
// Remove:
const huggingFaceToken = this.config.settings.settings.huggingFaceToken;
this.embeddingManager = new EmbeddingManager(
    app, plugin, huggingFaceToken, () => [ ...exclusionPatterns ]
);
// Restore to:
this.embeddingManager = new EmbeddingManager(app, plugin);
```

Keep `getEmbeddingManager(): EmbeddingManager | null` — it existed upstream.

---

### 3d. `src/types/plugin/PluginTypes.ts`

Remove the entire `SemanticPanelSettings` interface (~9 lines).

Remove from `MCPSettings` — these 8 fields only:
```typescript
huggingFaceToken?: string;
semanticExcludePatterns?: string[];
indexingExcludedPatterns?: string[];
indexingExcludedPaths?: string[];
semanticPanel?: Partial<SemanticPanelSettings>;
connections?: Partial<import('../../ui/semanticPanel/ConnectionsSettings').ConnectionsSettings>;
connectionsAutoInjectContext?: boolean;
connectionsContextLimit?: number;
```

**Keep:** `defaultNewFileLocation?: string` (chat actions), `enableIngestion?: boolean` (ingester), all other pre-existing fields.

---

### 3e. `src/settings/SettingsView.ts`

Remove:
- `import { EmbeddingsTab } from './tabs/EmbeddingsTab'`
- `import { ConnectionsTab } from './tabs/ConnectionsTab'`
- `import type { EmbeddingManager } from '../services/embeddings/EmbeddingManager'`
- `private embeddingsTab: EmbeddingsTab | undefined`
- `private connectionsTab: ConnectionsTab | undefined`
- `this.embeddingsTab?.destroy()` and `this.connectionsTab?.destroy()` in `destroy()`
- `private renderEmbeddingsTab(container: HTMLElement): void { ... }` entire method
- `private renderConnectionsTab(container: HTMLElement): void { ... }` entire method
- Their `case` switch blocks in the tab renderer

`pluginLifecycleManager` constructor param/property existed upstream — keep it.

---

### 3f. `src/ui/chat/ChatView.ts`

**Remove** (semantic integration only):

Self-registration with `SemanticPanelUIManager` in `onOpen()` (~4 lines):
```typescript
const lm = (this.plugin as { lifecycleManager?: ... }).lifecycleManager;
lm?.getSemanticPanelUIManager?.()?.setCurrentChatView(this);
```

Self-deregistration in `onClose()` (~3 lines):
```typescript
lm?.getSemanticPanelUIManager?.()?.clearCurrentChatView();
```

Semantic panel button event binding (1 line in the `registerDomEvent` block):
```typescript
this.layoutElements.semanticPanelButton,
() => void this.openSemanticPanel()
```

These 4 private methods entirely:
- `private async openSemanticPanel(): Promise<void>`
- `addSemanticContext(payload: SemanticContextPayload): void`
- `async createChatWithContext(payload: SemanticContextPayload): Promise<void>`
- `getCurrentTitle(): string` — only called by deleted `SemanticPanelUIManager.ts`

**Keep everything else:** MessageActionBar wiring, `IngestEventBinder`, `ingestBannerContainer`, accordion fix, beta warning removal, ConversationList fix, all `registerDomEvent` changes.

---

### 3g. `src/ui/chat/builders/ChatLayoutBuilder.ts`

Remove `semanticPanelButton` from:
- `ChatLayoutElements` interface
- `createHeader()` method body and return value
- `build()` return object

```typescript
// Remove from interface:
semanticPanelButton: HTMLElement;

// Remove from createHeader() body:
const semanticPanelButton = headerRight.createEl('button', { cls: 'chat-semantic-panel-button' });
setIcon(semanticPanelButton, 'network');
semanticPanelButton.setAttribute('aria-label', 'Open Semantic Panel');

// Remove from both return sites:
semanticPanelButton,
```

**Keep** `chat-header-right` wrapper div — `AgentStatusMenu` inserts using `settingsButton.parentElement`, which is this wrapper. Without it, AgentStatusMenu injects into `chat-header` breaking the layout.

**Keep** `ingestBannerContainer` and the warning-banner removal.

---

### 3h. `src/ui/chat/services/ModelAgentManager.ts`

Remove:
- `getEmbeddingManager?: () => ...` type declaration from the local plugin interface
- `connectionsAutoInjectContext`, `connectionsContextLimit`, `connections` from local settings interface
- `query?` parameter from `getMessageOptions()` → revert to `async getMessageOptions(): Promise<...>`
- `query?` parameter from `buildSystemPromptWithWorkspace()` → revert to no-arg private
- Vault context injection line: `const vaultContext = await this.buildVaultContextBlock(query);`
- `vaultContext` property in the `SystemPromptOptions` object literal
- Entire `private async buildVaultContextBlock(query: string | undefined)` method (~45 lines)

Also revert the 2 call sites in `ChatView.ts` that pass `message`:
```typescript
// These 2 lines in ChatView.ts (approx lines 1108 and 1121):
await this.modelAgentManager.getMessageOptions(message)
// Revert to:
await this.modelAgentManager.getMessageOptions()
```

**Do NOT touch** `shouldCompactBeforeSending(conversationOrMessage: ConversationData | string, ...)` — this overload was added in upstream commit `c64e6502` (ingester merge by ProfSynapse), not our semantic work.

---

### 3i. `src/ui/chat/services/SystemPromptBuilder.ts`

Remove from `SystemPromptOptions`:
```typescript
vaultContext?: string | null;
```

Remove from `build()`:
```typescript
// 9. Semantic vault context
if (options.vaultContext) {
  sections.push(options.vaultContext);
}
```

---

### 3j. `src/agents/searchManager/searchManager.ts`

Remove `FindRelatedTool` from the import and remove the `registerLazyTool` block for `'findRelated'` (~10 lines).

---

### 3k. `src/agents/searchManager/tools/index.ts`

Remove:
```typescript
export * from './findRelated';
```

---

### 3l. `src/agents/taskManager/types.ts`

Remove these 2 lines only:
```typescript
addNoteLinks?: Array<{ notePath: string; linkType?: LinkType }>;
removeNoteLinks?: string[];
```

These were in the `UpdateTaskParams` interface, added by commit `d26afd67`.

---

### 3m. `src/agents/taskManager/taskManager.ts`

Revert the `updateTask` tool description (1 line): remove "and manage note links (addNoteLinks/removeNoteLinks)" from the description string.

Upstream description: `'Update task fields (title, description, status, priority, dueDate, assignee, tags) and manage DAG dependencies (addDependencies/removeDependencies). Dependency additions are validated for cycles. Requires a taskId (from createTask or listTasks).'`

Note: `TaskService.getNoteLinks()` — **keep it**. It is a pure data accessor with no semantic dependencies, called by `TaskBoardView` to read existing links. Removing it would require surgical edits to `TaskService.ts` and risks breaking the upstream `linkNote`/`unlinkNote` tooling.

---

### 3n. `styles.css`

Remove these CSS blocks by comment/class markers:

1. **`chat-semantic-panel-button` block** — added in `dcef4e1a`. The combined rule with `.chat-settings-button` must be split: keep `.chat-settings-button` rules, remove `.chat-semantic-panel-button` from the selector and remove the `.chat-semantic-panel-button.is-active` block entirely.

2. **Entire Semantic Panel section** — from the comment `/* Semantic Panel (Plan 05) */` through all `.semantic-panel-*`, `@keyframes semantic-spin`, and `.semantic-result-row-*` rules (~200 lines added in `dcef4e1a`)

3. **Connections tab chip list CSS** — added in commit `70b51fb1`. Remove blocks for: `.nexus-fm-chip-label`, `.nexus-fm-add-form`, `.nexus-fm-key-input`, `.nexus-fm-val-input`, `.nexus-fm-sep`, `.nexus-fm-confirm-btn`, `.nexus-fm-cancel-btn`

4. **EmbeddingsTab CSS** — added across commits `9185eaf4`, `bb0ee071`, and `12f8d9ce`. Remove blocks for all of the following:
   - From `9185eaf4`: `.nexus-embed-status-grid`, `.nexus-embed-status-label`, `.nexus-embed-status-value`, `.nexus-embed-download-progress`, `.nexus-embed-download-header`, `.nexus-embed-download-label`, `.nexus-embed-download-bar-track`, `.nexus-embed-download-bar-fill`, `.csr-redirect-note`
   - From `bb0ee071`: `.nexus-embed-index-progress`, `.nexus-embed-index-progress.is-hidden`, `.nexus-embed-index-header`, `.nexus-embed-index-label`, `.nexus-embed-download-progress.is-hidden`
   - From `12f8d9ce`: `.nexus-embed-index-controls`

   > **Do NOT remove** `.nexus-settings-section` and `.nexus-settings-desc` (also added in `9185eaf4`) — `DataTab.ts` uses both. Confirmed shared, not EmbeddingsTab-specific.

5. **Task note-links CSS** — added in commit `d26afd67`. Remove `.nexus-task-board-card-links` and `.nexus-task-board-card-link` blocks (~45 lines).

**Keep** `.chat-header-right` CSS block — flex container for settings button area (AgentStatusMenu depends on it).

---

### 3o. `src/settings/tabs/DefaultsTab.ts`

Commit `9185eaf4` replaced the upstream `enableEmbeddings` toggle in DefaultsTab with a redirect note (`csr-redirect-note`). The `enableEmbeddings` toggle controls MiniLM **conversation search** — an upstream feature unrelated to our semantic panel. It must be restored.

**Remove** the redirect paragraph (from `9185eaf4`):
```typescript
const redirectDesc = embeddingsContent.createEl('p', {
  cls: 'csr-redirect-note',
  text: 'Embedding settings have moved to the Embeddings tab — enable/disable, model selection, index controls, and download progress are all there.',
});
```

**Restore** the original upstream Embeddings toggle in its place:
```typescript
new Setting(embeddingsContent)
  .setName('Enable')
  .setDesc('Local AI for semantic search (~23MB download). Restart to apply.')
  .addToggle(toggle => {
    toggle
      .setValue(this.services.settings.settings.enableEmbeddings ?? true)
      .onChange(async (value) => {
        this.services.settings.settings.enableEmbeddings = value;
        await this.services.settings.saveSettings();
        new Notice(`Embeddings ${value ? 'enabled' : 'disabled'}. Restart Obsidian to apply.`);
      });
  });
```

**Keep** the Chat actions section (`defaultNewFileLocation` field) — added in commit `21c260f3`, unrelated to semantic panel.

---

## Step 4 — Verify `src/utils/connectorContent.ts`

Only change vs upstream is a build timestamp in the header comment. No edit needed — `npm run deploy` regenerates it.

---

## Step 5 — Build and Test

```bash
npm run build
```

Expected: clean TypeScript compile with no references to deleted files. Any TS errors point to remaining imports of deleted files — remove those imports.

```bash
npm run test
```

No semantic test files exist. Verify chat-related test counts unchanged.

---

## Step 6 — Schema Cleanup (v17 migration)

After restoring `SchemaMigrator.ts` to v11 baseline, **append one cleanup migration** to drop semantic tables from existing installs that ran v12–v16:

```typescript
{
  version: 12,
  description: 'Remove semantic panel tables (Plan 04/05 feature removed)',
  sql: [
    'DROP TABLE IF EXISTS semantic_feedback',
    'DROP TABLE IF EXISTS block_embedding_metadata',
    'DROP TABLE IF EXISTS block_embeddings',
    'DROP TABLE IF EXISTS embedding_config',
    // note_embeddings and embedding_metadata stay — upstream schema uses them
    // at float[384] for conversation/trace embeddings
  ]
}
```

Set `CURRENT_SCHEMA_VERSION = 12`.

---

## Summary — File Count

| Action | Count |
|---|---|
| Delete entirely (git rm) | 31 files (was 33 — 2 docs are untracked filesystem-only) |
| Delete entirely (filesystem only, untracked) | 2 files (plan-09, plan-10) |
| Restore from upstream (`git checkout origin/main`) | 16 files |
| Surgical edit | 15 files (added DefaultsTab) |

**New in this revision (git audit findings):**
- Step 3n CSS removal: expanded to enumerate 5 CSS groups including EmbeddingsTab classes, chip list classes, task note-link classes
- Step 3o (new): `DefaultsTab.ts` — restore `enableEmbeddings` toggle, remove `csr-redirect-note` redirect
- Docs deletion clarified: 8 tracked (`git rm`) vs 2 untracked (filesystem only)
- Added explicit keep-list for plan files that must NOT be deleted (plan-11, plan-12, plan-06, plan-01/02/03)

---

## Order of Operations

1. Delete all Step 1 files
2. `git checkout origin/main` for all Step 2 files
3. Surgical edits in Step 3 (any order — all independent)
4. Append v12 cleanup migration to restored `SchemaMigrator.ts` (Step 6)
5. `npm run build` — fix any TS errors
6. `npm run test`
7. Deploy and verify chat panel still works
