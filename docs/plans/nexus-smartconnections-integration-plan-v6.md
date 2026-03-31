# Nexus × Smart Connections — Integration Plan v6

> **Revision notes (v6):** Full source audit against Nexus `local-fixes` branch and SC repo
> as of 2026-03-31. Every file path, class name, method signature, and schema reference
> has been verified against real source code. Large portions of v5 were describing work
> that Nexus has already done; this plan corrects the record, removes duplicate work,
> and provides exact hooks for the remaining net-new work.

---

## 0. Audit Summary: What v5 Got Wrong

| v5 Claim | Reality |
|---|---|
| "EmbeddingEngine is a thin façade over EmbeddingIframe" | Partially true but `EmbeddingRuntime` (new file) is now the primary model-aware runtime. `EmbeddingEngine` is legacy (used only for traces/conversations). |
| "EmbeddingIframe hardcodes MODEL_ID at construction time" | `EmbeddingIframe` (legacy) does. `EmbeddingRuntime` is fully parameterised with model ID and pooling from `EmbeddingModelCatalog`. |
| "No adapter abstraction exists" | `EmbeddingRuntime` + `EmbeddingPreprocessor` + `EmbeddingModelCatalog` already implement the multi-model local adapter. No `IEmbeddingAdapter`/`LocalTransformersAdapter`/`EmbeddingAdapterRegistry` needs to be built. |
| "LocalModelConfig interface is new work" | `EmbeddingModelEntry` in `EmbeddingModelCatalog.ts` already fills this role with identical fields under different names. |
| "Model catalog: 7 models" | Catalog has 3 models. Adding models is possible but orthogonal to the connections panel. |
| "NoteEmbeddingService has no folder/pattern exclusion" | `EmbeddingExclusionService.ts` already exists and is wired into `EmbeddingIndexCoordinator`. It handles hidden paths, Obsidian excluded files, and user patterns. |
| "VaultIndexer.ts is new work" | `EmbeddingIndexCoordinator.ts` already does everything VaultIndexer was meant to do: startup reconciliation (`reconcileIndex()`), create/modify/delete/rename handlers, `refreshAll()`, `rebuildAll()`. Phase 4 reduces to wiring exclusion patterns from settings — not building a new file. |
| "Phase 1 (adapter abstraction) is the critical path" | Phase 1 is already done. The real work is Phase 2 (connections panel) and wiring exclusion patterns. |
| "embedding_config table is new work" | Already in schema v13 with keys: `activeModel`, `activeDimension`, `blockIndexingEnabled`, `blockIndexStale`. |
| "`semantic_feedback` table is new work" | Already in schema v13 (`state IN ('pinned', 'hidden')`, handled by `SemanticFeedbackService.ts`). |
| "ConnectionsItemView / ConnectionsLookupItemView: strip SmartEnv and port to TS" | SC's `ConnectionsItemView` inherits from `SmartItemView` (obsidian-smart-env) and calls `this.env.smart_sources`, `env.smart_components.render_component()`, `env.connections_lists.new_item()`. The coupling is total. Porting requires reimplementing the entire render/data pipeline, not just removing imports. |
| "No semantic panel exists yet" | `SemanticPanelView.ts`, `SemanticPanelUIManager.ts`, `SemanticPanelNavigation.ts`, `SemanticResultRow.ts`, `SemanticFeedbackService.ts` all exist in `src/ui/semanticPanel/`. The panel is browse + search modes with block/note toggles, settings popover, and feedback (pin/hide) already implemented. |
| "`connections_view_location` controls dock side" | The existing `SemanticPanelView` opens via `SemanticPanelNavigation.openSemanticPanelView()`. Dock side is not yet user-configurable but the view type `nexus-semantic-panel` is registered in `src/constants/branding.ts`. |
| "Phase 5 target file: SessionContextManager.ts" | Chat context injection is already partially present via `SemanticContextPayload` and `onSendToChat` callback in `SemanticPanelView`. The MCP-side system prompt injection is a different surface. |

---

## 1. Accurate Architectural Baseline

### 1.1 What Nexus already has (do NOT rebuild)

| Component | File | Status |
|---|---|---|
| Multi-model local embedding runtime | `EmbeddingRuntime.ts` | Done — model-aware, progress reporting, HF auth, local proxy |
| Model catalog | `EmbeddingModelCatalog.ts` | Done — 3 models (MiniLM-384, BGE-Small-384, Nomic-768) |
| Document/query prefix preprocessing | `EmbeddingPreprocessor.ts` | Done |
| Note + block embedding persistence | `NoteEmbeddingService.ts` | Done — `embedNote`, `embedNoteBlocks`, `findSimilarNotes`, `findSimilarBlocks`, `semanticSearchNotes`, `semanticSearchBlocks`, `recreateEmbeddingTables`, `setConfigValue` |
| Vault event watcher (legacy, 10s debounce) | `EmbeddingWatcher.ts` | Superseded by `EmbeddingIndexCoordinator` — both running in parallel, creating duplicate work (see §4b) |
| Full vault lifecycle coordinator | `EmbeddingIndexCoordinator.ts` | Done — `start()`, `reconcileIndex()`, `rebuildAll()`, `refreshAll()`, create/modify/delete/rename dispatch |
| Exclusion service | `EmbeddingExclusionService.ts` | Done — hidden paths, Obsidian excluded list, user patterns via getter. **TODO: getter is hardwired to `() => []`** |
| Embedding manager (top-level init) | `EmbeddingManager.ts` | Done — lazy init, model switch, download progress, `switchModel()` |
| Semantic panel view | `src/ui/semanticPanel/SemanticPanelView.ts` | Done — browse + search, notes/blocks toggle, settings popover |
| Semantic panel UI wiring | `src/core/ui/SemanticPanelUIManager.ts` | Done — view type registered, commands added |
| Feedback (pin/hide) | `src/ui/semanticPanel/SemanticFeedbackService.ts` | Done — `semantic_feedback` table in schema v13 |
| Settings tab for embeddings | `src/settings/tabs/EmbeddingsTab.ts` | Done — enable toggle, HF token, model list, block indexing, maintenance |
| DB schema | `src/database/schema/schema.ts` v13 | Done — `note_embeddings`, `embedding_metadata`, `block_embeddings`, `block_embedding_metadata`, `embedding_config`, `semantic_feedback` |
| Settings type | `src/types/plugin/PluginTypes.ts` | Done — `MCPSettings.enableEmbeddings`, `huggingFaceToken`, `semanticPanel: Partial<SemanticPanelSettings>` |

### 1.2 What does NOT yet exist

| Component | Needed for |
|---|---|
| Exclusion patterns wired from settings into `EmbeddingExclusionService` | Tier 1 filtering |
| `ConnectionsSettings` fields on `MCPSettings` | Tier 2 result filtering |
| Tier 2 filter application in `SemanticPanelView` | Correct panel results |
| `connections_view_location` setting (left/right dock) | Panel UX |
| Connections sub-tab in `SettingsView` settings tab | User configuration |
| MCP system prompt vault context injection | Phase 5 |
| `EmbeddingWatcher` deduplication with `EmbeddingIndexCoordinator` | Correctness |

---

## 2. Two-Tier Exclusion Model (Corrected)

The model is correct in v5. The implementation mapping is now accurate.

### Tier 1 — Ingestion exclusions

Already enforced by `EmbeddingExclusionService.shouldIndex()`. The current getter `() => []` in `EmbeddingManager.ts:99` is the only stub that needs connecting to settings.

```typescript
// EmbeddingManager.ts line 97-103 — BEFORE (stub)
const exclusions = new EmbeddingExclusionService(
  this.app,
  () => [] // TODO: wire user-defined exclusion patterns from settings
);

// AFTER: wire from MCPSettings
const exclusions = new EmbeddingExclusionService(
  this.app,
  () => (this.getExclusionPatterns?.() ?? [])
);
```

`EmbeddingExclusionService.matchesAnyPattern()` already handles glob-style patterns with `*` and folder-prefix patterns ending with `/`. **No micromatch needed.** The existing implementation is sufficient for the v5 use cases (`Templates/**`, folder prefixes). Only if the plan requires full double-star glob matching would micromatch add value — and no such requirement exists.

#### Tier 1 settings keys added to `MCPSettings`

```typescript
// Additions to MCPSettings (src/types/plugin/PluginTypes.ts)
indexingExcludedPatterns?: string[];   // one per array entry; stored as settings
```

A single `indexingExcludedPatterns` array replaces v5's split `indexing_excluded_folders` + `indexing_excluded_patterns` because `EmbeddingExclusionService.matchesAnyPattern()` already handles both folder-prefix and wildcard forms in one pass.

**Setting a change** that widens exclusion patterns: `EmbeddingIndexCoordinator.reconcileIndex()` already removes stale rows when `shouldIndex()` returns false. The caller just needs to invoke `reconcileIndex()` after settings change.

### Tier 2 — Results filters (panel-side, no re-index)

Applied inside `SemanticPanelView` before rendering results. The existing panel's only filters are `resultCount` and `minScore`. Inlink/outlink and path-fragment filters do not yet exist.

---

## 3. Verified Existing Method Signatures

All callers must use these exact signatures:

```typescript
// NoteEmbeddingService
findSimilarNotes(notePath: string, limit?: number, minScore?: number): Promise<SimilarNote[]>
findSimilarBlocks(notePath: string, limit?: number, minScore?: number): Promise<SimilarBlock[]>
semanticSearchNotes(query: string, limit?: number, minScore?: number): Promise<SimilarNote[]>
semanticSearchBlocks(query: string, limit?: number, minScore?: number): Promise<SimilarBlock[]>

// EmbeddingIndexCoordinator
start(): Promise<void>                  // registers vault events + reconcileIndex()
reconcileIndex(): Promise<void>         // startup reconciliation
refreshAll(): Promise<void>             // re-embed all (hash-skips unchanged)
rebuildAll(): Promise<void>             // drop + rebuild (emits rebuild-start/complete)

// EmbeddingManager
switchModel(modelId: string, dimensions: number): Promise<void>
getCoordinator(): EmbeddingIndexCoordinator | null
getService(): EmbeddingService | null

// EmbeddingService
getNoteEmbeddingService(): NoteEmbeddingService

// SemanticPanelView constructor
constructor(leaf: WorkspaceLeaf, plugin: NexusPlugin, onSendToChat: ((payload: SemanticContextPayload) => void) | null)
```

Inlink/outlink lookup uses Obsidian API directly:
```typescript
// Backlinks (notes linking TO current note)
app.metadataCache.getBacklinksForFile(file: TFile): Record<string, LinkCache[]>

// Outlinks (notes current note links TO)
app.metadataCache.getFileCache(file: TFile)?.links  // LinkCache[]
```

---

## 4. SC View Integration Analysis (Why Direct Porting Is Not Viable)

v5 proposed porting `ConnectionsItemView` and `ConnectionsLookupItemView` by "stripping SmartPlugin/SmartEnv imports". Source analysis shows this is insufficient.

### 4.1 SC view coupling depth

`ConnectionsItemView` extends `SmartItemView` (from `obsidian-smart-env`) and calls:
- `this.env.smart_sources.get(activePath)` — SC's source collection, no Nexus equivalent
- `this.env.smart_components.render_component('connections_view_v3', ...)` — SC's component renderer
- `this.env.connections_lists.new_item(connections_item)` — SC's ConnectionsLists collection
- `this.env.events.on/emit(...)` — SC's event bus

`connections_view_v3.js` further calls:
- `env.connections_lists.settings` — SC settings object
- `env.smart_contexts.new_context()` — Smart Context integration
- `StoryModal.open(...)` — obsidian-smart-env modal
- `this.get_icon_html(...)`, `this.create_doc_fragment(...)`, `this.apply_style_sheet(...)` — SmartEnv component renderer methods

`ConnectionsLookupItemView` is a thin stub over `LookupItemView` from `smart-lookup-obsidian` — a separate npm package not in this workspace.

**Conclusion:** The SC view layer cannot be ported without pulling in the full SmartEnv infrastructure. This is a completely different architecture from Nexus's `ItemView`-based `SemanticPanelView`.

### 4.2 The correct approach

Nexus already has a working panel (`SemanticPanelView`) that serves the same role. The right plan is to **extend the existing panel** with SC-sourced filter settings, not to port SC views. This is:
- Simpler (no foreign framework dependency)
- Already integrated with `NoteEmbeddingService` and `SemanticFeedbackService`
- Already registered via `SemanticPanelUIManager`

The shim interface below describes what the existing panel needs from a new `ConnectionsService`.

---

## 5. SC View Shim — What the Existing Panel Needs

The existing `SemanticPanelView` already calls `noteEmbeddingService.findSimilarNotes()` and `semanticSearchNotes()`. Adding Tier 2 filter support requires a thin service layer:

```typescript
/**
 * File: src/ui/semanticPanel/ConnectionsService.ts
 *
 * Thin wrapper over NoteEmbeddingService that applies Tier 2 result filters
 * sourced from ConnectionsSettings in MCPSettings. This is the only net-new
 * service class needed — it does not replicate SC's SmartEnv infrastructure.
 */

import type { App } from 'obsidian';
import type { NoteEmbeddingService, SimilarNote, SimilarBlock } from '../../services/embeddings/NoteEmbeddingService';
import type { ConnectionsSettings } from './ConnectionsSettings';

export interface ConnectionsOptions {
  limit?: number;
  minScore?: number;
}

export class ConnectionsService {
  constructor(
    private app: App,
    private noteEmbeddingService: NoteEmbeddingService,
    private getSettings: () => ConnectionsSettings,
  ) {}

  /**
   * Get filtered note connections for the active file.
   * Applies Tier 2 path-fragment, frontmatter, and link filters.
   */
  async getConnectionsForFile(
    notePath: string,
    opts: ConnectionsOptions = {},
  ): Promise<SimilarNote[]> {
    const settings = this.getSettings();
    const limit = opts.limit ?? settings.results_limit;
    const raw = await this.noteEmbeddingService.findSimilarNotes(notePath, limit * 2, opts.minScore ?? 0);
    return this.applyTier2Filters(raw.map(r => ({ ...r, isBlock: false })), notePath, settings)
      .slice(0, limit) as SimilarNote[];
  }

  /**
   * Get filtered block connections for the active file.
   */
  async getBlockConnectionsForFile(
    notePath: string,
    opts: ConnectionsOptions = {},
  ): Promise<SimilarBlock[]> {
    const settings = this.getSettings();
    const limit = opts.limit ?? settings.results_limit;
    const raw = await this.noteEmbeddingService.findSimilarBlocks(notePath, limit * 2, opts.minScore ?? 0);
    return this.applyTier2FiltersOnBlocks(raw, notePath, settings).slice(0, limit);
  }

  /**
   * Free-text semantic search with Tier 2 filters applied.
   */
  async semanticSearch(
    query: string,
    opts: ConnectionsOptions = {},
  ): Promise<SimilarNote[]> {
    const settings = this.getSettings();
    const limit = opts.limit ?? settings.results_limit;
    const raw = await this.noteEmbeddingService.semanticSearchNotes(query, limit * 2, opts.minScore ?? 0);
    return this.applyTier2Filters(raw.map(r => ({ ...r, isBlock: false })), null, settings)
      .slice(0, limit) as SimilarNote[];
  }

  // ---------------------------------------------------------------------------
  // Tier 2 filter engine
  // ---------------------------------------------------------------------------

  private applyTier2Filters(
    results: (SimilarNote & { isBlock: boolean })[],
    activeNotePath: string | null,
    settings: ConnectionsSettings,
  ): (SimilarNote & { isBlock: boolean })[] {
    let filtered = results;

    // Path-fragment: exclude wins over include
    const excludeFragments = parseCommaSeparated(settings.exclude_filter);
    const includeFragments = parseCommaSeparated(settings.include_filter);

    if (excludeFragments.length > 0) {
      filtered = filtered.filter(r => !excludeFragments.some(f => r.notePath.includes(f)));
    }
    if (includeFragments.length > 0) {
      filtered = filtered.filter(r => includeFragments.some(f => r.notePath.includes(f)));
    }

    // Inlink/outlink exclusion using Obsidian metadata cache
    if (activeNotePath && (settings.exclude_inlinks || settings.exclude_outlinks)) {
      const activeFile = this.app.vault.getAbstractFileByPath(activeNotePath);
      if (activeFile) {
        const { TFile } = require('obsidian') as typeof import('obsidian');
        if (activeFile instanceof TFile) {
          if (settings.exclude_inlinks) {
            const backlinks = Object.keys(
              this.app.metadataCache.getBacklinksForFile(activeFile)?.data ?? {}
            );
            const backlinkSet = new Set(backlinks);
            filtered = filtered.filter(r => !backlinkSet.has(r.notePath));
          }
          if (settings.exclude_outlinks) {
            const fileCache = this.app.metadataCache.getFileCache(activeFile);
            const outlinks = new Set(
              (fileCache?.links ?? []).map(l => l.link)
            );
            filtered = filtered.filter(r => !outlinks.has(r.notePath.replace(/\.md$/, '')));
          }
        }
      }
    }

    // Frontmatter filters
    if (settings.frontmatter_filter_include || settings.frontmatter_filter_exclude) {
      const includeMatchers = parseFrontmatterFilterLines(settings.frontmatter_filter_include);
      const excludeMatchers = parseFrontmatterFilterLines(settings.frontmatter_filter_exclude);
      filtered = filtered.filter(r => {
        const file = this.app.vault.getAbstractFileByPath(r.notePath);
        const { TFile } = require('obsidian') as typeof import('obsidian');
        if (!(file instanceof TFile)) return true;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
        if (excludeMatchers.length > 0 && matchesFrontmatterFilters(fm, excludeMatchers)) return false;
        if (includeMatchers.length > 0 && !matchesFrontmatterFilters(fm, includeMatchers)) return false;
        return true;
      });
    }

    return filtered;
  }

  private applyTier2FiltersOnBlocks(
    results: import('../../services/embeddings/NoteEmbeddingService').SimilarBlock[],
    activeNotePath: string | null,
    settings: ConnectionsSettings,
  ): import('../../services/embeddings/NoteEmbeddingService').SimilarBlock[] {
    // Reuse note-level path/frontmatter/link filters by projecting to SimilarNote shape
    const projected = results.map(r => ({ notePath: r.notePath, score: r.score, isBlock: true as const }));
    const filtered = this.applyTier2Filters(projected, activeNotePath, settings);
    const kept = new Set(filtered.map(r => r.notePath));
    return results.filter(r => kept.has(r.notePath));
  }
}

// ---------------------------------------------------------------------------
// Pure filter helpers (no dependencies, easily testable)
// ---------------------------------------------------------------------------

/** Split comma-separated fragments and trim whitespace. Empty string → []. */
export function parseCommaSeparated(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Parse newline-delimited frontmatter filter lines.
 * Each line is `key` or `key:value`. Returns parsed matchers.
 * Vendored from smart-entities/utils/frontmatter_filter.js — ~30 lines.
 */
export function parseFrontmatterFilterLines(
  lines: string | undefined,
): Array<{ key: string; value: string | null }> {
  if (!lines?.trim()) return [];
  return lines
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const idx = l.indexOf(':');
      if (idx === -1) return { key: l.toLowerCase(), value: null };
      return { key: l.slice(0, idx).trim().toLowerCase(), value: l.slice(idx + 1).trim().toLowerCase() };
    });
}

/** Return true if frontmatter object satisfies at least one matcher. */
export function matchesFrontmatterFilters(
  frontmatter: Record<string, unknown>,
  matchers: Array<{ key: string; value: string | null }>,
): boolean {
  for (const m of matchers) {
    const fmVal = frontmatter[m.key];
    if (fmVal === undefined) continue;
    if (m.value === null) return true; // key-only match
    if (String(fmVal).toLowerCase() === m.value) return true;
  }
  return false;
}
```

---

## 6. Corrected Settings Schema

Only the **net-new** additions to `MCPSettings` are listed. All existing embedding settings (`enableEmbeddings`, `huggingFaceToken`, `semanticPanel`) are already present.

```typescript
// Additions to MCPSettings in src/types/plugin/PluginTypes.ts

/** Tier 1 — Ingestion */
indexingExcludedPatterns?: string[];   // e.g. ["Templates/", "Daily/202[0-2]/**"]
                                        // folder paths end with /; globs use *

/** Tier 2 — Results (connections panel) */
connections?: Partial<ConnectionsSettings>;
```

```typescript
// New file: src/ui/semanticPanel/ConnectionsSettings.ts

export interface ConnectionsSettings {
  /** Number of results shown in panel. Default 20. */
  results_limit: number;
  /** Which sidebar opens. Default 'right'. */
  connections_view_location: 'left' | 'right';
  /** Comma-separated path fragments that MUST appear in result path. Empty = no restriction. */
  include_filter: string;
  /** Comma-separated path fragments that remove a result. Exclude wins over include. */
  exclude_filter: string;
  /** Newline-delimited key or key:value frontmatter matchers. Result kept if matched. */
  frontmatter_filter_include: string;
  /** Newline-delimited matchers. Result removed if matched. Exclude wins. */
  frontmatter_filter_exclude: string;
  /** Remove results that already link TO the current note. */
  exclude_inlinks: boolean;
  /** Remove results that the current note already links TO. */
  exclude_outlinks: boolean;
  /** Hide block results whose chunk is the frontmatter block. Default true. */
  exclude_frontmatter_blocks: boolean;
}

export const DEFAULT_CONNECTIONS_SETTINGS: ConnectionsSettings = {
  results_limit: 20,
  connections_view_location: 'right',
  include_filter: '',
  exclude_filter: '',
  frontmatter_filter_include: '',
  frontmatter_filter_exclude: '',
  exclude_inlinks: false,
  exclude_outlinks: false,
  exclude_frontmatter_blocks: true,
};
```

Note: `results_collection_key` ('smart_sources' | 'smart_blocks') is NOT added — Nexus uses `resultMode: 'notes' | 'blocks'` in the existing `SemanticPanelSettings` for this purpose.

---

## 7. Implementation Phases

### Phase 1 — Wiring Exclusion Patterns Into `EmbeddingExclusionService` *(minimal, critical path)*

**All work is in existing files.**

**Target files:**
- `src/types/plugin/PluginTypes.ts` — add `indexingExcludedPatterns?: string[]` to `MCPSettings`
- `src/services/embeddings/EmbeddingManager.ts` — replace `() => []` stub with live getter

**Work:**

1. Add `indexingExcludedPatterns?: string[]` to `MCPSettings`.

2. In `EmbeddingManager.ts`, thread the patterns getter from the plugin's settings into the `EmbeddingExclusionService` constructor. The manager needs a reference to the settings getter:

```typescript
// EmbeddingManager constructor — add parameter
constructor(
  app: App,
  plugin: Plugin,
  db: SQLiteCacheManager,
  enableEmbeddings: boolean = true,
  messageRepository?: MessageRepository,
  huggingFaceToken?: string,
  getExclusionPatterns?: () => string[],  // NEW
)
```

In `PluginLifecycleManager.ts` at the `new EmbeddingManager(...)` call site, pass:
```typescript
() => (plugin.settings?.indexingExcludedPatterns ?? [])
```

3. When `indexingExcludedPatterns` changes in settings, call `coordinator.reconcileIndex()` to purge newly-excluded paths and queue newly-eligible ones. Wire this in `EmbeddingsTab` after save.

4. **Remove `EmbeddingWatcher`** from `EmbeddingManager` or suppress it. `EmbeddingIndexCoordinator` already handles all four vault events with debouncing. Running both causes double-embed on every file change. The `EmbeddingWatcher` class calls `removeEmbedding` and `updatePath` (deprecated aliases in `EmbeddingService`) while the coordinator calls the non-deprecated `removeNote`/`renameNote` directly. `EmbeddingWatcher` should be removed from `EmbeddingManager.initialize()`.

**Estimate:** 0.5 days.

---

### Phase 2 — Connections Settings and Filtering Service *(net-new)*

**Target files:**
- New `src/ui/semanticPanel/ConnectionsSettings.ts`
- New `src/ui/semanticPanel/ConnectionsService.ts`
- `src/types/plugin/PluginTypes.ts` — add `connections?: Partial<ConnectionsSettings>`

**Work:**

1. Create `ConnectionsSettings.ts` with the interface and defaults from §6.

2. Create `ConnectionsService.ts` with the full implementation from §5.

3. Thread `ConnectionsService` into `SemanticPanelView`. Replace direct calls to `noteEmbeddingService.findSimilarNotes()` with `connectionsService.getConnectionsForFile()`.

   `SemanticPanelView` resolves its services lazily in `resolveServices()`. Add:
   ```typescript
   // In resolveServices()
   const { ConnectionsService } = await import('./ConnectionsService');
   const settings = this.getConnectionsSettings();
   this.connectionsService = new ConnectionsService(this.app, this.noteEmbeddingService!, () => settings);
   ```

4. `getConnectionsSettings()` reads from `plugin.settings?.connections` merged with `DEFAULT_CONNECTIONS_SETTINGS`.

**Estimate:** 1 day.

---

### Phase 3 — Connections Sub-Tab in Settings *(new tab section)*

**Target files:**
- `src/settings/tabs/EmbeddingsTab.ts` — extend with connections filter group, OR
- New `src/settings/tabs/ConnectionsTab.ts` — separate tab (preferred for discoverability)
- `src/settings/SettingsRouter.ts` — add `'connections'` to `SettingsTab` union type
- `src/settings/SettingsView.ts` — add tab rendering

**Work:**

The existing `SettingsRouter` tab type is:
```typescript
export type SettingsTab = 'defaults' | 'workspaces' | 'prompts' | 'providers' | 'apps' | 'data' | 'embeddings';
```

Add `'connections'` to this union. Create `ConnectionsTab.ts` following the `EmbeddingsTab` pattern.

#### Group A — Indexing (Tier 1)

| Field | Control | Binding |
|---|---|---|
| Excluded patterns | Textarea (one per line) | `settings.indexingExcludedPatterns` |
| Re-index vault | Button | `coordinator.reconcileIndex()` |
| Indexing status | Read-only | Reads `noteService.getIndexStats()` |

Helper text: "Enter folder paths (end with `/`) or glob patterns (use `*`). Example: `Templates/` or `Daily/202[0-2]/**`. Hidden folders (`.nexus/`, `.obsidian/`) are always excluded."

On save, call `coordinator.reconcileIndex()` to apply changed exclusions immediately.

#### Group B — Results filters (Tier 2)

| Field | Control | Binding |
|---|---|---|
| Results limit | Number input | `settings.connections.results_limit` |
| Sidebar location | Dropdown `left`/`right` | `settings.connections.connections_view_location` |
| Include filter | Text input | `settings.connections.include_filter` |
| Exclude filter | Text input | `settings.connections.exclude_filter` |
| Frontmatter include | Textarea | `settings.connections.frontmatter_filter_include` |
| Frontmatter exclude | Textarea | `settings.connections.frontmatter_filter_exclude` |
| Exclude backlinks | Toggle | `settings.connections.exclude_inlinks` |
| Exclude outlinks | Toggle | `settings.connections.exclude_outlinks` |
| Hide frontmatter blocks | Toggle | `settings.connections.exclude_frontmatter_blocks` |

Filter-tips paragraph (sourced from SC's `filters_helper` HTML):
> **Filter tips:** Use comma-separated folder or file path fragments such as `Projects/Clients`. Values are trimmed automatically and compared using case-sensitive substring matches.
>
> **Result vs ingestion:** Connections filters only hide results from the panel. To stop notes from being indexed, use the Excluded patterns field above.
>
> **Precedence:** Exclude entries always win when they match, even if the same path fragment appears in the include filter.

**Estimate:** 1.5 days.

---

### Phase 4 — `connections_view_location` Dock Side *(optional UX)*

**Target files:** `src/ui/semanticPanel/SemanticPanelNavigation.ts`

The existing `openSemanticPanelView` opens the panel in the right leaf. Thread `connections_view_location` through to `workspace.getRightLeaf(false)` vs `workspace.getLeftLeaf(false)`.

```typescript
// Current (SemanticPanelNavigation.ts)
export async function openSemanticPanelView(app: App): Promise<void> {
  const existing = app.workspace.getLeavesOfType(SEMANTIC_PANEL_VIEW_TYPE);
  if (existing.length > 0) { ... }
  const leaf = app.workspace.getRightLeaf(false);
  ...
}

// Updated signature
export async function openSemanticPanelView(
  app: App,
  side: 'left' | 'right' = 'right',
): Promise<void>
```

`SemanticPanelUIManager.openSemanticPanel()` reads the setting and passes it through.

**Estimate:** 0.5 days.

---

### Phase 5 — MCP System Prompt Vault Context Injection *(opt-in)*

**Target file:** `src/services/chat/SystemPromptBuilder.ts` (or wherever `buildSystemPrompt` lives — see `connector.ts` for injection path)

The chat panel's Send-to-Chat callback (`onSendToChat` → `SemanticContextPayload`) already works. This phase is specifically for the **MCP system prompt** — injecting vault context into the prompt before Claude Desktop tool calls.

```typescript
// Addition to system prompt assembly
if (settings.connectionsAutoInjectContext) {
  const noteService = embeddingManager?.getService()?.getNoteEmbeddingService();
  if (noteService) {
    const related = await noteService.semanticSearchNotes(
      conversationQuery,
      settings.connectionsContextLimit ?? 5
    );
    const connectionsSettings = getConnectionsSettings(plugin);
    const connectionsService = new ConnectionsService(app, noteService, () => connectionsSettings);
    // Tier 2 path-fragment filters applied
    const filtered = await connectionsService.semanticSearch(conversationQuery, {
      limit: settings.connectionsContextLimit ?? 5
    });
    if (filtered.length > 0) {
      systemPrompt += buildVaultContextBlock(filtered, app);
    }
  }
}
```

New `MCPSettings` fields:
```typescript
connectionsAutoInjectContext?: boolean;  // default false
connectionsContextLimit?: number;        // default 5
```

**Estimate:** 1 day.

---

## 8. Settings Migration

`MCPSettings` uses `plugin.loadData()` / `plugin.saveData()`. The existing pattern seeds missing keys in `onload` via `Object.assign(DEFAULT_SETTINGS, saved)`. New fields are optional so no migration is required — they default to `undefined` (which is falsy) until the user sets them.

For `ConnectionsSettings`, apply defaults at read time:
```typescript
function getConnectionsSettings(plugin: NexusPlugin): ConnectionsSettings {
  return { ...DEFAULT_CONNECTIONS_SETTINGS, ...(plugin.settings?.connections ?? {}) };
}
```

---

## 9. Block-Level Indexing Scope (Open Question Answered)

v5 Open Question 1 is now answered: `NoteEmbeddingService` already supports block indexing (`embedNoteBlocks`, `findSimilarBlocks`, `semanticSearchBlocks`). `NoteChunker.ts` and `ContentChunker.ts` exist. The block toggle and stale-flag management are in `EmbeddingsTab`. The `SemanticPanelView` already supports the notes/blocks toggle in the panel header.

Block-level indexing is **already in scope and partially implemented**. The remaining work is:
- `EmbeddingIndexCoordinator.rebuildAll()` respects the `blockIndexingEnabled` config flag (already reading it via `noteService`). Verify the path: `embedNote()` calls `embedNoteBlocks()` only if `blockIndexingEnabled && !blockIndexStale`.
- `exclude_frontmatter_blocks` in `ConnectionsService.applyTier2FiltersOnBlocks()` filters out blocks with `heading === null` (which is how frontmatter blocks are returned — their heading field from `NoteChunker` is `null` for frontmatter chunks).

---

## 10. Dependency Graph (Verified DAG)

```
Phase 1 (exclusion wiring)
  ├── is independent of all other phases
  └── unblocks: correct Tier 1 filtering for all subsequent phases

Phase 2 (ConnectionsService + ConnectionsSettings type)
  ├── depends on: Phase 1 type additions to MCPSettings (for settings type)
  └── unblocks: Phase 3, Phase 5

Phase 3 (Settings UI tab)
  ├── depends on: Phase 2 (ConnectionsSettings interface must exist)
  └── unblocks: Phase 4 (reads connections_view_location)

Phase 4 (dock side)
  ├── depends on: Phase 3 (settings must exist to read location)
  └── parallelisable with Phase 5

Phase 5 (MCP context injection)
  ├── depends on: Phase 2 (ConnectionsService must exist)
  └── parallelisable with Phase 4
```

True critical path: **Phase 1 → Phase 2 → Phase 3 → (Phase 4 ∥ Phase 5)**

---

## 11. Effort Estimate (Revised)

| Phase | Description | Days |
|---|---|---|
| 1 | Wire exclusion patterns from settings, remove duplicate `EmbeddingWatcher` | 0.5 |
| 2 | `ConnectionsSettings.ts` + `ConnectionsService.ts` + panel wiring | 1.0 |
| 3 | Connections settings tab (Tier 1 + Tier 2 groups) | 1.5 |
| 4 | Dock side setting (`connections_view_location`) | 0.5 |
| 5 | MCP system prompt vault context injection (opt-in) | 1.0 |
| **Total** | | **4.5 days** |

This is roughly half the v5 estimate because ~60% of the planned work already exists.

---

## 12. Open Questions Resolved

| # | v5 Question | Resolution |
|---|---|---|
| 1 | Block-level indexing in scope? | Already implemented. No additional plan work needed. |
| 2 | Mobile support? | `EmbeddingRuntime` is permanently `unavailable` on mobile. Remote adapter pathway is not built and not needed for this integration. Panel should show graceful "desktop only" message (already done via `Platform.isDesktop` check). |
| 3 | `parse_frontmatter_filter_lines` dependency? | Sourced from `smart-entities` (not in this workspace). Vendored as `parseFrontmatterFilterLines` in `ConnectionsService.ts` — ~15 lines, no dependency. |
| 4 | Glob matching for `indexingExcludedPatterns`? | `EmbeddingExclusionService.matchesAnyPattern()` already handles folder-prefix and `*`-wildcard patterns. No glob library needed. |
| 5 | Settings migration for new keys? | Optional fields with falsy defaults. No explicit migration script needed. |

## 13. Remaining Open Question

**Smart Lookup panel:** SC's `ConnectionsLookupItemView` wraps `smart-lookup-obsidian` (a separate npm package). The existing Nexus semantic panel's search mode (`panelMode === 'search'`) provides equivalent functionality via `semanticSearchNotes` / `semanticSearchBlocks`. No additional lookup panel is needed unless feature parity with SC's lookup UX is a specific requirement.
