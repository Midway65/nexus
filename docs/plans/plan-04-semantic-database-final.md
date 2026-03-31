# Plan 04 — Semantic Database: Persistence, Blocks, Native Local Models & Index Lifecycle
Last Updated: 2026-03-30

## Goal

Build a fast, reliable semantic index that is the foundation for everything in Plan 05. It must be:

- **Always ready** — reconciles on startup, stays current via vault events, and recovers from external file operations or plugin restarts
- **Hybrid-granularity** — always indexes whole notes and can optionally index note paragraphs/sections for higher-precision retrieval inside large files
- **Accurately scored** — uses cosine similarity over L2-normalized vectors
- **Native-local first** — high-quality local embeddings run inside the Obsidian plugin with no Ollama, Python, localhost server, or cloud dependency
- **Multi-model** — users can choose among curated local embedding models, with `nomic-embed-text-v1.5` as the default and primary model
- **Privacy-first** — all core functionality works fully offline after model download
- **Self-healing** — the index can be refreshed, cleaned, rebuilt, or cleared from the Nexus UI without touching user notes
- **Organized in the UI** — all embedding-related controls live in a dedicated **Embeddings** tab
- **Selective** — users control exactly what gets indexed using exclusions and Obsidian's own excluded files list
- **MCP-exposed** — Claude can query the index via a new `findRelated` tool on `SearchManager`

This is a prerequisite for Plan 05 (Semantic Panel). Plan 05 block mode requires block indexing from this plan.

---

## Non-Goals / Deferred Scope

The following are explicitly **out of scope for Plan 04**:

- Online/cloud embedding providers (including OpenAI)
- Ollama or other local HTTP embedding servers
- Python embedding backends
- Hybrid local+cloud failover
- Cross-device index sync
- Semantic indexing of non-markdown content beyond the current markdown note scope
- User-configurable free-text model IDs
- Experimental retrieval tuning UIs beyond basic diagnostics

These may be revisited in a later plan after the native-local architecture is stable.

---

## Architecture Decisions

### Native local execution model

The semantic database uses **native local inference** as the primary architecture:

- Run embedding models via `@huggingface/transformers` / Transformers.js using ONNX weights inside the Obsidian plugin runtime.
- Do **not** require Ollama.
- Do **not** require Python.
- Do **not** require a localhost server or external daemon.

**Threading model:** Embedding inference runs inside a hidden `<iframe>` sandbox element (following Smart Connections' established pattern for Obsidian). The iframe communicates with the plugin via `postMessage`. `EmbeddingRuntime` owns the iframe lifecycle. This is the only viable approach for Obsidian because Web Workers with ONNX are not reliably available across platforms and the iframe approach is proven in production. If Nexus already has a worker-like isolation layer compatible with Transformers.js, that may be used as a drop-in; otherwise implement the iframe pattern.

**Desktop-only constraint:** The iframe + Transformers.js approach depends on Electron's renderer environment and is not available on mobile. `EmbeddingRuntime` must check `Platform.isDesktop` before creating the iframe. On mobile, skip iframe creation entirely and set runtime health to a permanent `unavailable` state with the message: _"Local embedding models require the desktop app."_ The Embeddings tab must show this state explicitly — the panel still loads on mobile but displays "Semantic index not available on mobile." All code paths that call `EmbeddingRuntime.generateEmbedding()` must handle the `unavailable` state without throwing.

**Electron CSP acknowledgment:** The iframe approach is used in production by Smart Connections and works within Obsidian's Electron renderer CSP. However, if a future Obsidian update tightens the CSP and breaks iframe `postMessage`, the fallback is to run Transformers.js inference synchronously on the main thread (blocking) until a better isolation mechanism is available. Document this in a code comment in `EmbeddingRuntime.ts`.

This is the correct fit because it minimizes user setup, keeps the experience private by default, and preserves a fully local install flow that feels native to Obsidian.

### Derived-cache model

The semantic index is a **derived cache of vault content**, not a source of truth.

That means:
- Notes remain the authoritative data source.
- Embeddings, block rows, and semantic metadata are disposable and reproducible.
- Any inconsistency in the semantic DB must be correctable through reconciliation, refresh, clean, or rebuild.

### Model change always requires a rebuild

Changing the active embedding model always requires a full index rebuild, regardless of whether the old and new models share the same vector dimension.

Rationale: embeddings from different models occupy entirely different semantic spaces. A same-dimension switch (e.g. MiniLM → bge-small, both 384-dim) still produces vectors that are geometrically incompatible. Cosine similarity across mixed-model vectors is meaningless. There is no safe "silent upgrade" for model switches. The only safe transitions are:
- No change to the model → no rebuild needed.
- Any model change → rebuild required.

Surface a banner when the active model in settings no longer matches the model stored in `embedding_config`. Offer "Rebuild now" or "Rebuild later." Do not silently continue indexing with mixed-model vectors.

### Nexus UI organization

The Nexus UI groups **all embedding-related functionality** into a dedicated **Embeddings** tab.

The Embeddings tab is the **single canonical home** for:
- model selection,
- semantic index status,
- maintenance utilities,
- exclusions,
- diagnostics,
- advanced embedding-related options.

Embedding controls should be removed from `DefaultsTab` entirely, except for an optional pointer to the Embeddings tab.

---

## Data Model Invariants

These invariants must hold throughout the system:

1. **One active embedding dimension at a time.**
   - The active semantic index uses a single vector dimension determined by the selected model.
   - Changing to a different dimension invalidates the current index and requires a rebuild.

2. **One active local model at a time.**
   - Only one local embedding model is active for indexing and retrieval.
   - Model metadata is stored with indexed content for diagnostics and compatibility checks.
   - Any model change (including same-dimension switches) requires a rebuild.

3. **Normalized vectors only.**
   - Stored note, block, and query embeddings must all be L2-normalized before storage.
   - Similarity search must use `vec_distance_cosine`.
   - Score displayed to users is `1 - distance`.

4. **Derived data is disposable.**
   - If the DB becomes inconsistent, it is safe to drop and rebuild it from notes.

5. **Note-level indexing is mandatory.**
   - Whole-note embeddings form the semantic backbone of the system and are always enabled.

6. **Block-level indexing is optional.**
   - Block embeddings are an enhancement layer for higher-precision retrieval and may be enabled or disabled in settings.
   - When block indexing is disabled, existing block rows must be pruned on the next refresh or rebuild.
   - Block row pruning after a toggle change happens on the next explicit refresh or rebuild, not immediately on settings save. A notice must inform the user that a refresh is needed to clean up existing block rows.

7. **Exclusions apply everywhere.**
   - Excluded notes must not be indexed.
   - Excluded notes must not appear in note results, block results, or MCP-exposed search results.
   - Exclusion changes take effect on settings save: newly excluded notes are removed from the index immediately, and newly included notes are queued for embedding.

8. **Index lifecycle outlives panel lifecycle.**
   - The semantic system runs at plugin/service level, not panel-instance level.

---

## Current State

`NoteEmbeddingService` currently has:
- Content hash change detection
- `findSimilarNotes(notePath, limit)`
- `semanticSearch(query, limit)`
- `embedNote(notePath)`

`ContentChunker` currently has:
- 500-char chunks
- 100-char overlap
- 50-char minimum
- Used for conversation QA pairs — **must not be modified for note embedding use**

**Current gaps:**
1. No startup reconciliation
2. No optional block-level indexing layer
3. Incorrect L2-based similarity display
4. No coherent maintenance UI
5. One hardcoded local model only
6. No full exclusion policy
7. Obsidian excluded files ignored
8. No explicit create / modify / delete / rename lifecycle handling
9. No dedicated Embeddings tab
10. No diagnostics/observability layer
11. No heading-aware chunking for semantic retrieval quality
12. No explicit retrieval contract for notes vs blocks
13. `ContentChunker` and note embedding chunking conflated — must be separated

---

## Implementation Plan

### Phase 1 — Service Boundaries and Naming

Before adding features, lock service responsibilities.

**Required service split:**

- `EmbeddingRuntime`
  - iframe sandbox lifecycle (create, maintain, destroy)
  - Model loading/unloading via postMessage to iframe
  - Model download/cache lifecycle and progress reporting
  - Inference execution: send text → receive raw embedding via message channel
  - Runtime health state (uninitialized, loading, ready, error, unavailable)
  - Singleton — one instance shared across the plugin
  - **Delegates to `EmbeddingPreprocessor`** for all model-specific text preparation and output post-processing before/after the inference call. `EmbeddingRuntime` handles the transport; `EmbeddingPreprocessor` handles the model semantics.

- `EmbeddingPreprocessor` (**new file** — was mistakenly named `EmbeddingEngine` in earlier drafts; that name is taken)
  - Model-specific text preprocessing: applies the correct role prefix per model family (`search_document:`, `passage:`, none — see Phase 8)
  - Post-inference output processing: mean pooling (where needed), optional Matryoshka dimension truncation, L2 normalization
  - Corrected Nomic pipeline: mean pool → optional truncation → L2 normalize (no manual layer_norm)
  - Stateless — takes a model ID and text, returns a normalized `number[]`
  - Called by `EmbeddingRuntime` only; never called directly by other services
  - **Relationship to `EmbeddingRuntime`:** `EmbeddingRuntime` owns the iframe and the inference transport. After receiving raw output from the iframe, it passes it to `EmbeddingPreprocessor.postProcess()`. Before sending text to the iframe, it calls `EmbeddingPreprocessor.prepareText()`. The two classes are always deployed together; `EmbeddingPreprocessor` has no independent lifecycle.

- `EmbeddingIndexCoordinator`
  - Startup reconciliation
  - Vault event listeners (create/modify/delete/rename)
  - Job queue and coalescing
  - Maintenance action orchestration (refresh, clean, rebuild, clear)
  - Progress and error event emission
  - **Lifecycle contract:** must extend `Component` and be registered with `plugin.addChild(coordinator)` so that all vault event listeners registered via `this.registerEvent()` are automatically torn down on plugin unload. Do **not** call `app.vault.on(...)` directly without routing through `this.registerEvent()` — doing so creates a permanent event listener that outlives the plugin and leaks memory.

- `NoteEmbeddingService`
  - Persistence and query logic only
  - Note/block embedding upsert/remove/rename methods
  - Similarity search methods
  - Index stats and DB cleanup methods
  - No vault access, no event handling — called by coordinator

- `EmbeddingExclusionService`
  - All exclusion logic
  - `shouldIndex(notePath): boolean`
  - Exclusion re-evaluation and index cleanup after settings changes

- `NoteChunker` (new — separate from `ContentChunker`)
  - Heading-aware chunking strategy for semantic note indexing
  - Context-enriched chunk output (title + heading + text)
  - Does **not** modify or replace `ContentChunker`, which remains for conversation QA pairs

This separation is mandatory. Avoid overlapping responsibilities.

---

### Phase 2 — Startup Reconciliation

Replace "backfill missing notes" with a **full startup reconciliation pass**.

In `EmbeddingIndexCoordinator`, after `app.workspace.onLayoutReady()`, run a background pass over the vault and the semantic DB.

```typescript
async reconcileIndex(): Promise<void> {
  const files = this.app.vault.getMarkdownFiles();
  const livePaths = new Set(files.map(f => f.path));

  for (let i = 0; i < files.length; i++) {
    const path = files[i].path;

    if (!this.exclusions.shouldIndex(path)) {
      await this.noteEmbeddingService.removeNote(path);
      continue;
    }

    await this.noteEmbeddingService.embedNote(path);
    // embedNote checks content hash internally — only re-embeds if new or changed

    if (i % 10 === 0) await sleep(0); // yield to event loop every 10 files
    this.eventBus.emit('embedding:reconcile-progress', {
      current: i + 1,
      total: files.length,
    });
  }

  // Remove stale rows: files deleted while Obsidian was closed, or newly excluded
  const indexedPaths = await this.noteEmbeddingService.getIndexedPaths();
  for (const indexedPath of indexedPaths) {
    if (!livePaths.has(indexedPath) || !this.exclusions.shouldIndex(indexedPath)) {
      await this.noteEmbeddingService.removeNote(indexedPath);
    }
  }
}
```

Responsibilities:
- Add missing files.
- Update changed files (hash mismatch).
- Remove deleted files (not in vault).
- Remove newly excluded files.
- Correct drift introduced while Obsidian or the plugin was not running.

---

### Phase 3 — Live File Lifecycle Handling

Register vault listeners so the index stays current while Obsidian is open.

Because `EmbeddingIndexCoordinator` extends `Component` (see Phase 1), use `this.registerEvent(...)` for all vault listeners. These are auto-unregistered when the coordinator is unloaded via `plugin.addChild()`. Never call `this.app.vault.on(...)` directly.

```typescript
// In EmbeddingIndexCoordinator.initialize():
this.registerEvent(this.app.vault.on('create', (file) => this.onFileCreate(file)));
this.registerEvent(this.app.vault.on('modify', (file) => this.onFileModify(file)));
this.registerEvent(this.app.vault.on('delete', (file) => this.onFileDelete(file)));
this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onFileRename(file, oldPath)));
```

**Events to handle:**
- `create`
- `modify`
- `delete`
- `rename`

**Queueing requirement:** do not embed directly in event handlers. Route all work through a coalescing queue.

```typescript
type EmbeddingJob =
  | { type: 'upsert'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'rename'; oldPath: string; newPath: string };
```

#### Debounce

Debounce `modify` events with a **1-second window** before enqueuing. Obsidian fires `modify` on every keystroke; without debouncing the queue would be flooded during active editing. `create` and `delete` events are not debounced.

#### Event semantics

**Create**
- If the file is markdown and passes `shouldIndex()`, enqueue `upsert(path)`.

**Modify**
- After 1-second debounce, enqueue `upsert(path)`.
- Re-embedding is skipped later if the content hash is unchanged.

**Delete**
- Enqueue `delete(path)`.

**Rename / move**
- Enqueue `rename(oldPath, newPath)`.
- If the new path is excluded, treat it as a deletion from the index.
- If the rename is followed by a modify within the debounce window, coalesce to `rename(old, new)` + `upsert(new)`.

#### Queue coalescing rules

- Multiple `upsert(path)` jobs collapse to one.
- `create(path)` followed by `modify(path)` within the debounce window becomes one `upsert(path)`.
- `rename(old, new)` followed by `modify(new)` becomes `rename(old, new)` + `upsert(new)`.
- `rename(old, new)` where `new` is excluded becomes `delete(old)`.
- `delete(path)` clears any pending `upsert(path)`.
- Partial failures leave the job retryable.

---

### Phase 4 — Note Chunking Contract

Retrieval quality depends heavily on chunking. `ContentChunker` (500-char fixed windows) must **not** be modified — it is used for conversation QA pairs and the two use cases have different requirements. Introduce a separate `NoteChunker` for note-level semantic indexing.

#### Why a separate chunker

`ContentChunker` produces fixed-size overlapping windows optimized for short-context QA pair embedding. Note embedding needs:
- Heading-aware splits (structural boundaries are more semantically meaningful than character counts)
- Context enrichment (title and heading prepended to each chunk so the embedding carries navigation context)
- Content hash per chunk for incremental update detection
- Stable chunk identity that does not rely solely on position

#### Preprocessing rules

Before chunking note content:
- Strip YAML frontmatter from the semantic body.
- Normalize repeated whitespace.
- Preserve meaningful markdown text (headings, lists, paragraphs).

#### Chunk formation strategy

Use a heading-aware strategy first, then fallback splitting:

1. Split by heading sections (`#`, `##`, `###`) when present.
2. Within long sections, split by paragraph groups.
3. Only fall back to fixed-size character splitting when a section is still too long after paragraph grouping.
4. Keep overlap low (or zero) for heading-based chunks; overlap is only used in fixed-size fallback.

#### Chunk enrichment

Each chunk is embedded with semantic context prepended:

```text
Title: Deep Work Notes
Heading: Rituals
Content: ...chunk text...
```

This improves retrieval quality relative to raw chunk text alone — the model learns the chunk belongs to a specific note and section.

#### Chunk output type

```typescript
interface NoteChunk {
  chunkIndex: number;        // ordering within the note (storage key, not identity key)
  heading: string | null;    // nearest heading above the chunk
  charOffset: number;        // character offset in the stripped note body
  contentHash: string;       // SHA-1 or equivalent of the raw chunk text
  contentPreview: string;    // first 150 chars for UI display
  enrichedText: string;      // title + heading + content, used for embedding
}
```

#### Chunk identity strategy

Do **not** rely solely on `chunkIndex` for stale detection. Inserting a heading near the top of a note shifts all subsequent chunk indices — a pure position-based identity causes false misses and stale row accumulation.

Identity for stale detection:
- Primary: `contentHash` — if hash matches, the chunk is unchanged regardless of index shift.
- Secondary: `chunkIndex` is used as the storage key for ordering and as a local tie-breaker.
- Pruning: after upserting chunks, delete any rows with `chunkIndex >= newChunkCount`. This handles note shortening and restructuring cleanly.

---

### Phase 5 — Hybrid Note-Level + Optional Block-Level Indexing

Whole-note embeddings remain the primary semantic layer and are always enabled. For large or multi-topic notes, optional block-level indexing provides more precise paragraph or section retrieval.

**Vector dimension strategy:** the DB supports **one active dimension at a time**. The vec0 virtual tables are created with a fixed dimension. On model change (any model change — see Architecture Decisions), the semantic vector tables must be dropped and recreated.

**Schema v12 tables** (examples shown for 768-dim Nomic default):

**Important:** `note_embeddings` and `embedding_metadata` already exist in the production schema (schema.ts) at `float[384]` / MiniLM. The v12 migration must explicitly DROP both before recreating them. Vec0 virtual tables cannot be `ALTER TABLE`'d to change dimensions — a DROP+recreate is the only safe path. `IF NOT EXISTS` must **not** be used for these two tables in the migration, because it would silently no-op and leave a 384-dim table when 768-dim is required. `block_embeddings`, `block_embedding_metadata`, and `embedding_config` are genuinely new and should use `CREATE TABLE IF NOT EXISTS`.

```sql
-- v12 migration must run these DROPs first (existing tables from pre-Plan-04 schema):
DROP TABLE IF EXISTS embedding_metadata;
DROP TABLE IF EXISTS note_embeddings;

-- Recreate at the new active dimension (example: 768 for Nomic):
CREATE VIRTUAL TABLE note_embeddings USING vec0(
  embedding float[768]
);

CREATE TABLE embedding_metadata (
  rowid       INTEGER PRIMARY KEY,
  notePath    TEXT NOT NULL UNIQUE,
  contentHash TEXT NOT NULL,
  model       TEXT NOT NULL,
  dimension   INTEGER NOT NULL,
  created     INTEGER NOT NULL,
  updated     INTEGER NOT NULL
);

CREATE VIRTUAL TABLE block_embeddings USING vec0(
  embedding float[768]
);

CREATE TABLE block_embedding_metadata (
  rowid          INTEGER PRIMARY KEY,
  notePath       TEXT NOT NULL,
  chunkIndex     INTEGER NOT NULL,
  heading        TEXT,
  charOffset     INTEGER NOT NULL,
  contentHash    TEXT NOT NULL,     -- hash of raw chunk text (not enriched text)
  contentPreview TEXT,
  model          TEXT NOT NULL,
  dimension      INTEGER NOT NULL,
  created        INTEGER NOT NULL,
  updated        INTEGER NOT NULL,
  UNIQUE(notePath, chunkIndex)
);

CREATE TABLE embedding_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: activeModel, activeDimension, blockIndexingEnabled, blockIndexStale, lastChunkSettingsHash, lastRebuildAt, schemaVersion
```

**Note on UNIQUE(notePath, chunkIndex):** `chunkIndex` is the storage key for ordering and upsert targeting. Stale detection is done by `contentHash`, not by positional identity (see Phase 4 chunk identity strategy). After upserting all current chunks, any rows with `chunkIndex >= newChunkCount` are pruned. This correctly handles note shortening and heading restructuring.

**Required methods on `NoteEmbeddingService`:**
- `embedNote(notePath)` — always updates note embedding; if block indexing enabled, also calls `embedNoteBlocks()`
- `embedNoteBlocks(notePath)` — upserts block rows using `NoteChunker`, prunes stale rows by count
- `removeNote(notePath)` — deletes note row, all block rows, and metadata
- `renameNote(oldPath, newPath)` — updates notePath in all rows atomically
- `findSimilarNotes(notePath, limit)` — fetches the stored note embedding for `notePath` from `note_embeddings`, then uses it as the query vector against the same table (excludes `notePath` itself from results)
- `findSimilarBlocks(notePath, limit)` — fetches the stored note embedding for `notePath` from `note_embeddings`, then uses that vector as the query against `block_embeddings`; does **not** re-embed the note; returns an error if `notePath` has no stored embedding
- `semanticSearch(query, limit)` — embeds `query` text via `EmbeddingRuntime` at call time, then searches `note_embeddings` or `block_embeddings` depending on block indexing state
- `getIndexedPaths()`
- `getIndexStats()`
- `cleanIndex()` — removes orphaned rows and stale block rows
- `clearAllEmbeddings()` — drops all embedding and metadata rows

If block indexing is disabled, `embedNote()` must not create new block rows. Existing block rows for any given note are cleaned up on the next explicit refresh or rebuild. A notice is shown to the user when block indexing is disabled (see Invariant 6).

---

### Phase 6 — Retrieval Contract

The plan must define what each retrieval mode means.

#### Related notes mode

Used by the side panel when the current note is the source.

Default behavior:
- Search note embeddings using `vec_distance_cosine` against the note's embedding.
- If block indexing is enabled, optionally annotate or rerank with best block-per-note match.
- Return one result per note.
- Exclude notes that fail `shouldIndex()`.

#### Related blocks mode

Used when the side panel is explicitly in block mode.

Default behavior:
- Available only when block indexing is enabled and `blockIndexStale` is `'false'`.
- **Uses the stored note embedding** for the source note (fetched from `note_embeddings`) as the query vector — does not re-embed the note at query time. If the source note has no stored embedding, return an empty result with a note that the source note is not indexed yet.
- Search `block_embeddings` using `vec_distance_cosine` against that stored vector.
- Fetch `limit × 3` rows to allow per-note deduplication (keep best-scoring block per note).
- Return block preview, note path, heading, and score.
- Exclude blocks belonging to notes that fail `shouldIndex()`.

**Performance note:** block tables can be significantly larger than note tables (10–50× more rows). Apply a hard row fetch cap (e.g. `limit × 3`, max 300) before deduplication. Do not scan the full block table without a LIMIT.

#### Query search mode

Used when the user enters free-text semantic search.

Default behavior:
- Embed query text using the active model with the appropriate `role: 'query'` prefix.
- If block indexing is enabled, search block embeddings for better recall, then deduplicate to best block per note.
- If block indexing is disabled, search note embeddings directly.
- Apply `shouldIndex()` post-filter to results.

#### MCP `findRelated` tool

The `findRelated` tool is added to `SearchManager` as part of this plan (see Phase 16).

It must enforce the same exclusions and scoring rules as the UI retrieval paths.

Input contract:

```typescript
{
  notePath?: string;   // find related to this note
  query?: string;      // or free-text semantic search
  mode: 'notes' | 'blocks';
  limit?: number;      // default 10
}
```

Output contract:

```typescript
{
  notePath: string;
  heading?: string;     // block mode only
  chunkIndex?: number;  // block mode only
  preview?: string;     // block mode only
  score: number;        // 0–1, where 1 is identical
}[]
```

---

### Phase 7 — Score Accuracy

`vec_distance_l2()` is incorrect for the desired similarity display. Replace it with cosine distance everywhere.

**Required rule:**
- All stored vectors must be L2-normalized before storage.
- All KNN queries use `vec_distance_cosine`.
- Display score is `1 - distance`, bounded `[0, 1]`.

Optional readability normalization may be applied at the presentation layer (scaling scores so the best result reads clearly), but cosine is the authoritative source of truth and must not be replaced.

---

### Phase 8 — Native Local Model Selection

Offer curated local tiers rather than a free-text model ID.

| Tier | Model | Dim | Size | MTEB | Context | Notes |
|------|-------|-----|------|------|---------|-------|
| Fast | `Xenova/all-MiniLM-L6-v2` | 384 | 23 MB | 49.0 | 512 tok | Lowest friction; legacy fallback |
| Balanced | `Xenova/bge-small-en-v1.5` | 384 | 33 MB | 51.7 | 512 tok | Better quality/size tradeoff |
| **Quality** | **`Xenova/nomic-embed-text-v1.5`** | **768** | **274 MB** | **62.4** | **8192 tok** | **Default** — best retrieval quality; full notes fit in context |
| Multilingual | `Xenova/multilingual-e5-small` | 384 | 118 MB | 46.1 | 512 tok | Use when the vault is substantially multilingual |

#### Why Nomic is the default

- Highest-quality curated local option.
- 8,192-token context window prevents truncation of full notes — the decisive advantage over 512-token models for a PKM tool.
- Compatible with native local ONNX execution via Transformers.js.
- Best MTEB retrieval score in the curated set.

#### Multilingual auto-suggest

On first setup, sample up to 50 vault files. Count non-ASCII characters across the sample. If more than 10% of sampled content is non-Latin script, surface a notice: _"Your vault appears to contain non-English content. The Multilingual model may give better results."_ This check is one-time and does not repeat after initial setup.

#### Model preprocessing contract

Each model family requires different input text preparation. This is handled inside `EmbeddingPreprocessor.prepareText()` (called by `EmbeddingRuntime` before dispatching to the iframe), transparent to all other callers.

```typescript
private prepareText(text: string, role: 'document' | 'query'): string {
  switch (this.settings.localEmbeddingModel) {
    case 'Xenova/nomic-embed-text-v1.5':
      return role === 'query'
        ? `search_query: ${text}`
        : `search_document: ${text}`;
    case 'Xenova/multilingual-e5-small':
    case 'Xenova/multilingual-e5-base':
      return role === 'query'
        ? `query: ${text}`
        : `passage: ${text}`;
    default:
      return text; // MiniLM, bge-small — no prefix needed
  }
}
```

#### Nomic embedding pipeline (corrected)

The correct post-processing pipeline for `nomic-embed-text-v1.5` via Transformers.js:

```typescript
async generateEmbedding(text: string, role: 'document' | 'query'): Promise<number[]> {
  const prepared = this.prepareText(text, role);
  // Step 1: run inference with mean pooling (not CLS pooling)
  const output = await this.extractor(prepared, { pooling: 'mean', normalize: false });
  // Step 2: optional Matryoshka truncation to target dimension
  const targetDim = this.getTargetDimension(); // e.g. 768 for full, 512 for truncated
  const rawData: Float32Array = output.data.slice(0, targetDim);
  // Step 3: L2 normalize the resulting vector
  const magnitude = Math.sqrt(rawData.reduce((sum, v) => sum + v * v, 0));
  return Array.from(rawData.map(v => (magnitude > 0 ? v / magnitude : 0)));
}
```

**Important correction:** this pipeline uses **mean pooling followed by explicit L2 normalization**. There is no `layer_norm` (Layer Normalization) step. Layer Normalization is an internal model operation and must not be applied manually post-inference. The only post-processing required is: mean pool → optional dimension truncation → L2 normalize.

The `normalize: false` flag on the extractor call lets us perform L2 normalization explicitly and consistently, giving exact control over the stored vector format.

#### Model change rule

Any change to the active model — including switches between models with the same vector dimension (e.g. MiniLM → bge-small) — **requires a full rebuild**. Embeddings from different models are geometrically incompatible even at the same dimension. See Architecture Decisions for rationale.

When the active model in settings differs from the model stored in `embedding_config.activeModel`, surface a banner:
_"The embedding model has changed. Rebuild the index to restore full quality."_ Offer "Rebuild now" and "Rebuild later." Do not silently continue indexing with the mismatched model.

---

### Phase 9 — Embeddings Tab in Nexus UI

Create a dedicated **Embeddings** tab and place **all embedding-related functionality** there.

This includes:
- model selection,
- semantic status and health,
- maintenance utilities,
- note/block indexing controls,
- exclusions,
- diagnostics,
- advanced embedding-related controls.

#### Tab structure

**Overview**
- Active model
- Active dimension
- Indexed notes / total notes / excluded notes
- Indexed blocks
- Last refresh / last rebuild
- Current operation and progress
- Health state: healthy, syncing, degraded, error
- Model-mismatch banner (when active model ≠ stored model)

**Indexing**
- Note-level indexing: always on (non-toggleable)
- Block-level indexing toggle with notice: _"Disabling block indexing will remove block rows on next refresh."_
- Chunking controls (advanced, shown only when block indexing is enabled)
- Rebuild-required notice when block or chunking settings change

**Models**
- Local model card picker (card layout, not dropdown — shows size and context before downloading)
- Model download status and cache state
- Rebuild-required warning on any model switch

**Maintenance**
- Refresh index
- Clean index
- Rebuild index
- Clear index
- Clear downloaded models

**Exclusions**
- Excluded folders (folder picker UI)
- Excluded glob patterns (text area)
- Frontmatter exclusions (text area)
- Note: _"Obsidian's built-in excluded files list is also respected automatically."_

**Advanced**
- Optional target dimension (Matryoshka truncation)
- Diagnostics panel (see Phase 13)
- Logging / troubleshooting controls
- Future experimental options

#### Local model card picker

Card-based UI, not a dropdown. Users need to see size and context window before downloading 274 MB:

```
Local Embedding Model
──────────────────────────────────────────────────────
┌─────────────────────────────────────────────────────┐
│ ○  Fast          all-MiniLM-L6-v2                   │
│    23 MB · 384-dim · English · 512 token context    │
├─────────────────────────────────────────────────────┤
│ ○  Balanced      bge-small-en-v1.5                  │
│    33 MB · 384-dim · English · 512 token context    │
├─────────────────────────────────────────────────────┤
│ ●  Quality ★    nomic-embed-text-v1.5  [Active]    │
│    274 MB · 768-dim · English · 8192 token context  │
│    Best retrieval quality — full notes fit in       │
│    context, never truncated                         │
├─────────────────────────────────────────────────────┤
│ ○  Multilingual  multilingual-e5-small              │
│    118 MB · 384-dim · 100 languages · 512 tok       │
└─────────────────────────────────────────────────────┘

Models download on first use and cache locally.
⚠ Switching models always requires rebuilding the index.
```

#### Side panel vs settings split

**Side panel** (Plan 05)
- semantic results,
- current status badge,
- quick actions: `Refresh index`, `Rebuild index`.

**Embeddings tab only**
- model switching,
- exclusions,
- clean index,
- clear index,
- clear downloaded models,
- diagnostics,
- advanced tuning.

---

### Phase 10 — Maintenance Actions

Use precise action names. Each action has a defined scope and must not exceed it.

#### Refresh index

Purpose: incremental sync against the current vault.

Behavior:
- Scan eligible notes.
- Embed missing notes.
- Update changed notes (hash mismatch).
- Remove deleted/excluded notes.
- If block indexing is disabled, remove stale block rows during this pass.
- Preserve valid note and block rows.
- No destructive vector table reset.
- No DB compaction.

#### Clean index

Purpose: DB hygiene and drift cleanup without full rebuild.

Behavior:
- Remove orphaned note rows (no corresponding file).
- Remove orphaned block rows (note no longer indexed).
- Prune stale block rows (count exceeds current chunk count).
- Remove excluded rows.
- Validate metadata consistency.
- Optionally compact the SQLite DB (VACUUM).

#### Rebuild index

Purpose: authoritative reset.

Behavior:
- Delete all semantic vectors and metadata.
- Drop and recreate vec0 virtual tables with the current active model's dimension.
- Update `embedding_config` with new model, dimension, and rebuild timestamp.
- Fully re-embed all eligible notes (and blocks if enabled).
- Used after any model change, dimension change, chunking strategy change, or corruption.

#### Clear index

Purpose: delete semantic index data only.

Behavior:
- Remove all embeddings and semantic metadata.
- Do not modify notes.
- Do not remove downloaded models.
- Does not trigger a rebuild — leaves the index empty until the user or background reconciliation fills it.

#### Clear downloaded models

Purpose: remove cached local model assets.

Behavior:
- Requires confirmation dialog.
- Warns if the active model is being cleared.
- After clearing, the active model returns to `needs-download` state.
- Does not delete the semantic index (vectors remain until the model is re-downloaded and inference can resume).

---

### Phase 11 — Indexing Controls and Exclusion Settings

Support note/block indexing controls plus four exclusion layers.

#### Indexing controls

Expose in the Embeddings tab:
- **Note-level indexing** — always enabled, not user-toggleable.
- **Block-level indexing** — user-toggleable. Disabling shows: _"Block rows will be removed on next refresh or rebuild."_ Enabling marks the block index as stale and prompts: _"Refresh the index to start building block embeddings."_
- **Chunking settings** — advanced controls, visible only when block indexing is enabled. Changing these marks the block index as stale.

#### Block stale state lifecycle

The `embedding_config` table tracks block stale state via two keys:

- `blockIndexStale` — `'true'` or `'false'`. Marks whether the block index needs a rebuild before it can be trusted.
- `lastChunkSettingsHash` — SHA-1 of the active chunking settings (chunk size, overlap, min size). Used to detect setting drift.

**When `blockIndexStale` is set to `'true'`:**
- Block indexing is re-enabled after being disabled.
- Any chunking setting changes (chunk size, overlap, min size) — detected by comparing the new settings hash against `lastChunkSettingsHash`.
- A model change (handled separately via the model-mismatch banner, but block stale flag is also set as part of rebuild-required state).

**When `blockIndexStale` is cleared to `'false'`:**
- A full Rebuild completes successfully.
- A Refresh completes and block indexing is currently enabled (i.e., blocks were actively re-indexed during the pass).

**UI behavior when `blockIndexStale` is `'true'`:**
- The Embeddings tab Overview shows: _"Block index needs rebuild."_ with a `Rebuild` action button.
- Plan 05's panel treats the Blocks toggle as unavailable (disabled with tooltip: _"Block index needs rebuild — open Embeddings settings."_).
- `findRelated` with `mode: 'blocks'` returns `{ success: false, error: "Block index is stale. Rebuild from Embeddings settings." }`.

#### Layer 1 — Obsidian excluded files

Respect `app.vault.config.userIgnoreFilters` automatically. No settings UI needed.

**`as any` exception:** `app.vault.config` is not part of the public Obsidian TypeScript API, so accessing it requires a type cast. This is a documented, deliberate exception to the project's no-`as any` rule — there is no public alternative for reading Obsidian's built-in excluded files list. Add the comment `// eslint-disable-next-line @typescript-eslint/no-explicit-any — vault.config is not in the public API` at the cast site. Count this as +1 toward the project's tracked `as any` total (~22 at time of writing).

```typescript
private isObsidianExcluded(notePath: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any — vault.config is not in the public API
  const filters: string[] = (this.app.vault as any).config?.userIgnoreFilters ?? [];
  return filters.some(filter =>
    notePath.startsWith(filter.endsWith('/') ? filter : filter + '/') ||
    minimatch(notePath, filter)
  );
}
```

#### Layer 2 — Excluded folders

Store as vault-relative paths. `[+ Add Folder]` opens Obsidian's `FolderSuggest`.

```typescript
private isInExcludedFolder(notePath: string): boolean {
  return this.settings.embeddingExcludeFolders.some(folder => {
    const normalized = folder.endsWith('/') ? folder : folder + '/';
    return notePath.startsWith(normalized);
  });
}
```

#### Layer 3 — Excluded glob patterns

Uses `minimatch`. One pattern per line.

```typescript
private matchesExcludePattern(notePath: string): boolean {
  return this.settings.embeddingExcludeGlobs.some(pattern =>
    minimatch(notePath, pattern, { matchBase: false })
  );
}
```

#### Layer 4 — Frontmatter exclusions

Support key-value matches such as `status: archived`, `private: true`, `nexus-index: false`.

```typescript
private matchesFrontmatterExclusion(notePath: string): boolean {
  const file = this.app.vault.getFileByPath(notePath);
  if (!file) return false;
  const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm) return false;
  return this.settings.embeddingFrontmatterExclusions.some(pattern => {
    const [key, value] = pattern.split(':').map(s => s.trim());
    return String(fm[key] ?? '').trim() === value;
  });
}
```

#### Composing all layers

```typescript
shouldIndex(notePath: string): boolean {
  return (
    !this.isObsidianExcluded(notePath) &&
    !this.isInExcludedFolder(notePath) &&
    !this.matchesExcludePattern(notePath) &&
    !this.matchesFrontmatterExclusion(notePath)
  );
}
```

#### Exclusion re-evaluation rule

When exclusion settings change (on settings save):
- Immediately remove newly excluded notes from the index (call `removeNote()` for each).
- Immediately queue newly included notes for embedding (enqueue `upsert(path)` for each).
- Do not wait for the next reconcile pass — exclusion changes are applied eagerly.

---

### Phase 12 — Native Local Runtime Hardening

#### Execution isolation

- Run model inference inside a hidden iframe (see Architecture Decisions — threading model).
- The iframe hosts Transformers.js and processes `generateEmbedding` requests via `postMessage`.
- `EmbeddingRuntime` is a singleton — one iframe instance shared across the plugin lifetime.
- Only one model-load operation at a time (serialize model loads with a lock).

#### Concurrency policy

- Default to serial embedding jobs — one inference call at a time.
- Prioritize UI responsiveness over indexing throughput. Yield every 10 files during reconciliation (see Phase 2).
- Expose queue depth in diagnostics (see Phase 13).

#### Download and cache UX

- Show first-run download progress as a banner or status bar update.
- Distinguish between: download pending, downloading (% progress), initializing, ready, error.
- Cache model assets locally after first successful load (Transformers.js uses IndexedDB by default).
- Do not re-download if the model is already cached.

#### Failure handling

- Failed notes are marked retryable — they re-enter the queue on next reconcile.
- Partial failures (one note fails) do not corrupt the queue or stop indexing.
- Rebuild can be restarted cleanly from any interrupted state.
- Delete and cleanup operations are idempotent (safe to run multiple times).

#### Fallback behavior

- If the selected model fails to initialize, surface a clear error in the Embeddings tab Overview.
- Offer a one-click fallback: _"Switch to Fast model (all-MiniLM-L6-v2, 23 MB)?"_
- Do not silently fall back to a different dimension — always surface dimension changes as rebuild-required.

---

### Phase 13 — Diagnostics and Observability

Add a lightweight diagnostics surface under **Embeddings → Advanced**.

Expose:
- Active model
- Active dimension
- Queue depth (pending jobs)
- Indexed note count
- Indexed block count
- Excluded note count
- Skipped unchanged note count (last reconcile)
- Last reconcile time
- Last rebuild time
- Model cache state (not downloaded / downloading / cached)
- Runtime health (uninitialized / loading / ready / error)
- Last error message
- Retryable failure count

This surface is primarily for debugging and support. It should be collapsed or behind a toggle by default to avoid overwhelming casual users.

---

### Phase 14 — Migration Strategy

Schema migration must be explicit and safe.

#### General migration rules

On plugin update:
- Detect current schema version stored in `embedding_config.schemaVersion`.
- Run migrations in sequence to reach schema v12.
- If old embedding rows lack required metadata (`model`, `dimension`, `contentHash`), mark the index incompatible.
- When incompatible, prompt the user to rebuild rather than attempting unsafe migration: _"Your embedding index is from an older version. Rebuild to continue?"_
- Prefer safe rebuild over clever migration if compatibility is uncertain.

#### Migration from the existing hardcoded `all-MiniLM-L6-v2` index

This is the concrete first-deploy scenario for all existing users upgrading to Plan 04.

The current production system has:
- A `note_embeddings` vec0 table at `float[384]` with MiniLM vectors.
- An `embedding_metadata` table with columns `rowid, notePath, model, contentHash, created, updated` — **no `dimension` column**.
- No `embedding_config` table.
- An `enableEmbeddings: boolean` user setting in `PluginTypes.ts` controlling whether the embedding system runs at all.

**v12 migration sequence (run by `SchemaMigrator` as version 12):**

1. DROP `embedding_metadata` (missing `dimension` column; cannot ALTER a vec0-linked table safely).
2. DROP `note_embeddings` (vec0 virtual table; cannot change dimensions without DROP+recreate).
3. CREATE new `note_embeddings` at the active model's dimension (default 768 for Nomic, 384 if user keeps MiniLM — determined by step 6 below).
4. CREATE new `embedding_metadata` with the full column set including `dimension`.
5. CREATE `block_embeddings`, `block_embedding_metadata`, `embedding_config` (genuinely new — use `IF NOT EXISTS`).
6. Add `KNOWN_TABLES` entries for all five new/recreated tables in `SchemaMigrator`.

**Post-migration user flow:**

After the migration runs, all embedding rows are gone (dropped in steps 1–2). The system detects the absence of `embedding_config` data → the index is empty.

Surface a migration notice: _"Your embedding index was built with an older version. The new default is `nomic-embed-text-v1.5` (768-dim). Rebuild to use the new model, or keep using Fast (all-MiniLM-L6-v2, 384-dim) without a full rebuild."_

- If the user selects Nomic → write `embedding_config` with `activeModel = Xenova/nomic-embed-text-v1.5`, `activeDimension = 768`, then trigger a full Rebuild (which re-embeds all notes at 768-dim after model download).
- If the user selects Fast (keep MiniLM) → write `embedding_config` with `activeModel = Xenova/all-MiniLM-L6-v2`, `activeDimension = 384`, then trigger a Rebuild at 384-dim (model already cached, no download needed).

**`enableEmbeddings` migration:**

Existing users who set `enableEmbeddings: false` opted out deliberately. Do not silently re-enable indexing for them. During migration, check `settings.enableEmbeddings`:
- If `false`: set `embedding_config.blockIndexingEnabled = 'false'`, do not trigger any rebuild, and show the Embeddings tab in a "disabled" state with a clear path to enable. Note that note-level indexing is always-on in the new architecture; this setting is effectively deprecated. Surface a one-time notice: _"Embedding indexing was previously disabled. The new Embeddings tab gives you full control. Enable when ready."_
- If `true` (default): proceed with the post-migration user flow above.

---

### Phase 15 — Initial Setup UX

On first use (no `embedding_config` and no existing index):
- Surface an onboarding notice (banner or status bar) pointing to the Embeddings tab. Do **not** auto-open the Embeddings tab — that is intrusive on plugin load.
- In the Embeddings tab, preselect `nomic-embed-text-v1.5` and display its size and offline benefits.
- Offer two explicit choices: `Start indexing now` or `Set up later`.
- If `Start indexing now`: begin model download (user-initiated), show progress as a banner or status bar update, then begin indexing and show progress.
- If `Set up later`: leave the index empty; a status bar indicator shows `⬡ Not indexed`.

**Plugin store compliance:** Obsidian's plugin guidelines require that all network activity and large downloads are user-initiated and clearly communicated. The 274 MB model download must **never** start automatically on plugin load or first install — it must only begin after the user explicitly clicks `Start indexing now` (or an equivalent action in the Embeddings tab). This applies even when the user has previously used the plugin on another device: do not treat a missing model cache as a reason to auto-download.

This reduces confusion around the first 274 MB download and first index build.

---

### Phase 16 — SearchManager `findRelated` Tool

Add the `findRelated` tool to `SearchManager`. This is the MCP-exposure phase for the semantic index.

**Tool ID:** `searchManager_findRelated`

**When available:** after Phase 2 (reconciliation) and Phase 5 (note + block indexing) are complete.

**Input schema (canonical — Plan 05 Phase 11 must match this):**

```typescript
{
  notePath?: string;   // find related to this vault note; mutually exclusive with query
  query?: string;      // free-text semantic query; mutually exclusive with notePath
  mode?: 'notes' | 'blocks';  // default 'notes'; 'blocks' requires block indexing enabled
  limit?: number;      // default 10, max 50
  minScore?: number;   // minimum cosine similarity threshold, 0–1; default 0 (no filter)
}
```

**Output schema (canonical — Plan 05 Phase 11 must match this):**

```typescript
{
  success: true;
  mode: 'notes' | 'blocks';
  total: number;
  results: Array<{
    path: string;         // vault-relative note path
    title: string;        // display name (filename without extension)
    score: number;        // cosine similarity, 0–1
    preview?: string;     // block mode: matched chunk excerpt; note mode: opening excerpt
    heading?: string;     // block mode only — nearest heading above the chunk
    chunkIndex?: number;  // block mode only — chunk position within the note
  }>;
}
```

**Behavior rules:**
- `notePath` and `query` are mutually exclusive. Return `{ success: false, error: "Provide notePath or query, not both." }` if both are given.
- At least one of `notePath` or `query` must be provided. Return `{ success: false, error: "Provide notePath or query." }` if neither is given.
- `mode: 'blocks'` returns `{ success: false, error: "Block indexing is disabled." }` if block indexing is disabled.
- `minScore` filters out results below the threshold after retrieval; does not affect ranking.
- All results pass `shouldIndex()` — excluded notes never appear.
- Uses the same scoring pipeline as the UI retrieval paths (cosine, L2-normalized vectors).

---

## Files to Change

| File | Change |
|------|--------|
| `src/services/embeddings/EmbeddingEngine.ts` | **Rename → `EmbeddingRuntime.ts` + major update** — existing class is the iframe transport wrapper; rename it and extend with multi-model support, `Platform.isDesktop` guard, `@huggingface/transformers` CDN URL, download/cache management, and multi-state runtime health; delegates text prep to `EmbeddingPreprocessor` |
| `src/services/embeddings/EmbeddingIframe.ts` | **Update** — already implements blob-URL iframe + postMessage transport; update CDN URL from `@xenova/transformers@2.17.2` to `@huggingface/transformers` (latest stable); add `Platform.isDesktop` guard in `initialize()` |
| `src/services/embeddings/EmbeddingPreprocessor.ts` | **New** — stateless model-specific text prep (`prepareText()`) and output post-processing (`postProcess()`); called by `EmbeddingRuntime` only; replaces the preprocessing responsibility that was mistakenly attributed to `EmbeddingEngine` in earlier drafts |
| `src/services/embeddings/EmbeddingManager.ts` | **Delete** — replaced entirely by `EmbeddingIndexCoordinator`; remove all callers before deleting |
| `src/services/embeddings/EmbeddingWatcher.ts` | **Delete** — replaced by `EmbeddingIndexCoordinator`'s vault event handling; uses raw `EventRef[]` without `Component` lifecycle (event leak), exactly the anti-pattern Plan 04 addresses |
| `src/services/embeddings/EmbeddingIndexCoordinator.ts` | **New** — extends `Component`; registered via `plugin.addChild()`; startup reconciliation, vault event handling via `this.registerEvent()`, job queue with coalescing, maintenance orchestration |
| `src/services/embeddings/EmbeddingExclusionService.ts` | **New** — all four exclusion layers, `shouldIndex()` composition, re-evaluation on settings change |
| `src/services/embeddings/NoteChunker.ts` | **New** — heading-aware chunking for note embedding; separate from `ContentChunker` |
| `src/services/embeddings/NoteEmbeddingService.ts` | **Update** — add block upsert/remove/rename, block similarity search, `dimension` column support, index stats, cleanup |
| `src/services/embeddings/EmbeddingStatusBar.ts` | **Update** (already exists) — extend with block count, excluded count, stale state display, and indexing progress states for multi-model support |
| `src/database/SQLiteCacheManager.ts` | Schema v12 migration: note_embeddings, embedding_metadata, block_embeddings, block_embedding_metadata, embedding_config; pre-Plan-04 migration detection |
| `src/settings/tabs/EmbeddingsTab.ts` | **New** — dedicated Embeddings settings tab with all sections from Phase 9 |
| `src/settings/tabs/DefaultsTab.ts` | Remove `enableEmbeddings` toggle and embeddings section; add pointer to Embeddings tab |
| `src/settings/SettingsRouter.ts` | Add `'embeddings'` to `SettingsTab` union type |
| `src/settings/SettingsView.ts` | Add `{ key: 'embeddings', label: 'Embeddings' }` to `tabConfigs`; add `renderEmbeddingsTab()` method and switch case |
| `src/database/schema/SchemaMigrator.ts` | Add v12 migration (DROP+recreate `note_embeddings`/`embedding_metadata`, CREATE new tables); update `KNOWN_TABLES` set |
| `src/agents/searchManager/tools/findRelated.ts` | **New** — `findRelated` MCP tool using retrieval contracts from Phase 6 |
| `src/agents/searchManager/searchManager.ts` | Register `findRelated` tool |
| `src/types/plugin/PluginTypes.ts` | Add: `localEmbeddingModel: string`, `enableBlockIndexing: boolean`, `embeddingExcludeFolders: string[]`, `embeddingExcludeGlobs: string[]`, `embeddingFrontmatterExclusions: string[]` |

---

## Dependencies

- No dependency on other plans.
- Plan 05 block mode depends on block indexing from Phase 5 of this plan.
- Plan 05 MCP features depend on reconciliation (Phase 2) and retrieval contracts (Phase 6) from this plan.
- Plan 05 side panel quick actions (Refresh, Rebuild) depend on maintenance actions from Phase 10.

### npm package required

**`minimatch`** must be added to `package.json` before Phase 11 (exclusion glob patterns) is implemented. Phase 11 uses `minimatch(notePath, pattern)` for glob-based exclusions. Verify it is not already present (`grep minimatch package.json`); if absent, run `npm install minimatch`. Pin to a specific version compatible with the project's existing Node.js target.

---

## Estimated Complexity

High.

- **Low effort**: score accuracy (Phase 7), status reporting (Phase 9 Overview section)
- **Medium effort**: startup reconciliation (Phase 2), block indexing schema + methods (Phase 5), exclusions (Phase 11), Embeddings tab UI (Phase 9), `findRelated` tool (Phase 16)
- **Medium-High effort**: native local model integration (Phase 8), model cache management (Phase 12), migration handling (Phase 14), `NoteChunker` (Phase 4)
- **High effort**: service boundary refactor (Phase 1), live lifecycle queue (Phase 3), runtime hardening + iframe isolation (Phase 12), diagnostics (Phase 13)

---

## Notes for Nexus Integration

Because this is added into Nexus as a side-panel semantic system, the semantic index must be treated as a **shared service layer**, not panel-local state.

That means:
- The side panel consumes search/index services; it does not own index lifecycle.
- Reconciliation and file-watch processing continue even when the panel is closed.
- The Embeddings tab becomes the control plane for the subsystem.
- The panel focuses on presenting note-level and block-level semantic results, scores, and quick actions.

This separation will make the semantic panel easier to evolve in later plans without touching core indexing logic.
