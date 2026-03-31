# Plan 04 — Semantic Database: Persistence, Blocks & Multi-Backend
Last Updated: 2026-03-29

## Goal

Build a fast, reliable semantic index that is the foundation for everything in Plan 05. It must be:

- **Always ready** — backfills on startup, stays current via vault events
- **Block-aware** — indexes note paragraphs/sections alongside whole notes, enabling precise matches inside large files (the key gap vs Smart Connections block mode)
- **Accurately scored** — cosine similarity with proper normalization, not broken L2 approximation
- **Multi-backend** — local offline (no setup), Ollama (local server, recommended), or OpenAI API (cloud, opt-in)
- **Privacy-first** — local or Ollama is the default path; cloud is always opt-in
- **Selective** — users control exactly what gets indexed: folders, file patterns, frontmatter, and Obsidian's own excluded files list are all respected
- **MCP-exposed** — Claude can query the index via a new `findRelated` tool on `SearchManager`

This is a prerequisite for Plan 05 (Semantic Panel). Plan 05 block mode (Phase 6) requires Phase 2 of this plan.

---

## Current State

`NoteEmbeddingService` has:
- Content hash change detection — skips re-embedding unchanged notes ✓
- `findSimilarNotes(notePath, limit)` — KNN query (L2 distance) ✓
- `semanticSearch(query, limit)` — text query with recency/session reranking ✓
- `embedNote(notePath)` — single-note embed/update ✓

`ContentChunker` has:
- 500-char chunks, 100-char overlap, 50-char minimum — already used for conversation QA pairs ✓

**Gaps:**
1. No startup backfill — notes added while Obsidian was closed aren't indexed until opened
2. No block-level indexing — whole-note embeddings miss specific paragraphs in large files
3. L2 distance produces inaccurate similarity percentages (can go negative for dissimilar notes)
4. No UI visibility or manual rebuild control
5. Only one local model (`all-MiniLM-L6-v2`, hardcoded) — no model selection, no Ollama, no OpenAI
6. No file, folder, or frontmatter-based exclusion — every `.md` file in the vault is indexed including templates, daily notes, archived content
7. Obsidian's own "Excluded files" setting (`userIgnoreFilters`) is completely ignored
8. Semantic index is invisible to MCP — Claude cannot query related notes

---

## Implementation Plan

### Phase 1 — Startup Backfill

In `EmbeddingWatcher`, after `app.workspace.onLayoutReady()`, run a background pass over the full vault:

```typescript
async backfillMissingNotes(): Promise<void> {
  const files = this.app.vault.getMarkdownFiles();
  for (let i = 0; i < files.length; i++) {
    // embedNote checks content hash — only re-embeds if new or changed
    await this.noteEmbeddingService.embedNote(files[i].path);
    if (i % 10 === 0) await sleep(0); // yield to event loop every 10 files
    this.eventBus.emit('embedding:backfill-progress', { current: i + 1, total: files.length });
  }
}
```

Run only after layout is ready. Progress events feed the status bar (Phase 7) and settings UI (Phase 4).

---

### Phase 2 — Block-Level Indexing

**Why this matters**: A whole-note embedding for a 5,000-word note on "productivity" matches everything tangentially related. A paragraph-level embedding for the section on "deep work" matches only deep work content. Smart Connections uses block mode as one of its headline features — Nexus needs parity here, and the infrastructure (`ContentChunker`) already exists.

**New SQLite tables** (schema v10, alongside existing `note_embeddings`):

```sql
CREATE VIRTUAL TABLE block_embeddings USING vec0(
  embedding float[384]
);

CREATE TABLE block_embedding_metadata (
  rowid          INTEGER PRIMARY KEY,
  notePath       TEXT NOT NULL,
  chunkIndex     INTEGER NOT NULL,
  charOffset     INTEGER NOT NULL,
  contentHash    TEXT NOT NULL,
  contentPreview TEXT,        -- first 150 chars of chunk (shown in panel block mode)
  model          TEXT NOT NULL,
  created        INTEGER NOT NULL,
  updated        INTEGER NOT NULL,
  UNIQUE(notePath, chunkIndex)
);
CREATE INDEX idx_bem_notePath ON block_embedding_metadata(notePath);
```

**New methods on `NoteEmbeddingService`:**

```typescript
async embedNoteBlocks(notePath: string): Promise<void> {
  const file = this.app.vault.getFileByPath(notePath);
  if (!file) return;
  const content = await this.app.vault.cachedRead(file);
  const chunks = this.contentChunker.chunk(content);

  for (const chunk of chunks) {
    const hash = hashContent(chunk.text);
    const existing = await this.getBlockHash(notePath, chunk.chunkIndex);
    if (existing === hash) continue; // unchanged chunk, skip
    const embedding = await this.embeddingEngine.generateEmbedding(chunk.text);
    await this.saveBlockEmbedding(notePath, chunk, hash, embedding);
  }
  // Remove stale chunks (note was shortened or restructured)
  await this.pruneStaleBlocks(notePath, chunks.length);
}

async findSimilarBlocks(notePath: string, limit = 20): Promise<SimilarBlock[]> {
  const noteEmbedding = await this.getNoteEmbedding(notePath);
  if (!noteEmbedding) return [];

  const rows = await this.db.query<BlockRow>(`
    SELECT
      bm.notePath,
      bm.chunkIndex,
      bm.charOffset,
      bm.contentPreview,
      vec_distance_cosine(be.embedding, ?) as distance
    FROM block_embeddings be
    JOIN block_embedding_metadata bm ON bm.rowid = be.rowid
    WHERE bm.notePath != ?
    ORDER BY distance
    LIMIT ?
  `, [noteEmbedding, notePath, limit * 3]); // 3x headroom for deduplication

  // Deduplicate: keep best-scoring block per note (same as conversation search pairId dedup)
  const bestByNote = new Map<string, BlockRow>();
  for (const row of rows) {
    const existing = bestByNote.get(row.notePath);
    if (!existing || row.distance < existing.distance) bestByNote.set(row.notePath, row);
  }

  return Array.from(bestByNote.values())
    .slice(0, limit)
    .map(r => ({ ...r, score: 1 - r.distance }));
}
```

`embedNote()` must call `embedNoteBlocks()` in tandem — both note-level and block-level stay in sync.

---

### Phase 3 — Score Accuracy

**Problem**: `vec_distance_l2()` returns Euclidean distance. `(1 - distance) * 100` is wrong — L2 distance can exceed 1.0, producing negative percentages.

**Fix A — Switch to cosine** (preferred): Replace `vec_distance_l2` with `vec_distance_cosine` in all KNN queries across `findSimilarNotes`, `findSimilarBlocks`, and `semanticSearch`. Cosine distance is bounded `[0, 1]`; `score = 1 - distance` gives a true similarity percentage that displays correctly in the panel.

**Fix B — Adaptive normalization** (fallback if cosine unavailable): Proven approach from Smart Connections — scale scores until the best result is clearly visible:

```typescript
function normalizeScores<T extends { score: number }>(results: T[]): T[] {
  while (results.length && !results.some(r => r.score > 0.5)) {
    results.forEach(r => r.score *= 2);
  }
  return results;
}
```

Apply Fix A and Fix B together — cosine gives accuracy, normalization gives readability.

---

### Phase 4 — Rebuild Command + Settings UI

**Settings panel** (in `DefaultsTab` or new `EmbeddingsTab`):

```
Semantic Index
──────────────────────────────────────────────
Notes indexed:   247 / 312       Blocks: 1,840
Last full index: 2026-03-28 14:22
Embedding model: Local (all-MiniLM-L6-v2)

[Rebuild Index]   [Clear Index]

ℹ Rebuilding re-embeds all notes and blocks from scratch.
  Changing the embedding model requires a full rebuild.
```

**`[Rebuild Index]`** button:
1. Calls `NoteEmbeddingService.clearAllEmbeddings()` — clears `note_embeddings`, `embedding_metadata`, `block_embeddings`, `block_embedding_metadata`
2. Triggers `backfillMissingNotes()` — full re-embed, note + block level
3. Shows live progress via EventBus

**`[Clear Index]`** deletes all embeddings without rebuilding — for freeing space or switching models.

**New methods:**
```typescript
clearAllEmbeddings(): Promise<void>
getIndexStats(): Promise<{ noteCount: number; blockCount: number; lastIndexed: number | null }>
```

Register command: `Nexus: Rebuild semantic index`

---

### Phase 5 — Local Model Selection + Multi-Backend

#### Local Model Tiers

The iframe already passes `MODEL_ID` to Transformers.js — switching local models is a string change, but each model has different tradeoffs users should understand. Offer four curated tiers rather than a free-text field:

| Tier | Model | Dim | Size | MTEB | Context | Notes |
|------|-------|-----|------|------|---------|-------|
| Fast | `Xenova/all-MiniLM-L6-v2` | 384 | 23 MB | 49.0 | 512 tok | Legacy option; lowest friction, smallest download |
| Balanced | `Xenova/bge-small-en-v1.5` | 384 | 33 MB | 51.7 | 512 tok | Good quality/size tradeoff; same dim as Fast |
| **Quality** | **`Xenova/nomic-embed-text-v1.5`** | **768** | **274 MB** | **62.4** | **8192 tok** | **Default** — best retrieval quality; 8K context means full notes never truncated |
| Multilingual | `Xenova/multilingual-e5-small` | 384 | 118 MB | 46.1 | 512 tok | 100+ languages; suggest if vault has >10% non-ASCII content |

**Why `nomic-embed-text-v1.5` as the default**: The 8,192-token context window is the decisive factor for a PKM tool. All-MiniLM and bge-small truncate at ~512 tokens (~380 words) — a detailed research note, meeting summary, or long essay gets its tail silently cut, so the embedding only represents the opening paragraphs. Nomic handles full notes intact. It also leads the MTEB retrieval benchmark at 62.4 (vs 51.7 for bge-small, 49.0 for MiniLM). The 274MB download happens once and caches in IndexedDB — for most users this is a one-time cost well worth the quality gain. Requires `"search_document: "` prefix on indexed text and `"search_query: "` prefix on queries — handled inside `EmbeddingEngine` transparently.

**Model preprocessing per model** — encapsulated in `EmbeddingEngine`:
```typescript
private prepareText(text: string, role: 'document' | 'query'): string {
  switch (this.settings.localEmbeddingModel) {
    case 'Xenova/nomic-embed-text-v1.5':
      return role === 'query' ? `search_query: ${text}` : `search_document: ${text}`;
    case 'Xenova/multilingual-e5-small':
    case 'Xenova/multilingual-e5-base':
      return role === 'query' ? `query: ${text}` : `passage: ${text}`;
    default:
      return text; // MiniLM, bge-small — no prefix needed
  }
}
```

**Auto-suggest multilingual on first setup**: Check `app.vault.getMarkdownFiles()` for a sample of files, count non-ASCII characters. If >10% of sampled content is non-Latin script, surface a notice: _"Your vault appears to contain non-English content. The Multilingual model may give better results."_

#### Remote Backends

```typescript
type EmbeddingBackend = 'local' | 'ollama' | 'openai';
```

**Backend priority on first setup:**
1. Default to `local` with `nomic-embed-text-v1.5` (downloads on first embed, caches in IndexedDB)
2. Detect if Ollama is reachable (`GET /api/tags`) → offer `ollama` as an option, never force it
3. `openai` is opt-in — requires user to explicitly choose

**Ollama** (`POST /api/embeddings`):
- Models: `nomic-embed-text` (768-dim), `mxbai-embed-large` (1024-dim)
- Offline after initial model pull, no API key, high quality
- Use `ProviderHttpClient` consistent with other adapters
- `[Test Connection]` button

**OpenAI** (`POST /v1/embeddings`):
- Models: `text-embedding-3-small` (1536-dim), `text-embedding-3-large` (3072-dim)
- Batch up to 100 texts per API call
- Uses existing OpenAI API key from provider settings

#### Dimension Mismatch Handling

Store active backend + model + dimension in `embedding_config`. On startup, compare stored dimension against current model's dimension. On mismatch:
- **Same-dimension switch** (e.g. MiniLM → bge-small, both 384-dim): no rebuild needed — existing vectors remain valid. Silent upgrade.
- **Cross-dimension switch** (e.g. any 384-dim model → nomic at 768-dim, or vice versa): show a banner notice: _"Embedding model changed — rebuild the semantic index to restore full quality."_ Do not auto-rebuild (could take minutes on large vaults); let the user choose when. New installs with nomic as default have no existing index to worry about.

```sql
CREATE TABLE embedding_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys stored: embeddingDimension, backend, localModel, ollamaModel, lastRebuildAt
```

---

### Phase 6 — Embedding Settings UI

**Local model picker** — card-based, not a dropdown. Users need to see size and context window before downloading 274MB:

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

Models download on first use and cache locally (IndexedDB).
⚠ Switching to a different dimension requires rebuilding the index.
```

**Remote backend section** (shown only when user expands "Use a remote embedding server"):

```
── Ollama ─────────────────────────────────────────────
Server URL: [http://localhost:11434                    ]
Model:      [nomic-embed-text (768-dim) ▾             ]
[Test Connection]  ● Connected

── OpenAI API ─────────────────────────────────────────
Model:      [text-embedding-3-small (1536-dim) ▾      ]
Uses your configured OpenAI API key.
```

Store in `PluginSettings`:
```typescript
embeddingBackend: 'local' | 'ollama' | 'openai'; // default: 'local'
localEmbeddingModel: string;           // default: 'Xenova/nomic-embed-text-v1.5'
ollamaEmbeddingUrl: string;            // default: 'http://localhost:11434'
ollamaEmbeddingModel: string;          // default: 'nomic-embed-text'
openaiEmbeddingModel: string;          // default: 'text-embedding-3-small'
```

---

### Phase 7 — Status Bar Enhancement

Extend existing `EmbeddingStatusBar`:

| State | Display |
|-------|---------|
| Idle | `⬡ 312 notes · 1,840 blocks` |
| Backfilling notes | `⬡ Indexing notes… 47/312` |
| Indexing blocks | `⬡ Indexing blocks… 420/1,840` |
| Error | `⬡ Index error` (click opens settings) |
| Paused | `⬡ Indexing paused` |

---

### Phase 8 — Exclusion Settings (Files, Folders, Patterns, Frontmatter)

Currently every `.md` file in the vault is indexed — templates, daily notes, archived content, scratch files. This is wrong. Users need layered control over what enters the semantic index.

Four exclusion layers compose in order:

#### Layer 1 — Respect Obsidian's Built-in Excluded Files

Obsidian has its own "Excluded files" setting (`Settings → Files and links → Excluded files`). It stores a list of paths/patterns in `app.vault.config.userIgnoreFilters`. These files are already excluded from Obsidian's search, graph, and backlinks — the semantic index should respect the same list automatically, with zero extra configuration.

```typescript
private isObsidianExcluded(notePath: string): boolean {
  const filters: string[] = (this.app.vault as any).config?.userIgnoreFilters ?? [];
  return filters.some(filter => {
    // Obsidian filters are glob patterns or plain folder prefixes
    return notePath.startsWith(filter) || minimatch(notePath, filter);
  });
}
```

This is free — no settings UI needed. Just call it in `shouldIndex()`.

#### Layer 2 — Folder Exclusion

Pick entire folders to exclude. Everything under an excluded folder is skipped.

**Settings UI:**
```
Excluded Folders
──────────────────────────────────────────────
Folders to exclude from the semantic index:
  📁 Templates/
  📁 Daily Notes/
  📁 Archive/2023/
                            [+ Add Folder]
```

`[+ Add Folder]` opens Obsidian's standard folder picker (`new FolderSuggest`). Excluded folders are stored as vault-relative paths.

**Implementation:**
```typescript
private isInExcludedFolder(notePath: string): boolean {
  return this.settings.embeddingExcludeFolders.some(folder => {
    const normalized = folder.endsWith('/') ? folder : folder + '/';
    return notePath.startsWith(normalized);
  });
}
```

#### Layer 3 — File Pattern Exclusion

Glob-style patterns for more surgical exclusion. Handles cases like daily notes in a shared folder, excalidraw files, or template files with a naming convention.

**Settings UI:**
```
Excluded File Patterns
──────────────────────────────────────────────
Glob patterns — one per line:
[Daily Notes/????-??-??.md               ]
[*.excalidraw.md                          ]
[_templates/**                            ]
[Inbox/scratch-*.md                       ]
```

**Implementation** — uses the same `minimatch` library already available in Node/Electron:
```typescript
private matchesExcludePattern(notePath: string): boolean {
  return this.settings.embeddingExcludePatterns.some(pattern =>
    minimatch(notePath, pattern, { matchBase: false })
  );
}
```

#### Layer 4 — Frontmatter Exclusion

Exclude notes based on YAML frontmatter key-value pairs. Useful for per-note opt-out without moving files.

**Settings UI:**
```
Excluded Frontmatter
──────────────────────────────────────────────
Skip notes matching frontmatter (one per line):
[status: archived                             ]
[private: true                                ]
[draft: true                                  ]
[nexus-index: false                           ]
```

**Implementation:**
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

#### Composing All Layers

A single `shouldIndex(notePath)` gate is called before any embedding write, and before any KNN result is returned:

```typescript
shouldIndex(notePath: string): boolean {
  return (
    !this.isObsidianExcluded(notePath) &&       // Layer 1: Obsidian's own list
    !this.isInExcludedFolder(notePath) &&        // Layer 2: folder exclusions
    !this.matchesExcludePattern(notePath) &&     // Layer 3: glob patterns
    !this.matchesFrontmatterExclusion(notePath)  // Layer 4: frontmatter
  );
}
```

`shouldIndex()` is called in:
- `embedNote()` / `embedNoteBlocks()` — skip indexing entirely
- `backfillMissingNotes()` — skip during startup backfill
- `findSimilarNotes()` / `findSimilarBlocks()` — post-filter results so excluded notes never appear as connections, even if they were previously indexed before the exclusion was added
- `EmbeddingWatcher` vault event handlers — skip `modify`/`create` events for excluded paths

**Store in `PluginSettings`:**
```typescript
embeddingExcludeFolders: string[];          // default: []
embeddingExcludeGlobs: string[];            // default: []
embeddingFrontmatterExclusions: string[];   // default: []
// Layer 1 (Obsidian excluded files) requires no setting — reads app.vault.config
```

**Stats impact**: The index stats display (Phase 4) should show: _"247 / 312 notes indexed (65 excluded)"_ so users understand why the counts don't match their vault file count.

---

## Files to Change

| File | Change |
|------|--------|
| `src/services/embeddings/EmbeddingEngine.ts` | Parameterize `MODEL_ID`; add `prepareText()` per-model prefix logic; add Ollama + OpenAI backends; multilingual auto-suggest |
| `src/services/embeddings/NoteEmbeddingService.ts` | Add `embedNoteBlocks()`, `findSimilarBlocks()`, `clearAllEmbeddings()`, `getIndexStats()`, cosine queries, `shouldIndex()` gate |
| `src/services/embeddings/EmbeddingExclusionService.ts` | New — all four exclusion layers, `shouldIndex()` composition |
| `src/services/embeddings/EmbeddingWatcher.ts` | `backfillMissingNotes()` with progress events; trigger block indexing; call `shouldIndex()` before processing vault events |
| `src/services/embeddings/EmbeddingStatusBar.ts` | Show note + block counts; excluded count; indexing progress states |
| `src/database/SQLiteCacheManager.ts` | Add `block_embeddings`, `block_embedding_metadata`, `embedding_config` tables; schema v10 migration |
| `src/settings/tabs/DefaultsTab.ts` (or new `EmbeddingsTab.ts`) | Local model card picker; remote backend config; rebuild button; index stats; all three exclusion UIs (folder picker, glob patterns, frontmatter) |
| `src/types/plugin/PluginTypes.ts` | Add `localEmbeddingModel`, `embeddingBackend`, `ollamaEmbeddingUrl`, `ollamaEmbeddingModel`, `openaiEmbeddingModel`, `embeddingExcludeFolders`, `embeddingExcludeGlobs`, `embeddingFrontmatterExclusions` |

## Dependencies
- No dependency on other plans
- **Plan 05 Phase 6 (Notes/Blocks toggle) requires Phase 2 of this plan**
- **Plan 05 Phase 9 (MCP `findRelated` tool) can be built after Phase 1 of this plan**

## Estimated Complexity
Medium-High.
- **Low effort**: Phases 1 (backfill), 3 (cosine fix), 7 (status bar)
- **Medium effort**: Phase 2 (block indexing — schema + methods, but `ContentChunker` exists); Phase 8 (exclusion layers — new service, folder picker UI, glob matching)
- **Medium-High effort**: Phase 5 (multi-backend + local model selection — dimension mismatch, per-model text preprocessing, Ollama connection detection)
- **Low effort**: Phase 6 (settings UI — card layout is new but straightforward)
