# Upstream Merge Plan: v5.6.1 → v5.6.5
**Date**: 2026-04-01
**Branch strategy**: Update `main` from upstream, then rebase `local-fixes` onto updated `main`

---

## What upstream changed

| Release | Key changes |
|---------|-------------|
| **5.6.2** | Vault ingestion architecture overhaul. Drag-drop removed from ChatView (~250 lines). New `VaultIngestionManager` handles right-click "Convert to Markdown" + optional auto-convert on file create. PDF.js loader fix (new `PdfJsLoader.ts` using legacy build). |
| **5.6.3** | DOCX, PPTX, XLSX ingestion. New extraction services. New npm packages (`mammoth`, `xlsx`). |
| **5.6.4** | `any`→`unknown` type migration across **539 files**. ESLint v8→v9 flat config (`eslint.config.mjs`, removes `.eslintrc.json`). Anthropic streaming fix: restores `index` field on tool call chunks for correct multi-tool accumulation. |
| **5.6.5** | Obsidian-releases bot lint compliance. 162 unnecessary `async` methods made sync. `app.fileManager.trashFile()` replaces `vault.delete()`. Sentence-case fixes in UI. `onload(): void` refactored (require-await rule). |

Upstream commits since our `main`:
```
7e7f6148 chore: bump version to 5.6.5
04b2f90c fix: resolve all obsidian-releases bot lint violations
ba0ccb22 chore: update ESLint config for obsidian-releases bot parity
63693572 chore: bump version to 5.6.4
5020b2b2 refactor: any→unknown type migration, ESLint v9 + obsidianmd linter
2f1c1763 chore: bump version to 5.6.3
ed1a33cd feat: DOCX, PPTX, XLSX ingestion support
68c3e7f0 chore: bump version to 5.6.2
```

---

## What local-fixes preserves (must not break)

31 commits on top of `main`, covering:
- **Embedding system** — EmbeddingRuntime (iframe/WebGPU/WASM), EmbeddingIndexCoordinator, EmbeddingExclusionService, EmbeddingPreprocessor, EmbeddingModelCatalog, NoteChunker, NoteEmbeddingService; EmbeddingWatcher **deleted** (replaced by EmbeddingIndexCoordinator)
- **Semantic panel** — SemanticPanelView, SemanticPanelNavigation, SemanticResultRow, SemanticFeedbackService, ConnectionsService, ConnectionsSettings (ConnectionsTab UI overhaul)
- **EmbeddingsTab** — new settings tab file
- **ConnectionsTab** — new settings tab file
- **SettingsView / SettingsRouter** — register both new tabs
- **SemanticPanelUIManager** — registered in PluginLifecycleManager
- **Schema v12–v16** — semantic embedding tables (vec_notes, vec_blocks, etc.)
- **findRelated tool** — new SearchManager tool + registration
- **FilePickerRenderer** — folder selection fix
- **ConversationList** — constructor arg order fixed; `component` made required; `!` assertions removed
- **BranchHeader** — simplify optional Component registration guard
- **IngestProgressBanner** — constructor requires Component; remove/clear drop manual `removeEventListener` calls
- **main.ts** — `getEmbeddingManager()` and `openSettings()` methods added
- **EmbeddingIframe** — comment clarifying why `addEventListener` is used without Component
- **Chat fixes** — MessageActionBar, EditorInsertService, CreateFileModal, semanticPanelButton in ChatLayoutBuilder header
- **PerplexityAdapter** — max_tokens fix + strip-tools fix
- **CostCalculator** — Google API key moved to `x-goog-api-key` header
- **HybridStorageAdapter** — JSONL file deletion on conversation delete
- **Nomic embed task prefix** — correct prefix in EmbeddingRuntime

---

## Complete conflict map

The rebase will surface conflicts in exactly these 34 files (intersection of changes on both sides):

### Group A — Substantive conflicts (require careful manual merge)

| File | Upstream change | Our change | Risk |
|------|----------------|------------|------|
| `src/ui/chat/ChatView.ts` | Removes all drag-drop ingest UI (~250 lines); type migration | Adds `semanticPanelButton` wiring; ConversationList constructor arg order | **HIGH** |
| `src/ui/chat/builders/ChatLayoutBuilder.ts` | Removes `ingestBannerContainer` + warning banner | Adds `semanticPanelButton` to interface and header | **HIGH** |
| `src/services/embeddings/EmbeddingManager.ts` | `initialize()` async→sync; `runBackgroundIndexing()` extracted | Comprehensive rewrite (adds Runtime, Coordinator, Exclusion, hfToken) | **HIGH** |
| `src/main.ts` | `async onload()` → `onload(): void + loadPlugin()`; `_timeoutMs` rename; indentation fixes | Adds `getEmbeddingManager()` and `openSettings()` methods | **MEDIUM** |
| `src/core/PluginLifecycleManager.ts` | Adds `VaultIngestionManager`; removes `UpdateManager`/`Notice`; type casts | Adds `SemanticPanelUIManager` | **MEDIUM** |
| `src/database/schema/SchemaMigrator.ts` | `any[]`→`unknown[]` in interface; adds `LegacyConversationMetadata` | Schema v11→v16; new embedding table migrations | **MEDIUM** |
| `src/settings/SettingsView.ts` | Type migration | Adds EmbeddingsTab + ConnectionsTab imports; registers new tabs; adds `embeddingManager` field | **MEDIUM** |
| `src/agents/ingestManager/ui/IngestProgressBanner.ts` | Type-narrows querySelector calls | Adds `Component` constructor param; drops manual `removeEventListener` | **MEDIUM** — see note below |
| `src/ui/chat/components/ConversationList.ts` | Type migration | Constructor arg order swap; `component` made required; removes `!` assertions | **LOW-MEDIUM** |

### Group B — Mechanical conflicts (our functional change + upstream type migration; accept upstream types, keep our logic)

| File | Our functional change |
|------|----------------------|
| `src/services/embeddings/EmbeddingIframe.ts` | Added comment about addEventListener usage |
| `src/services/embeddings/EmbeddingService.ts` | Embedding service changes |
| `src/services/embeddings/EmbeddingWatcher.ts` | **DELETED by us** — see special case below |
| `src/services/embeddings/NoteEmbeddingService.ts` | Note embedding changes |
| `src/services/llm/adapters/perplexity/PerplexityAdapter.ts` | max_tokens fix; strip-tools fix |
| `src/services/llm/adapters/CostCalculator.ts` | Google API key → `x-goog-api-key` header |
| `src/agents/searchManager/searchManager.ts` | FindRelated tool registration |
| `src/agents/contentManager/types.ts` | Type changes for replace/write tools |
| `src/components/workspace/FilePickerRenderer.ts` | Folder selection fix |
| `src/database/adapters/HybridStorageAdapter.ts` | JSONL delete on conversation delete |
| `src/database/migration/ConversationMigrator.ts` | Migration changes |
| `src/settings/tabs/DefaultsTab.ts` | Adds Chat actions section |
| `src/settings/SettingsRouter.ts` | Adds `'embeddings' \| 'connections'` to SettingsTab type |
| `src/types/plugin/PluginTypes.ts` | Adds SemanticPanelSettings + embedding fields |
| `src/ui/chat/components/AgentStatusMenu.ts` | UI changes |
| `src/ui/chat/components/BranchHeader.ts` | Simplifies optional Component guard |
| `src/ui/chat/components/ChatInput.ts` | Chat input changes |
| `src/ui/chat/components/MessageBubble.ts` | Message bubble changes |
| `src/ui/chat/components/ProgressiveToolAccordion.ts` | Tool accordion changes |
| `src/ui/chat/components/factories/ToolBubbleFactory.ts` | Factory changes |
| `src/ui/chat/components/suggesters/ContentEditableSuggester.ts` | Suggester changes |
| `src/ui/chat/services/ModelAgentManager.ts` | Adds connections fields to PluginWithSettings; adds `getEmbeddingManager` type |
| `src/ui/chat/services/SystemPromptBuilder.ts` | System prompt changes |

### styles.css — no conflict

Upstream makes zero changes to `styles.css` in 5.6.2–5.6.5. Our 688 lines of new CSS apply cleanly: chat header button group (`.chat-header-right`, `.chat-semantic-panel-button`), mobile touch targets, `message-display-container` flex fix, and all semantic panel / ConnectionsTab component styles.

No action needed — git will fast-forward our CSS changes without conflict.

---

### Group C — Trivial resolution

| File | Action |
|------|--------|
| `src/utils/connectorContent.ts` | `git checkout --theirs` — always a timestamp |
| `CLAUDE.md` | **Manual merge** — see note below |
| `package-lock.json` | `git checkout --theirs` — upstream adds mammoth/xlsx packages |

---

## Special cases

### EmbeddingWatcher.ts — deleted by us, modified by upstream

We deleted this file (replaced by EmbeddingIndexCoordinator). Upstream 5.6.4 modified it (whitespace/type migration). Git will flag this as: *"deleted by us, modified by them"*.

Resolution:
```bash
git rm src/services/embeddings/EmbeddingWatcher.ts
```
Keep our deletion. The file is replaced by EmbeddingIndexCoordinator in our architecture.

---

### IngestProgressBanner.ts — orphaned after merge

**Problem**: Our local-fixes changed `IngestProgressBanner` to require a `Component` arg (correct for registerDomEvent lifecycle). But:
- Upstream 5.6.2 removed IngestProgressBanner from `ChatView` (drag-drop gone)
- Upstream's `VaultIngestionManager` uses `Notice` — not IngestProgressBanner

**Result**: After the rebase, IngestProgressBanner exists with a changed constructor but is **called nowhere** in runtime code. Our ChatView changes that referenced it will be dropped (taken from upstream).

**Resolution**: Keep our constructor change (it's correct compliance work). The banner becomes temporarily dead code. Do NOT delete it — VaultIngestionManager may want it in a future pass, and the compliance fix is correct regardless. No additional action needed for the merge itself.

---

## Step-by-step merge procedure

### Step 1 — Update main from upstream
```bash
git checkout main
git merge upstream/main
git checkout local-fixes
```

### Step 2 — Rebase local-fixes onto updated main
```bash
git rebase main
```

When conflicts appear, resolve per-file as described below, then:
```bash
git add <resolved-file>
git rebase --continue
```

---

## Conflict resolution guide

### Group C files

```bash
# During rebase: --ours = the base branch (main/upstream), --theirs = local-fixes commits
git checkout --ours src/utils/connectorContent.ts
git checkout --theirs package-lock.json
git add src/utils/connectorContent.ts package-lock.json
```

**`CLAUDE.md`** — manual merge required. Our local-fixes adds milestone entries (Chat Action Buttons, embedding system work) absent from upstream. Accept upstream's 5.6.2–5.6.5 milestone section AND keep our embedding/semantic panel entries in the March 2026 milestones section.

---

## Group A — Concrete implementation steps

### 1. `src/ui/chat/ChatView.ts` — HIGH

**What happened**: Upstream (5.6.2) removed all drag-drop ingest UI (~250 lines). Our commits added `semanticPanelButton` wiring, the `openSemanticPanel()` + `addSemanticContext()` methods, and fixed the `ConversationList` constructor call. During the rebase these changes are spread across multiple commits.

**Target end-state for each conflict point:**

**a) Imports block** — take upstream's version (no ingest imports). The merged imports block must contain NO references to `IngestEventBinder`, `IngestProgressBanner`, `IngestConfirmModal`, `IngestProgress`, `IngestToolResult`, `ACCEPTED_AUDIO_EXTENSIONS`, `getIngestCapabilityOptions`, or `IngestCapabilityOptions`. Our import additions (none in this file — we don't add new imports) survive automatically.

**b) Class fields** — the merged class must NOT contain:
```typescript
private ingestEventBinder: IngestEventBinder | null = null;
private ingestProgressBanner: IngestProgressBanner | null = null;
```

**c) `initializeComponents()` — ConversationList constructor call** — use OUR arg order (Component 4th, `onConversationRename` 5th):
```typescript
this.conversationList = new ConversationList(
  this.layoutElements.conversationListContainer,
  (conversation) => this.conversationManager.selectConversation(conversation),
  (conversationId) => this.conversationManager.deleteConversation(conversationId),
  this,                          // Component for registerDomEvent — 4th arg (required)
  (conversationId, newTitle) => this.conversationManager.renameConversation(conversationId, newTitle)
);
```
Do NOT use upstream's order which still has `onConversationRename` 4th and `this` 5th.

**d) `initializeEventListeners()` or equivalent setup** — must contain:
```typescript
this.registerDomEvent(
  this.layoutElements.semanticPanelButton,
  'click',
  () => void this.openSemanticPanel()
);
```

**e) `openSemanticPanel()` and `addSemanticContext()` methods** — must survive intact:
```typescript
private async openSemanticPanel(): Promise<void> {
  const plugin = getNexusPlugin<NexusPlugin>(this.app);
  const lifecycleManager = (plugin as unknown as { lifecycleManager?: { getSemanticPanelUIManager?(): { setSendToChatCallback(fn: (p: unknown) => void): void; openSemanticPanel(): Promise<void> } } }).lifecycleManager;
  if (!lifecycleManager) return;
  const uiManager = lifecycleManager.getSemanticPanelUIManager?.();
  if (!uiManager) return;
  uiManager.setSendToChatCallback((payload) => this.addSemanticContext(payload as import('../../ui/semanticPanel/SemanticPanelView').SemanticContextPayload));
  await uiManager.openSemanticPanel();
}

addSemanticContext(payload: import('../../ui/semanticPanel/SemanticPanelView').SemanticContextPayload): void {
  // [body unchanged from local-fixes]
}
```

**f) Cleanup / `onClose()` or `destroy()`** — remove these two lines if they survived from our branch:
```typescript
this.ingestEventBinder?.destroy();   // remove
this.ingestProgressBanner?.destroy(); // remove
```

**Verification**: `grep -n "ingest\|IngestProgress\|ingestBanner" src/ui/chat/ChatView.ts` should return zero results.

---

### 2. `src/ui/chat/builders/ChatLayoutBuilder.ts` — HIGH

**Target end-state:**

**a) `ChatLayoutElements` interface** — must contain `semanticPanelButton`, must NOT contain `ingestBannerContainer`:
```typescript
export interface ChatLayoutElements {
  messageContainer: HTMLElement;
  inputContainer: HTMLElement;
  contextContainer: HTMLElement;
  conversationListContainer: HTMLElement;
  newChatButton: HTMLElement;
  settingsButton: HTMLElement;
  semanticPanelButton: HTMLElement;   // ours — keep
  chatTitle: HTMLElement;
  hamburgerButton: HTMLElement;
  backdrop: HTMLElement;
  sidebarContainer: HTMLElement;
  loadingOverlay: HTMLElement;
  branchHeaderContainer: HTMLElement;
  // NO ingestBannerContainer here
}
```

**b) `buildLayout()` method** — must NOT create `ingestBannerContainer`, must NOT call `createWarningBanner()`. The header destructure must include `semanticPanelButton`:
```typescript
const { chatTitle, hamburgerButton, settingsButton, semanticPanelButton } = this.createHeader(mainContainer);
```
The return object must include `semanticPanelButton` and must NOT include `ingestBannerContainer`.

**c) `createHeader()` private method** — must create `chat-header-right` wrapper and the semantic panel button:
```typescript
private static createHeader(container: HTMLElement): {
  chatTitle: HTMLElement;
  hamburgerButton: HTMLElement;
  settingsButton: HTMLElement;
  semanticPanelButton: HTMLElement;
} {
  const chatHeader = container.createDiv('chat-header');
  const hamburgerButton = chatHeader.createEl('button', { cls: 'chat-hamburger-button' });
  setIcon(hamburgerButton, 'menu');
  hamburgerButton.setAttribute('aria-label', 'Toggle conversation list');

  const chatTitle = chatHeader.createDiv('chat-title');
  chatTitle.textContent = 'Nexus Chat';

  const headerRight = chatHeader.createDiv('chat-header-right');

  const semanticPanelButton = headerRight.createEl('button', { cls: 'chat-semantic-panel-button' });
  setIcon(semanticPanelButton, 'network');
  semanticPanelButton.setAttribute('aria-label', 'Open Semantic Panel');

  const settingsButton = headerRight.createEl('button', { cls: 'chat-settings-button' });
  setIcon(settingsButton, 'settings');
  settingsButton.setAttribute('aria-label', 'Chat settings');

  return { chatTitle, hamburgerButton, settingsButton, semanticPanelButton };
}
```

**d) Loading overlay** — accept upstream's lint fixes: no `animate1`/`animate2` variable assignments, warning text reads `'This chat is in beta.'` (not the old experimental text). No `createWarningBanner()` method exists.

---

### 3. `src/services/embeddings/EmbeddingManager.ts` — HIGH

**Key decision**: Our `initialize()` method genuinely awaits `readActiveModelFromDb()` at its start. It cannot be made sync without losing that read. Therefore we **keep** `async initialize(): Promise<void>` — do NOT apply upstream's void signature to our version.

The corresponding call in `PluginLifecycleManager.initializeEmbeddingsWhenReady()` must also keep `await` (see PluginLifecycleManager steps below).

**Target end-state** — our file is authoritative. Verify after the rebase:

- Signature: `async initialize(): Promise<void>` — confirmed correct, do not change
- Constructor params: `(app, plugin, db, enableEmbeddings = true, messageRepository?, huggingFaceToken?, getExclusionPatterns?)` — keep all seven
- Class fields include: `runtime`, `coordinator`, `hfToken`, `getExclusionPatterns` — all present
- `EmbeddingWatcher` is NOT imported (we deleted it) — confirmed
- `isInitialized: boolean = false` — change to `isInitialized = false` (upstream lint: no redundant type annotation)

The only upstream change to adopt in this file is cosmetic: `private isInitialized = false` (drop `: boolean`).

---

### 4. `src/main.ts` — MEDIUM

**Target end-state** — upstream's structure + our two appended methods.

**a) `getService()` signature** — accept upstream's rename:
```typescript
public async getService<T>(name: string, _timeoutMs?: number): Promise<T | null> {
```

**b) `onload()` / `onunload()`** — take upstream's void wrappers verbatim:
```typescript
onload(): void {
  void this.loadPlugin();
}

private async loadPlugin(): Promise<void> {
  // [full existing body, unchanged]
}

onunload(): void {
  void this.unloadPlugin();
}

private async unloadPlugin(): Promise<void> {
  // [full existing body, unchanged]
}
```

**c) Our two methods** — must appear after `getServiceContainer()`:
```typescript
public getEmbeddingManager() {
  return this.lifecycleManager?.getEmbeddingManager() ?? null;
}

public openSettings(_tab?: string): void {
  const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
  if (!setting) return;
  setting.open();
  setting.openTabById(this.manifest.id);
}
```

The class ends with `openSettings()` — no further content.

---

### 5. `src/core/PluginLifecycleManager.ts` — MEDIUM

**Target end-state** — union of both sides, with our `await` preserved.

**a) Imports** — must contain both (in this order, alphabetically by module):
```typescript
import { SemanticPanelUIManager } from './ui/SemanticPanelUIManager';  // ours
import { VaultIngestionManager } from './ingest/VaultIngestionManager'; // upstream
```
Do NOT import `UpdateManager` or `Notice` (upstream removed them).

**b) Class fields** — must contain both, in field declaration order (upstream fields first to minimize diff):
```typescript
private isInitialized = false;         // upstream: drop `: boolean`
// ...
private taskBoardUIManager: TaskBoardUIManager;
private semanticPanelUIManager: SemanticPanelUIManager;   // ours
private backgroundProcessor: BackgroundProcessor;
// ...
private vaultIngestionManager: VaultIngestionManager;      // upstream
private embeddingManager: EmbeddingManager | null = null;
```

**c) Constructor** — accept upstream's type casts for `serviceContext` and `commandManager`, and add `vaultIngestionManager` block. Keep `semanticPanelUIManager` block. Order: taskBoardUIManager → **semanticPanelUIManager** → backgroundProcessor → settingsTabManager → inlineEditCommandManager → **vaultIngestionManager**:
```typescript
this.taskBoardUIManager = new TaskBoardUIManager({ plugin: config.plugin, app: config.app });

this.semanticPanelUIManager = new SemanticPanelUIManager({ plugin: config.plugin, app: config.app });

// [backgroundProcessor, settingsTabManager, inlineEditCommandManager unchanged]

this.vaultIngestionManager = new VaultIngestionManager({
  plugin: config.plugin,
  app: config.app,
  getService: (name, timeoutMs) => this.serviceRegistrar.getService(name, timeoutMs)
});
```

**d) `initialize()` — registration phase** — must call both UI managers and the vault ingestion manager:
```typescript
await this.chatUIManager.registerViewEarly();
await this.taskBoardUIManager.registerViewEarly();
await this.semanticPanelUIManager.registerViewEarly();   // ours
```
And later in the background init phase:
```typescript
await this.chatUIManager.registerChatUI();
await this.taskBoardUIManager.registerTaskBoardUI();
await this.semanticPanelUIManager.registerSemanticPanelUI();  // ours
this.settingsTabManager.initializeSettingsTab();               // upstream: no await (lint)
// ...
this.vaultIngestionManager.register();                        // upstream: fire-and-forget
```

**e) `initializeEmbeddingsWhenReady()`** — keep `await` on initialize:
```typescript
await this.embeddingManager.initialize();   // keep await — our version is genuinely async
```

**f) Accessor methods** — both must survive:
```typescript
getEmbeddingManager(): EmbeddingManager | null {
  return this.embeddingManager;
}

getSemanticPanelUIManager(): SemanticPanelUIManager {
  return this.semanticPanelUIManager;
}
```

---

### 6. `src/database/schema/SchemaMigrator.ts` — MEDIUM

Our file is authoritative. Apply three upstream changes:

**a) `MigratableDatabase` interface** — use `unknown[]` types:
```typescript
export interface MigratableDatabase {
  exec(sql: string): { values: unknown[][] }[];
  run(sql: string, params?: unknown[]): void;
}
```

**b) `CURRENT_SCHEMA_VERSION`** — keep ours:
```typescript
export const CURRENT_SCHEMA_VERSION = 16;
```

**c) `LegacyConversationMetadata` interface** — add upstream's interface after the `Database` alias line:
```typescript
type Database = MigratableDatabase;

interface LegacyConversationMetadata {
  chatSettings?: {
    workspaceId?: string;
    sessionId?: string;
  };
  workspaceId?: string;
  sessionId?: string;
  workflowId?: string;
  runTrigger?: string;
  scheduledFor?: number;
  runKey?: string;
}
```

All our migration definitions (v12–v16) and version number remain untouched.

---

### 7. `src/settings/SettingsView.ts` — MEDIUM

Our file is the functional authority for the new tabs. Accept upstream's type narrowings throughout. Verify these survive after each rebase step:

**a) Imports** — keep our additions:
```typescript
import { EmbeddingsTab } from './tabs/EmbeddingsTab';
import { ConnectionsTab } from './tabs/ConnectionsTab';
import type { EmbeddingManager } from '../services/embeddings/EmbeddingManager';
```

**b) Class fields** — keep our tab instances:
```typescript
private embeddingsTab: EmbeddingsTab | undefined;
private connectionsTab: ConnectionsTab | undefined;
```

**c) Tab registration in `display()`** — keep our two tab configs in the tabs array:
```typescript
{ key: 'embeddings', label: 'Embeddings' },
{ key: 'connections', label: 'Connections' },
```

**d) Switch/case routing** — keep our render cases:
```typescript
case 'embeddings':
  this.renderEmbeddingsTab(pane);
  break;
case 'connections':
  this.renderConnectionsTab(pane);
  break;
```

**e) Render methods** — keep our two private render methods (`renderEmbeddingsTab`, `renderConnectionsTab`) and their destroy calls in `hide()`.

---

### 8. `src/agents/ingestManager/ui/IngestProgressBanner.ts` — LOW-MEDIUM

Our version is the base. Apply upstream's two querySelector type-narrowing changes:

**a)** Change:
```typescript
const barFill = bannerEl.querySelector('.nexus-ingest-progress-bar-fill') as HTMLElement | null;
```
To:
```typescript
const barFill = bannerEl.querySelector<HTMLElement>('.nexus-ingest-progress-bar-fill');
```

**b)** Change:
```typescript
const dismissBtn = bannerEl.querySelector('.nexus-ingest-progress-dismiss') as HTMLElement | null;
```
To:
```typescript
const dismissBtn = bannerEl.querySelector('.nexus-ingest-progress-dismiss');
```
(upstream removes the `as HTMLElement` cast from dismissBtn — it's used only with `.removeClass`/`.addClass` which exist on `Element`.)

Everything else (Component constructor param, no-manual-removeEventListener in `remove()` and `clear()`) stays as our version.

---

### 9. `src/ui/chat/components/ConversationList.ts` — LOW-MEDIUM

**Important**: Upstream added a new pending-delete UX feature (`pendingDeleteConversationId`, `pendingDeleteTimer`, `requestDeleteConversation()`). We must incorporate both our constructor refactor AND their new feature.

**Target end-state:**

**a) Class fields** — add upstream's two new fields:
```typescript
private conversations: ConversationData[] = [];
private activeConversationId: string | null = null;
private pendingDeleteConversationId: string | null = null;   // upstream — add
private pendingDeleteTimer: number | null = null;             // upstream — add
```

**b) Constructor** — use OUR arg order (Component required 4th, onRename optional 5th):
```typescript
constructor(
  private container: HTMLElement,
  private onConversationSelect: (conversation: ConversationData) => void,
  private onConversationDelete: (conversationId: string) => void,
  private component: Component,                                           // ours: required, 4th
  private onConversationRename?: (conversationId: string, newTitle: string) => void  // 5th
) {
  this.render();
}
```

**c) Upstream's `requestDeleteConversation()` method** — add it. It implements a two-click delete pattern (first click arms the delete, second click within a timer confirms). Include this method verbatim from upstream's version at the end of the class.

**d) Delete button wiring in `render()`** — upstream changed the delete button to call `requestDeleteConversation` rather than calling `onConversationDelete` directly. Accept upstream's version of this wiring.

**e) `this.component.registerDomEvent(...)` calls** — keep our removal of the `!` assertion (component is required, not optional). If upstream uses `this.component?.registerDomEvent(...)` with optional chaining, that is fine to keep (it compiles without error on a required field).

---

### Group B — mechanical conflicts

For all 21 Group B files, the resolution rule is: **accept upstream's type narrowings, keep our functional changes**. No line-by-line pre-planning; resolve by inspection during the rebase. Three files warrant extra care:

**`src/services/llm/adapters/perplexity/PerplexityAdapter.ts`** — Our max_tokens and strip-tools fixes are in `generateStreamAsync()` and `generateWithChatCompletions()`. After resolving, change `const requestBody: any = {` → `const requestBody = {` to satisfy the new lint rule.

**`src/agents/searchManager/searchManager.ts`** — Accept all upstream structural changes (noop helpers, `_enableVectorModes` rename, sync `updateSettings()`). Ensure `FindRelatedTool` appears in the import destructure from `'./tools'` and the `registerLazyTool({ slug: 'findRelated', ... })` block is present in the constructor.

**`src/ui/chat/services/ModelAgentManager.ts`** — Our additions to `PluginWithSettings` (`connectionsAutoInjectContext`, `connectionsContextLimit`, `connections`, `getEmbeddingManager`) are in the interface declaration near the top. Accept upstream's `any`→`unknown` changes throughout the method bodies; verify our interface fields survive.

---

## Post-rebase checklist

```bash
# 1. Install new packages from 5.6.3 (mammoth, xlsx)
npm install

# 2. Lint FIRST — upstream 5.6.4 added "npm run lint &&" to the build script,
#    so npm run build now runs lint internally. Build will fail on any lint violation.
#    Fix all violations in our new files before proceeding.
npm run lint

# 3. Full production build (must pass clean)
npm run build

# 4. Tests
npm run test
```

### Expected lint violations in our new files

Our new files (EmbeddingsTab.ts, EmbeddingRuntime.ts, EmbeddingIndexCoordinator.ts, SemanticPanelView.ts, ConnectionsTab.ts, etc.) were written before the `any`→`unknown` migration. Expect ~10–20 violations to fix:

```typescript
// Common patterns to fix:
} catch (error: any) {                              // → } catch (error: unknown) {
(result: any) =>                                    // → (result: unknown) =>
const data = JSON.parse(text) as any               // → typed cast or unknown
const requestBody: any = {                          // → drop any, let TS infer
```

Also watch for:
- `async` on methods that don't `await` (require-await rule — remove `async`)
- Sentence case violations in UI strings added by our tabs
- `vault.delete()` calls if any — replace with `app.fileManager.trashFile()`

### Functional verification in Obsidian

- [ ] Semantic panel opens from chat header button
- [ ] EmbeddingsTab visible in Settings; model controls work
- [ ] Embedding indexing starts on startup; mutual exclusion with manual rebuild works
- [ ] ConnectionsTab filter chips, frontmatter picker, exclusion patterns work
- [ ] Right-click "Convert to Markdown" on PDF/DOCX/PPTX/XLSX in file explorer (new VaultIngestionManager)
- [ ] Auto-ingestion toggle in Settings → Defaults → Ingestion works
- [ ] FilePickerRenderer shows folder picker (our fix)
- [ ] Chat action buttons (insert, append, create-file) still work
- [ ] No drag-drop ingest in ChatView (correctly removed by upstream)
- [ ] Nomic embed task prefix is correct (our EmbeddingRuntime fix)
- [ ] Conversation delete removes JSONL file (our HybridStorageAdapter fix)
- [ ] Perplexity max_tokens defaults correctly (our PerplexityAdapter fix)
- [ ] Multi-tool Anthropic responses accumulate correctly (upstream streaming fix)
- [ ] findRelated tool available via MCP getTools

---

## New upstream capabilities (no action required, just awareness)

### VaultIngestionManager
- Right-click any supported file in Obsidian's file tree → "Convert to Markdown"
- `autoIngestion?: boolean` setting: automatically converts newly-added supported files
- Uses `Notice` for progress feedback (not IngestProgressBanner)
- Wired into PluginLifecycleManager via `vaultIngestionManager.register()`

### DOCX / PPTX / XLSX extraction
- `DocxExtractionService` (mammoth), `PptxExtractionService` (zip+XML), `SpreadsheetExtractionService` (xlsx)
- Output: Markdown note alongside original file
- Triggered via VaultIngestionManager

### Anthropic streaming fix (5.6.4)
- `index` field restored on tool call delta chunks in `SSEStreamProcessor`
- Fixes multi-tool responses where calls accumulated into wrong slots
- Applies cleanly; no interaction with our changes

### ESLint obsidianmd plugin (5.6.4 / 5.6.5)
- 27 rules from the official Obsidian team
- Key enforced rules: no innerHTML with dynamic content, registerDomEvent required, no inline styles, sentence-case UI text, no deprecated vault.delete(), no unnecessary async
- Our new files will need a pass to comply (see lint checklist above)
