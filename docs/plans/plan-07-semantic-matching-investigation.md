# Plan 07: Semantic Matching Investigation
**Status**: Root cause confirmed, fix not yet implemented  
**Branch**: local-fixes  
**Started**: 2026-04-02  
**Updated**: 2026-04-02 (after SmartConnections bundle analysis)  
**Goal**: Understand why SmartConnections (TaylorAI/bge-micro-v2) produces better semantic matches than Nexus (Nomic embed v1.5) and identify a concrete fix.

---

## Root cause: confirmed via SmartConnections bundle analysis

SmartConnections was installed and its bundled `main.js` examined directly. The jsbrains packages (smart-sources, smart-embed-model, smart-chunks, smart-entities) are all inlined in this file.

**Primary root cause** — `main.js` line 5859–5863:

```javascript
// SmartSource.get_embed_input()
const breadcrumbs = this.path.split("/").join(" > ").replace(".md", "");
const max_tokens = this.collection.embed_model.model.data.max_tokens || 500;  // → 512
const max_chars = Math.floor(max_tokens * 3.7);  // → 1894 chars
this._embed_input = `${breadcrumbs}:\n${content}`.substring(0, max_chars);
```

Every note embedding input is: `"01-Areas > Health > Cortisol:\n{raw file content}"`.

Every block embedding input — `main.js` line 17301–17304:
```javascript
// SmartBlock.get_embed_input()
this._embed_input = this.breadcrumbs + "\n" + content;
// breadcrumbs = key.split("/").join(" > ").split("#").slice(0,-1).join(" > ").replace(".md","")
// e.g. "01-Areas > Health > Cortisol > Overview"
```

**Nexus embeds**: `"{processed note content}"` — no path, no title, nothing.

This is the entire quality gap. The folder hierarchy and note title anchor every embedding in its semantic domain. Without them, a note about "Cortisol" and a note about "Adrenaline" share nearly identical structural embeddings. With them, the model immediately distinguishes health topics from finance topics from project notes.

---

## Full verified diff: SmartConnections vs Nexus

All items below verified against `main.js` source.

### 1. Embed input construction

| | SmartConnections | Nexus |
|--|-----------------|-------|
| **Source (note-level)** | `"01-Areas > Health > Cortisol:\n{raw content}"` | `"{preprocessed content}"` — title absent |
| **Block-level** | `"01-Areas > Health > Cortisol > Heading\n{block content}"` | `"Title: Cortisol\nHeading: Heading\nContent: {block content}"` |
| Title in source embed | ✅ always (last path segment) | ❌ absent unless note has H1 matching filename |
| Folder context | ✅ full path hierarchy | ❌ absent |
| Frontmatter included | ✅ raw YAML embedded (tags, dates, aliases all present) | ❌ stripped |
| Wikilinks | Verbatim `[[note name]]` | Resolved to display text |
| Char limit | 1894 (breadcrumbs + content combined) | 8000 (Nomic) / 2000 (MiniLM) — content only |

### 2. Task prefix

| | SmartConnections | Nexus |
|--|-----------------|-------|
| Document prefix | **None** — `prepare_embed_input()` only trims tokens | `"search_document: "` (Nomic) |
| Query prefix | None | `"search_query: "` (Nomic) |

`main.js` line 9949–9962 confirms: `prepare_embed_input` does no prefix injection whatsoever. SC's bge-micro-v2 receives natural-language text with no task instruction prefix. The entire SC/Nexus prefix debate has been a red herring.

### 3. Similarity computation

SC `main.js` line 26279–26284:
```javascript
function cos_sim(vector1, vector2) {
  let dot_product = 0, magnitude1 = 0, magnitude2 = 0;
  for (let i = 0; i < vector1.length; i++) {
    dot_product += vector1[i] * vector2[i];
    magnitude1 += vector1[i] * vector1[i];
    magnitude2 += vector2[i] * vector2[i];
  }
  return dot_product / (Math.sqrt(magnitude1) * Math.sqrt(magnitude2));
}
```

Full cosine similarity — does NOT assume L2-normalized vectors. Robust to any numerical precision issues. Nexus uses `vec_distance_cosine` in sqlite-vec which produces equivalent results when vectors ARE L2-normalized (as they are from the pipeline).

### 4. Score rescaling

SC applies `while(!results.some(r => r.score > 0.5)) { results.forEach(r => r.score *= 2); }` after ranking. This is a UI presentation hack only — ranking is not affected. With better embeddings (breadcrumbs included), raw scores should be higher and this loop fires less often.

### 5. Minimum content length

| | SmartConnections | Nexus |
|--|-----------------|-------|
| Min chars | **300** (from `smart_env.json`) | 50 (default) |

SC only indexes notes with at least 300 chars of content (raw, including frontmatter). This means very short notes are excluded from SC's index, reducing noise. Nexus indexes from 50 chars.

---

## History of failed attempts (before bundle analysis)

| Commit | Change | Why it didn't fix the problem |
|--------|--------|-------------------------------|
| `b9caa26f` | Nomic documentPrefix: `null` → `clustering:` | Wrong variable. Missing breadcrumbs were the real issue. |
| `b9caa26f` | Nomic documentPrefix: `clustering:` → `search_document:` | Same — wrong variable. Both prefix states were tried; neither fixed the gap. |
| `7db78a25` | Preserve newlines in preprocessContent | Correct structural fix but not the quality differentiator. |
| `7db78a25` | Raise truncation limit 2000 → 8000 chars | Helps for very long notes; most notes are under 2000 chars anyway. |
| `9aa72624` | Model-safe queries (AND model=?) | Correctness fix, not quality fix. |
| `9aa72624` | Configurable boost weights, feedback re-ranking | Marginal improvement; adding signal on top of weak embeddings. |

**Key lesson**: Multiple prefix changes were tried (null → clustering: → search_document:) without improvement because the prefix was the wrong variable. The missing breadcrumbs were the root cause throughout.

---

## The fix

### Primary fix: add breadcrumbs to note-level embeddings

In `NoteEmbeddingService.embedNote()`, change the text fed to `embedDocument()`:

```typescript
// Current — no context:
const processedContent = preprocessContent(content, this.runtime.maxChars);
const embedding = await this.runtime.embedDocument(processedContent);

// Fix — prepend breadcrumbs (matches SC's exact pattern):
const processedContent = preprocessContent(content, this.runtime.maxChars);
const basename = notePath.replace(/\.md$/, '');
const breadcrumbs = basename.split('/').join(' > ');
const embeddingInput = `${breadcrumbs}:\n${processedContent}`;
const embedding = await this.runtime.embedDocument(embeddingInput);
```

This is a **one-location change** in `embedNote()`. Block embeddings already include title+heading context via `buildEnrichedText()` in `NoteChunker.ts` — their format is different from SC's but functionally equivalent on the title signal. Block breadcrumbs are a secondary improvement.

**Requires full index rebuild**: Content hash changes for every note (breadcrumbs are now part of the hashed input indirectly via embedding). The model ID doesn't change, so `recreateEmbeddingTables()` won't fire automatically — need to call `clearAllEmbeddings()` or add a migration.

### Secondary consideration: prefix

After adding breadcrumbs, consider whether `search_document:` still makes sense. SC uses no prefix with bge-micro-v2 and the breadcrumbs provide the context. For Nomic, the prefix has a more complex interaction with the model's training. Testing is needed after the breadcrumbs fix is in place to determine if removing `search_document:` further improves results.

---

## The model: TaylorAI/bge-micro-v2 (confirmed)

`smart_env.json` confirms: `"model_key": "TaylorAI/bge-micro-v2"`, `"dims": 384`, `"max_tokens": 512`.

| Property | Value |
|----------|-------|
| Dimensions | 384 |
| Max tokens | 512 (~1894 chars including breadcrumbs) |
| Parameters | 17.4M |
| Quantized size | ~17.4 MB |
| Document prefix | None |
| Query prefix | Optional |
| License | Open, no HF token required |
| Transformers.js native | No official Xenova mirror exists |

Adding this model to `EmbeddingModelCatalog.ts` would let users run the exact same model as SmartConnections. See memory entry `project_bge_micro_v2_research.md` for the catalog entry pattern.

Nearest existing catalog alternative: `Xenova/bge-small-en-v1.5` (`documentPrefix: null`, symmetric, 384-dim, 25MB).

---

## Files involved in the fix

| File | Change needed |
|------|---------------|
| [NoteEmbeddingService.ts](../../src/services/embeddings/NoteEmbeddingService.ts) | Add breadcrumbs prefix in `embedNote()` before `embedDocument()` |
| [EmbeddingModelCatalog.ts](../../src/services/embeddings/EmbeddingModelCatalog.ts) | Optionally add `TaylorAI/bge-micro-v2` entry |
| [EmbeddingManager.ts](../../src/services/embeddings/EmbeddingManager.ts) | Trigger `clearAllEmbeddings()` + rebuild after this change |

Secondary (if block breadcrumbs also updated):
| [NoteChunker.ts](../../src/services/embeddings/NoteChunker.ts) | Update `buildEnrichedText()` to use path-style breadcrumbs |

---

## LCSH Pipeline Compatibility (bge-base-en-v1.5)

**Question**: Can `Xenova/bge-base-en-v1.5` replace Nomic for BOTH the Semantic Panel AND the LCSH tagging pipeline?

**Short answer**: Yes technically, but Option A (breadcrumbs + keep Nomic) is the recommended path. See decision below.

### What would need to change in lcsh-concept-index.js

Two changes only:
1. Model ID: `Xenova/nomic-embed-text-v1.5` → `Xenova/bge-base-en-v1.5`
2. Remove `search_document: ` prefix from heading text composition (bge-base is symmetric, no task prefix)

`lcsh-semantic-match.js` — **zero changes needed**: dimension stays 768, KNN/FTS weights unchanged, shadow table reads unchanged.

### The LCSH-specific tradeoff: long-note coverage

`lcsh-semantic-match.js` reads **note-level** embeddings from cache.db. Token limits per model:

| Model | Max tokens | Approx note content chars (after breadcrumbs) |
|-------|-----------|----------------------------------------------|
| Nomic | 8192 | ~7,900 |
| bge-base-en-v1.5 | 512 | ~1,700 |

User has long notes. With bge-base, only the first ~1,700 chars of note content drives the LCSH heading match. Content deep in the body — often the most LCSH-relevant subject matter — is invisible to the matcher. Nomic was selected for LCSH precisely because 8192 tokens lets the full note drive the query vector. The "symmetric matching compromise" (`search_document:` for both sides) was accepted as the lesser cost.

### Decision: Two viable options

**Option A — Minimum fix, recommended (breadcrumbs + keep Nomic)**
- Add breadcrumbs to `NoteEmbeddingService.embedNote()`, keep Nomic model
- LCSH pipeline: zero changes, no lcsh_vectors.db rebuild
- Nexus note/block rebuild required (breadcrumbs change content hashes) — but this was happening anyway
- Risk: none. LCSH pipeline fully operational after Nexus rebuild completes.

**Option B — Full model switch (bge-base-en-v1.5 for both)**
- Better symmetric matching quality for Semantic Panel
- lcsh-concept-index.js: two code changes + lcsh_vectors.db full rebuild (~50-65 min)
- LCSH matching quality degrades for long notes (512-token truncation)
- Only worthwhile if Option A quality is demonstrably insufficient after testing

**Recommended**: Implement Option A first. Test Semantic Panel quality. Revisit Option B only if the symmetric encoding gap still matters after breadcrumbs are in place.

---

## Source files examined

| File | Purpose |
|------|---------|
| `C:\Users\middl\Documents\Obsidian\Michael\.obsidian\plugins\smart-connections\main.js` | Full bundled plugin (1.2MB) — contains all jsbrains packages |
| `C:\Users\middl\Documents\Obsidian\Michael\.smart-env\smart_env.json` | SmartConnections configuration — confirms model, min_chars, block indexing |
| `C:\Users\middl\Documents\Obsidian\Michael\.smart-env\multi\*.ajson` | Per-note stored embeddings with 384-dim vectors |
| `C:\Users\middl\Documents\Obsidian\Michael\.smart-env\embedding_models\embedding_models.ajson` | Model registry — confirms TaylorAI/bge-micro-v2, dims=384, max_tokens=512 |
