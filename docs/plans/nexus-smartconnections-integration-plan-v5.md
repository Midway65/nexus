# Nexus × Smart Connections — Integration Plan v5

> **Revision notes (v5):** Adds complete two-tier exclusion system sourced directly from
> `ConnectionsLists` settings config and the `settings_config()` function in SC's source.
> Corrects Phase 3 (Settings) and Phase 4 (Indexer) to model both ingestion-level and
> results-level filtering. Confirms Nexus currently has no exclusion logic in
> `NoteEmbeddingService.embedNote()` — all filtering is net-new work.

---

## 1. Architectural Baseline

### 1.1 Nexus

Nexus is a TypeScript Obsidian plugin built around a `ServiceManager` / `PluginLifecycleManager`
dependency-injection system and SQLite-backed vector storage (`sqlite-vec` / `vec0` virtual tables).
Its embedding subsystem is split across:

| File | Role |
|---|---|
| `EmbeddingEngine.ts` | Thin façade: owns the `EmbeddingIframe` instance, exposes `generateEmbedding()` and `getModelInfo()` |
| `EmbeddingIframe.ts` | Creates a sandboxed `<iframe>` whose HTML blob hardcodes `MODEL_ID`, `pooling`, and `quantized` at construction time |
| `NoteEmbeddingService.ts` | Reads vault files, hashes content, stores/updates vectors in `note_embeddings` + `embedding_metadata` |
| `IndexingQueue.ts` | Queues and throttles per-note embedding work |
| `EmbeddingService.ts` | Façade over note / trace / conversation embedding domains |

**Current exclusion state:** `NoteEmbeddingService.embedNote()` skips only non-`.md` files and
empty content after preprocessing. There is no folder exclusion, no path-fragment filter, no
frontmatter filter, and no inlink/outlink filter anywhere in the Nexus codebase.

### 1.2 Smart Connections

SC is a JavaScript plugin built on `SmartEnv`. The integration extracts three artefacts without
importing `SmartPlugin` or `SmartEnv`:

| Artefact | File | What it provides |
|---|---|---|
| `ConnectionsItemView` | `src/views/connections_item_view.js` | Side panel for active-file connections |
| `ConnectionsLookupItemView` | `src/views/lookup_item_view.js` | Freeform semantic lookup panel |
| `ConnectionsLists` (settings schema) | `src/collections/connections_lists.js` | Full settings config and filter contracts |

SC's exclusion system is two-tier. The distinction is documented in the settings UI itself:
> *"Connections filters only hide results after Smart Environment builds its dataset.
> To stop notes from being indexed, adjust Smart Environment include/exclude settings."*

---

## 2. Two-Tier Exclusion Model

Understanding this distinction is prerequisite to correct implementation.

### Tier 1 — Ingestion exclusions (prevent embedding)

Applied in `VaultIndexer` before a file is ever handed to `NoteEmbeddingService`. A file that
matches an ingestion exclusion is never embedded and never appears in any results list.

| Setting key | Type | Behaviour |
|---|---|---|
| `indexing_excluded_folders` | `string[]` | Exact folder-path prefix match. File skipped if its path starts with any listed folder. |
| `indexing_excluded_patterns` | `string[]` | Glob patterns (e.g. `Templates/**`, `*.excalidraw.md`). File skipped if any pattern matches. |
| `indexing_excluded_extensions` | `string[]` | Non-`.md` extension allowlist. Default behaviour already skips non-markdown, but canvas, excalidraw, etc. can be listed explicitly. |

These settings live in the new **"Connections — Indexing"** sub-section of the Nexus settings tab.
A change to any Tier 1 setting that widens exclusions must purge orphaned embeddings from
`embedding_metadata` and `note_embeddings`. A change that narrows exclusions queues newly
eligible files for indexing.

### Tier 2 — Results filters (hide from panel without re-indexing)

Applied inside `ConnectionsService.getConnectionsForFile()` and `semanticSearch()` after SQLite
returns candidates. Files remain indexed; they are simply not shown.

| Setting key | Type | Behaviour |
|---|---|---|
| `include_filter` | `string` | Comma-separated path fragments. A result is kept only if its path contains at least one fragment. Empty = no restriction. Case-sensitive substring. |
| `exclude_filter` | `string` | Comma-separated path fragments. A result is removed if its path contains any fragment. **Exclude always wins over include.** |
| `frontmatter_filter_include` | `string` | Newline-delimited `key` or `key:value` matchers. Result kept only if frontmatter matches. |
| `frontmatter_filter_exclude` | `string` | Newline-delimited `key` or `key:value` matchers. Result removed if frontmatter matches. Exclude wins. |
| `exclude_inlinks` | `boolean` | Remove results that already link TO the current note (backlinks). |
| `exclude_outlinks` | `boolean` | Remove results that the current note already links TO. |
| `exclude_frontmatter_blocks` | `boolean` | Hide block-level results whose key is in frontmatter. Default `true`. |
| `results_limit` | `number` | Max results returned to panel. Default 20. |
| `connections_view_location` | `"left" \| "right"` | Which sidebar the panel opens in. Default `"right"`. |

These settings live in the **"Connections — Filters"** sub-section of the settings tab.
No re-index is needed when they change; the panel re-renders immediately on next activation.

### Precedence rules (verbatim from SC source)

- Exclude entries always win when they match, even if the same path fragment appears in the
  include filter.
- Frontmatter exclude entries take precedence over frontmatter include entries.
- Tier 1 (ingestion) exclusions have absolute precedence over Tier 2 filters — a note excluded
  from indexing cannot appear in results regardless of filter settings.

---

## 3. Local Model Adapter System (carried from v4)

### 3.1 Why the iframe must be rebuilt per model

`EmbeddingIframe.ts` constructs a JavaScript blob URL containing `MODEL_ID`, `pooling`, and
`quantized` as string literals at construction time. There is no message-based model-swap path.
Changing the active model requires disposing the existing iframe and constructing a new one.

### 3.2 `LocalModelConfig` interface

```typescript
interface LocalModelConfig {
  /** Transformers.js model ID, e.g. "Xenova/all-MiniLM-L6-v2" */
  modelId: string;
  /** Output vector dimensions */
  dimensions: number;
  /** Pooling strategy: "mean" (default) | "cls" | "max" */
  pooling: 'mean' | 'cls' | 'max';
  /** Use int8 quantisation. Default true for bandwidth; false for accuracy-sensitive models */
  quantized: boolean;
  /**
   * Task-prefix strategy for models that require input prefixing.
   * "none"     — no prefix (MiniLM, BGE after normalisation)
   * "nomic"    — "search_document:" for indexing, "search_query:" for queries
   * "e5"       — "passage: " for indexing, "query: " for queries
   */
  taskPrefix: 'none' | 'nomic' | 'e5';
  /** Human-readable label shown in the settings dropdown */
  displayName: string;
}
```

### 3.3 Pre-registered local model catalog

All models are registered at startup and are dormant (no iframe, no download) until selected.

| Display name | `modelId` | Dimensions | Pooling | `quantized` default | `taskPrefix` | Notes |
|---|---|---|---|---|---|---|
| MiniLM L6 v2 *(default)* | `Xenova/all-MiniLM-L6-v2` | 384 | mean | true | none | Current Nexus default |
| Nomic Embed Text v1.5 | `nomic-ai/nomic-embed-text-v1.5` | 768 | mean | true | nomic | Requires `search_document:` / `search_query:` prefix |
| BGE Small EN v1.5 | `Xenova/bge-small-en-v1.5` | 384 | cls | true | none | CLS pooling — will silently degrade with mean pooling |
| BGE Base EN v1.5 | `Xenova/bge-base-en-v1.5` | 768 | cls | false | none | Accuracy-first; quantized=false recommended |
| E5 Small v2 | `Xenova/e5-small-v2` | 384 | mean | true | e5 | Requires `passage:` / `query:` prefix |
| E5 Base v2 | `Xenova/e5-base-v2` | 768 | mean | false | e5 | — |
| GTE Small | `Xenova/gte-small` | 384 | mean | true | none | — |

### 3.4 Dimension-change guard

When the user selects a new model whose `dimensions` differs from the model recorded in
`embedding_metadata`, `VaultIndexer` must:

1. Show a blocking notice: *"Model dimension mismatch (old: Xd → new: Yd). A full re-index is
   required. All existing vault embeddings will be deleted."*
2. On user confirmation: `DELETE FROM note_embeddings; DELETE FROM embedding_metadata;`
3. Dispose the old `LocalTransformersAdapter`, construct the new one.
4. Trigger `indexAllVaultNotes()`.

The current model ID and dimensions are stored in a new `embedding_config` key-value table
(`key TEXT PRIMARY KEY, value TEXT`) seeded on first run.

---

## 4. Implementation Phases

### Phase 1 — Embedding Adapter Abstraction *(critical path)*

**Target files:** `EmbeddingEngine.ts`, `EmbeddingIframe.ts`, new `IEmbeddingAdapter.ts`,
`LocalTransformersAdapter.ts`, `RemoteEmbeddingAdapter.ts`, `EmbeddingAdapterRegistry.ts`.

**Work:**

- Extract `IEmbeddingAdapter` interface:
  ```typescript
  interface IEmbeddingAdapter {
    generateEmbedding(text: string, role?: 'document' | 'query'): Promise<Float32Array>;
    getModelInfo(): { id: string; dimensions: number };
    dispose(): void;
  }
  ```
- `LocalTransformersAdapter` accepts `LocalModelConfig`, constructs the iframe with interpolated
  `MODEL_ID`, `pooling`, and `quantized`. Implements `role`-aware task-prefix injection for
  `nomic` and `e5` variants.
- `RemoteEmbeddingAdapter` wraps OpenAI, Cohere, and Ollama HTTP APIs. API key stored in
  Nexus's existing credential store.
- `EmbeddingAdapterRegistry` pre-registers all seven local models and three remote adapters.
  Provides `getActive()`, `setActive(id)`, and `list()`.
- `EmbeddingEngine` delegates all calls to the active adapter from the registry.
- All existing `EmbeddingService` callers are unaffected.

**Estimate:** 3–4 days.

---

### Phase 2 — Side Panel Registration

**Target files:** new `ConnectionsService.ts`, `ConnectionsItemView.ts` (TS port),
`ConnectionsLookupItemView.ts` (TS port), `ConnectionsRenderer.ts`.

**Work:**

- Port SC's two view files from JavaScript to TypeScript, stripping all `SmartPlugin` / `SmartEnv`
  imports. Register via `PluginLifecycleManager`.
- `ConnectionsService`:
  - Listens to `workspace.on('active-leaf-change')`.
  - Calls `NoteEmbeddingService.findSimilarNotes()` with Tier 2 filters applied post-query
    (see Phase 3).
  - Applies inlink/outlink exclusion by reading `app.metadataCache.getBacklinksForFile()` and
    `app.metadataCache.getFileCache().links`.
  - Exposes `getConnectionsForFile(path, options)` and `semanticSearch(query, options)`.
- `ConnectionsRenderer` uses Nexus CSS tokens; left/right dock toggled via
  `connections_view_location` setting.

**Estimate:** 2–3 days.

---

### Phase 3 — Settings Tab ("Connections" tab)

**Target files:** existing `SettingsView` / `SettingsRouter`, new `ConnectionsSettings.ts`,
`ConnectionsFilterSettings.ts`.

The settings tab is split into three groups matching SC's documented structure.

#### Group A — Model

| Field | Control | Description |
|---|---|---|
| Active embedding model | Dropdown (all registered adapters) | Selecting a new model triggers dimension-change guard if needed |
| API key | Password input | Visible only when a remote adapter is active |
| Download status | Read-only badge | Shows `cached` / `downloading X%` / `not downloaded` for local models |

#### Group B — Indexing (Tier 1)

| Field | Control | Description |
|---|---|---|
| Excluded folders | Multi-line text or tag-input | Folder paths; one per line. Stored as `indexing_excluded_folders: string[]`. Prefix-matched against `file.path`. |
| Excluded file patterns | Multi-line text | Glob patterns; one per line. Stored as `indexing_excluded_patterns: string[]`. |
| Re-index vault | Button | Triggers `indexAllVaultNotes()`. Shows progress in `EmbeddingStatusBar`. |
| Indexing status | Read-only | `X / Y notes indexed`. |

A change to any Tier 1 field emits `settings:changed` with `path: 'indexing_excluded_folders'`
(or patterns). `VaultIndexer` listens and schedules a differential sync: purge newly excluded
paths, queue newly included files.

#### Group C — Filters (Tier 2)

| Field | Control | Description |
|---|---|---|
| Connection results type | Dropdown (`sources` / `blocks`) | Whether results are note-level or block-level |
| Results limit | Number input | Default 20 |
| Sidebar location | Dropdown (`left` / `right`) | Default `right` |
| Include filter | Text input | Comma-separated path fragments. Empty = no restriction. |
| Exclude filter | Text input | Comma-separated path fragments. Exclude wins over include. |
| Frontmatter include filter | Textarea | Newline-delimited `key` or `key:value` matchers. |
| Frontmatter exclude filter | Textarea | Newline-delimited matchers. Exclude wins. |
| Exclude backlinks | Toggle | Hide notes that already link to the current note. |
| Exclude outlinks | Toggle | Hide notes the current note already links to. |
| Hide frontmatter blocks | Toggle | Default on. Hides block-level results for frontmatter keys. |

A helper paragraph — sourced verbatim from SC's `filters_helper` HTML node — is rendered at the
top of Group C:

> **Filter tips:** Use comma-separated folder or file path fragments such as `Projects/Clients`.
> Values are trimmed automatically and compared using case-sensitive substring matches.
>
> **Result vs ingestion:** Connections filters only hide results after indexing. To stop notes
> from being indexed, use the Excluded folders / patterns fields above.
>
> **Precedence:** Exclude entries always win when they match, even if the same path fragment
> appears in the include filter.

**Estimate:** 2 days.

---

### Phase 4 — Vault-Wide Indexing Pipeline

**Target files:** new `VaultIndexer.ts`, extensions to `IndexingQueue.ts`.

**Work:**

`VaultIndexer` is registered as a service wired to `onServicesReady`.

```
indexAllVaultNotes()
  └─ app.vault.getMarkdownFiles()
      └─ for each file:
          ├─ isTier1Excluded(file.path)  → skip + purge stale embedding if present
          └─ NoteEmbeddingService.embedNote(file.path)  (queued via IndexingQueue)
```

`isTier1Excluded(path: string): boolean`:
```
1. For each folder in indexing_excluded_folders:
     if path.startsWith(folder + '/') → true
2. For each pattern in indexing_excluded_patterns:
     if micromatch(path, pattern) → true
3. return false
```

**Incremental sync** (called on `vault.on('modify' | 'create' | 'rename' | 'delete')`):

| Event | Action |
|---|---|
| `create` / `modify` | If not Tier 1 excluded → queue `embedNote`. If excluded → `removeEmbedding`. |
| `rename` | If new path not excluded → `updatePath`. If new path excluded → `removeEmbedding`. |
| `delete` | `removeEmbedding` |

**Settings-change sync** (on `settings:changed` with indexing path):

- Widen exclusion (add folder/pattern) → `removeEmbedding` for all currently-indexed paths that
  now match.
- Narrow exclusion (remove folder/pattern) → queue `embedNote` for all vault files that now pass
  the filter.

**Estimate:** 2–3 days.

---

### Phase 5 — Chat Context Injection (opt-in)

**Target files:** `SessionContextManager.ts`.

Extend `buildSystemPrompt()` with an optional vault-context block:

```typescript
if (settings.connectionsAutoInjectContext) {
  const related = await noteEmbeddingService.semanticSearch(
    conversationQuery,
    settings.connectionsContextLimit ?? 5
  );
  // Tier 2 path-fragment filters applied here before injection
  const filtered = applyResultsFilters(related, connectionsSettings);
  if (filtered.length) {
    systemPrompt += buildVaultContextBlock(filtered);
  }
}
```

Default: **off** (`connectionsAutoInjectContext: false`). Token cost is non-trivial for large
vaults; user must opt in explicitly. A token-estimate preview is shown next to the toggle.

**Estimate:** 1 day.

---

## 5. Settings Schema Summary

```typescript
interface ConnectionsSettings {
  // Model
  activeAdapterId: string;               // default: "Xenova/all-MiniLM-L6-v2"
  remoteAdapterApiKey: string;           // encrypted at rest

  // Tier 1 — Ingestion
  indexing_excluded_folders: string[];   // e.g. ["Templates", "Archive/Old"]
  indexing_excluded_patterns: string[];  // e.g. ["**/*.excalidraw.md", "Daily/202[0-2]/**"]

  // Tier 2 — Results
  results_collection_key: 'smart_sources' | 'smart_blocks';
  results_limit: number;                 // default 20
  connections_view_location: 'left' | 'right';
  include_filter: string;                // comma-separated path fragments
  exclude_filter: string;                // comma-separated path fragments
  frontmatter_filter_include: string;    // newline-delimited key or key:value
  frontmatter_filter_exclude: string;    // newline-delimited key or key:value
  exclude_inlinks: boolean;
  exclude_outlinks: boolean;
  exclude_frontmatter_blocks: boolean;   // default true

  // Chat injection
  connectionsAutoInjectContext: boolean; // default false
  connectionsContextLimit: number;       // default 5
}
```

---

## 6. Open Questions

| # | Question | Impact |
|---|---|---|
| 1 | **Block-level indexing scope.** SC supports `smart_blocks` (sub-note chunking). Nexus's `ContentChunker.ts` exists but `NoteEmbeddingService` does not use it for note-level embeddings. Is block-level indexing in scope for this integration? If yes, Phase 4 must be extended. | Medium — adds ~1 week |
| 2 | **Mobile.** The `LocalTransformersAdapter` iframe approach is already disabled on mobile in Nexus. Remote adapters (OpenAI, Cohere) work over HTTP and could function on mobile. Is mobile support required? | Low — isolated flag |
| 3 | **Frontmatter filter parsing.** SC uses `parse_frontmatter_filter_lines()` from `smart-entities`. Recommend vendoring this ~40-line utility as TypeScript rather than taking the npm dependency. | Low |
| 4 | **Glob matching.** `micromatch` is the natural choice for `indexing_excluded_patterns`. Obsidian bundles no glob library. Vendoring or a lightweight alternative (`picomatch`, ~2 KB) is needed. | Low |
| 5 | **Settings migration.** Existing Nexus users have no `ConnectionsSettings` block. `onload` must seed defaults without overwriting any future persisted values. | Low — standard migration pattern |

---

## 7. Effort Estimate

| Phase | Description | Days |
|---|---|---|
| 1 | Embedding adapter abstraction + local model catalog | 3–4 |
| 2 | Side panel views + `ConnectionsService` | 2–3 |
| 3 | Settings tab (Model + Indexing + Filters groups) | 2 |
| 4 | `VaultIndexer` + Tier 1 exclusion engine + incremental sync | 2–3 |
| 5 | Chat context injection (opt-in) | 1 |
| **Total** | | **10–13 days** |

Phases 3 and 4 are parallelisable. Phase 1 is the dependency for all others and should begin
first.
