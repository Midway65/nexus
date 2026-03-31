# Plan 05 — Semantic Panel: Connections, Search & Chat
Last Updated: 2026-03-29

## Goal

A Nexus-native semantic discovery panel that is a **superset** of Smart Connections:

- **Parity with Smart Connections**: sidebar panel, block mode, drag-to-link, pin/hide per connection, score normalization, frontmatter filtering, random related note
- **Nexus-unique features**: Send to Chat (inject related notes as conversation context), conversation cross-reference (show conversations that discussed this note), deep reranking (recency + session density, not just similarity), MCP `findRelated` tool (Claude can query the index)

The panel is not a clone — it extends semantic discovery into Nexus's existing chat, memory, and MCP ecosystems. Smart Connections cannot do any of the Nexus-unique features.

**Prerequisites**: Plan 04 (Phases 1–3 minimum) must be complete.

---

## Panel Layout

```
┌──────────────────────────────────────────────┐
│ 🔮 Nexus Connections      [🔍] [↻] [⚙]      │  ← header
├──────────────────────────────────────────────┤
│ Active: "Deep Work Strategies"               │  ← current file context
│ Notes ●  Blocks ○                            │  ← mode toggle
├──────────────────────────────────────────────┤
│ 📌 Notes/Pinned/Always Show.md      96%  ⋮  │  ← pinned row (always top)
│ ▶ Notes/Research/Flow State.md      91%  ⋮  │  ← collapsed row + menu button
│ ▼ Notes/Projects/Q2 Focus.md        87%  ⋮  │  ← expanded row
│   ┌────────────────────────────────────────┐ │
│   │ # Q2 Focus                             │ │  ← read-only markdown preview
│   │ Key objectives for Q2…                 │ │
│   │                                        │ │
│   │ [💬 Send to Chat]  [🔗 Link]           │ │  ← primary + secondary action
│   └────────────────────────────────────────┘ │
│ ▶ Notes/Ideas/Attention.md          82%  ⋮  │
│ ▶ Notes/Archive/Old Draft.md        71%  ⋮  │
│   ...                                        │
├──────────────────────────────────────────────┤
│ 💬 Referenced in 3 conversations             │  ← conversation cross-ref section
│ ▶ "Planning session" · 2 days ago            │
│ ▶ "Weekly review" · 5 days ago               │
├──────────────────────────────────────────────┤
│ Showing 10 of 312 indexed notes  [Show More] │
└──────────────────────────────────────────────┘
```

**Search mode** (activated by clicking 🔍):
```
├──────────────────────────────────────────────┤
│ 🔍 [Search your vault semantically...      ] │  ← query input
│ Notes ●  Blocks ○                            │
├──────────────────────────────────────────────┤
│ ▶ Notes/Research/Flow State.md      89%  ⋮  │
│ ...                                          │
```

---

## Similarity Score Display

- Use cosine distance from Plan 04 Phase 3: `score = Math.round((1 - distance) * 100)`
- Apply adaptive normalization: scale all scores until at least one exceeds 50%, so results always have visible differentiation
- Color-coded badge: ≥90% green, 75–89% yellow, <75% muted text

---

## Implementation Plan

### Phase 1 — View Registration

Follow the `TaskBoardUIManager` pattern exactly.

**New files:**
- `src/ui/semanticPanel/SemanticPanelView.ts` — extends `ItemView`
- `src/ui/semanticPanel/SemanticResultRow.ts` — result row component (note + block variants)
- `src/ui/semanticPanel/SemanticPanelNavigation.ts` — `openSemanticPanelView()` helper
- `src/core/ui/SemanticPanelUIManager.ts` — registers view + commands (mirrors `TaskBoardUIManager`)

**Constants** (in `src/constants/branding.ts`):
```typescript
export const SEMANTIC_PANEL_VIEW_TYPE = 'nexus-semantic-panel';
```

**Register in `PluginLifecycleManager`:**
```typescript
await this.semanticPanelUIManager.registerViewEarly();
```

**Ribbon icon**: `network` icon, opens/focuses the panel.

**Commands registered:**
- `Nexus: Open Semantic Panel` — opens in right sidebar
- `Nexus: Open random related note` — weighted random from similar notes (Phase 10)

---

### Phase 2 — Active File Tracking + Results Loading

**Active file tracking** — debounced at 250ms to avoid flooding on rapid tab switches:

```typescript
this.registerEvent(
  this.app.workspace.on('active-leaf-change', () => {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.onActiveFileChange(), 250);
  })
);
```

`onActiveFileChange()`:
1. Get `this.app.workspace.getActiveFile()`
2. If null, not `.md`, or same as current — do nothing
3. If settings.autoRefresh is off — do nothing unless user manually refreshes
4. Otherwise — call `refreshResults(newFile.path)`

**Results loading** (note mode):
```typescript
async refreshResults(notePath: string): Promise<void> {
  this.setLoading(true);
  const raw = await this.noteEmbeddingService.findSimilarNotes(notePath, this.settings.resultCount * 2);
  const filtered = this.applyFeedbackFilter(raw);   // remove hidden, sort pinned to top
  const capped = filtered.slice(0, this.settings.resultCount);
  this.renderResults(capped, notePath);
  this.setLoading(false);
  // Load conversation cross-references in parallel (non-blocking)
  this.refreshConversationRefs(notePath);
}
```

**Empty state**: "This note hasn't been indexed yet — it will be indexed automatically when saved." with `[Index Now]` button that calls `noteEmbeddingService.embedNote(notePath)` immediately.

**Not indexed state** (embeddings disabled): "Enable embeddings in Settings → Semantic Index to use this panel."

---

### Phase 3 — Result Row Component

Each row is a `div.semantic-result-row` with three parts: header, preview pane (collapsed by default), action bar.

**Header** — always visible:
```
[📌 or ▶/▼] [file icon] Note title    [score badge]  [⋮ menu]
            Folder/path (muted, truncated)
```

**Drag-to-link** — primary link UX. SC uses this, it's more precise than append-to-both:
```typescript
row.setAttribute('draggable', 'true');
this.registerDomEvent(row, 'dragstart', (e: DragEvent) => {
  const file = this.app.vault.getFileByPath(this.result.notePath);
  if (file) this.app.dragManager.dragFile(e, file);
});
```
Dragging a result into the editor creates a `[[wikilink]]` exactly where the cursor is — no files modified automatically.

**Context menu** (⋮ button, right-click):
- Open note
- Insert link at cursor (uses `EditorInsertService` from Plan 03, or inline if Plan 03 not complete)
- Send to Chat (same as preview action)
- Pin — always show at top
- Hide — suppress from results
- Copy path

**Preview pane** (click row header to expand):
- Lazy-loaded — only reads file on first expand
- Shows first 600 chars rendered as markdown via `MarkdownRenderer.render()`
- Uses `vault.cachedRead()` — no disk I/O if already in memory

**Block mode variant**: Instead of file title, shows the `contentPreview` snippet as the row title, with the parent note path as subtitle. Score reflects block-level match quality.

---

### Phase 4 — Action Bar (Preview Pane Footer)

Two actions per result, ordered by importance:

**[💬 Send to Chat]** — PRIMARY action, Nexus-unique:
```typescript
private async onSendToChat(): Promise<void> {
  const file = this.app.vault.getFileByPath(this.result.notePath);
  if (!file) return;
  const content = await this.app.vault.cachedRead(file);
  // Emit to active chat view via EventBus
  this.eventBus.emit('chat:inject-context', {
    type: 'note',
    path: this.result.notePath,
    title: file.basename,
    content: content,
    score: this.result.score,
  });
  this.sendButton.textContent = '✓ Added to chat';
  this.sendButton.disabled = true;
}
```

The chat view subscribes to `chat:inject-context` and prepends the note content as a system-level context block in the next message, formatted as:

```
**Related note: [[Note Title]]** (similarity: 91%)
---
{note content}
---
```

This is what Smart Connections' "Send to Smart Context" does — but Nexus sends it into the live LLM conversation, not just a static context panel.

**[🔗 Link]** — SECONDARY action, bidirectional append:
- Appends `[[Active Note]]` to target, and `[[Target Note]]` to active note
- Uses `vault.process()` (atomic)
- Falls back gracefully to drag-to-link if user prefers
- Shows `✓ Linked` on completion

---

### Phase 5 — Dual-Mode Panel: Browse + Semantic Search

The 🔍 button in the header toggles Search mode. The panel becomes a semantic search box — identical to Smart Connections' "Smart Lookup" view, but built into the same panel.

**Search mode UI**: A text input replaces the active-file context row. As the user types (debounced 300ms), calls `noteEmbeddingService.semanticSearch(query, limit)` and re-renders results.

```typescript
private onSearchInput(query: string): void {
  clearTimeout(this.searchTimer);
  if (!query.trim()) {
    // Return to browse mode
    this.setMode('browse');
    this.refreshResults(this.app.workspace.getActiveFile()?.path ?? '');
    return;
  }
  this.searchTimer = window.setTimeout(async () => {
    this.setLoading(true);
    const results = await this.noteEmbeddingService.semanticSearch(query, this.settings.resultCount);
    this.renderResults(results, null); // no activeFilePath in search mode
    this.setLoading(false);
  }, 300);
}
```

**Search mode**: No drag-to-link (no active file target), Send to Chat still works, Link action inserts link at cursor position.

Browse mode and Search mode share the same result row component — no duplication.

---

### Phase 6 — Notes/Blocks Toggle

Requires Plan 04 Phase 2 (block indexing) to be complete.

A segmented control in the panel below the active file context:
```
Notes ●  Blocks ○
```

When **Blocks** is selected:
- Calls `noteEmbeddingService.findSimilarBlocks(notePath, limit)` instead of `findSimilarNotes`
- Result rows use the block variant (snippet as title, note path as subtitle)
- Search mode calls a block-aware version of `semanticSearch` that searches `block_embeddings`
- Score reflects the match quality of the specific paragraph, not the whole note

Store selected mode in `semanticPanel.resultMode: 'notes' | 'blocks'`. Persist across sessions.

---

### Phase 7 — Pin / Hide Per Connection

Per-connection state lets users curate their results over time. Mirrors Smart Connections' hidden/pinned system.

**Storage**: A `semantic_feedback` table in `cache.db`:

```sql
CREATE TABLE semantic_feedback (
  sourceNotePath TEXT NOT NULL,
  targetNotePath TEXT NOT NULL,
  state          TEXT NOT NULL CHECK(state IN ('pinned', 'hidden')),
  createdAt      INTEGER NOT NULL,
  PRIMARY KEY (sourceNotePath, targetNotePath, state)
);
```

**Feedback application in `refreshResults()`**:
```typescript
private applyFeedbackFilter(results: SimilarNote[]): SimilarNote[] {
  const feedback = this.feedbackService.getFeedback(this.activeFilePath);
  const visible = results.filter(r => !feedback.hidden.has(r.notePath));
  const pinned = visible.filter(r => feedback.pinned.has(r.notePath));
  const unpinned = visible.filter(r => !feedback.pinned.has(r.notePath));
  // Pinned always at top regardless of score, marked with 📌
  return [...pinned.map(r => ({ ...r, pinned: true })), ...unpinned];
}
```

Context menu actions update `semantic_feedback` immediately and call `refreshResults()`.

A **"Reset all feedback"** option in the panel settings popover clears the entire table for the active note.

---

### Phase 8 — Conversation Cross-Reference

This is the feature Smart Connections cannot match. Nexus has `conversation_embeddings` — it knows which conversation turns referenced which topics. The panel surfaces this:

```
💬 Referenced in 3 conversations
─────────────────────────────────
▶ "Planning session" · 2 days ago
▶ "Weekly review" · 5 days ago
▶ "Research brainstorm" · 1 week ago
```

**Implementation** — query `conversation_embedding_metadata` for the active note path in `referencedNotes`:

```typescript
async findConversationsReferencingNote(notePath: string, limit = 5): Promise<ConversationRef[]> {
  // referencedNotes is stored as a JSON array of wiki-link paths
  const rows = await this.db.query<ConvRow>(`
    SELECT DISTINCT
      cem.conversationId,
      cem.created,
      c.title
    FROM conversation_embedding_metadata cem
    LEFT JOIN conversations c ON c.id = cem.conversationId
    WHERE json_each.value = ?
      AND EXISTS (
        SELECT 1 FROM json_each(cem.referencedNotes)
        WHERE json_each.value = ?
      )
    ORDER BY cem.created DESC
    LIMIT ?
  `, [notePath, notePath, limit]);
  return rows.map(r => ({ id: r.conversationId, title: r.title, createdAt: r.created }));
}
```

Clicking a conversation row opens that conversation in the chat view.

This section is non-blocking — it loads after the similarity results and shows a skeleton until ready. If no conversations reference the note, the section is hidden entirely.

---

### Phase 9 — MCP Integration: `findRelated` Tool

Adds a `findRelated` tool to `SearchManager`, exposing the semantic index to Claude via MCP. Claude Desktop can then ask "what notes are related to the file I'm editing?" without any UI interaction.

**Tool definition** in `src/agents/searchManager/tools/findRelated.ts`:

```typescript
// Parameters
{
  notePath: string;          // vault-relative path, e.g. "Notes/Deep Work.md"
  mode?: 'notes' | 'blocks'; // default: 'notes'
  limit?: number;             // default: 10, max: 50
  minScore?: number;          // 0–1, default: 0.5
}

// Result
{
  success: true,
  activePath: string,
  results: Array<{
    path: string,
    title: string,
    score: number,       // 0–1 cosine similarity
    preview?: string,    // contentPreview (blocks only)
  }>,
  totalIndexed: number,
  mode: 'notes' | 'blocks',
}
```

This makes Nexus's semantic index a first-class MCP tool — Claude can build prompts that automatically pull in related notes, something Smart Connections has no equivalent of.

---

### Phase 10 — Panel Settings Popover

⚙ icon in the panel header opens an inline settings popover:

```
Panel Settings
──────────────────────────────────────────────
Result count:      [━━━●━━━━━━] 10
Min score:         [━━━━━━●━━━] 70%
Mode:              Notes ●  Blocks ○
Auto-refresh:      [● On]
Show score badge:  [● On]
Show full path:    [○ Off]

Exclude frontmatter:
[Use global embedding exclusions ✓]

[Reset feedback for this note]
──────────────────────────────────────────────
```

Settings stored in `PluginSettings.semanticPanel`:
```typescript
interface SemanticPanelSettings {
  resultCount: number;       // default: 10
  minScore: number;          // default: 0.7
  resultMode: 'notes' | 'blocks'; // default: 'notes'
  autoRefresh: boolean;      // default: true
  showScore: boolean;        // default: true
  showFullPath: boolean;     // default: false
}
```

---

### Phase 11 — Random Related Note Command

Registered in Phase 1 as a command. Uses score-weighted random selection — higher similarity notes are more likely to be picked, but lower-scoring notes can still surface, enabling serendipitous discovery:

```typescript
async openRandomRelatedNote(): Promise<void> {
  const activeFile = this.app.workspace.getActiveFile();
  if (!activeFile) return;

  const results = await this.noteEmbeddingService.findSimilarNotes(activeFile.path, 20);
  if (!results.length) return;

  // Score-weighted random selection (higher score = higher probability)
  const totalWeight = results.reduce((sum, r) => sum + r.score, 0);
  let rand = Math.random() * totalWeight;
  const selected = results.find(r => (rand -= r.score) <= 0) ?? results[0];

  const file = this.app.vault.getFileByPath(selected.notePath);
  if (file) this.app.workspace.getLeaf().openFile(file);
}
```

Also accessible as a ribbon icon (dice icon) — same as Smart Connections' random connection ribbon.

---

## Files to Create / Change

| File | Change |
|------|--------|
| `src/ui/semanticPanel/SemanticPanelView.ts` | New — ItemView, panel layout, mode toggle |
| `src/ui/semanticPanel/SemanticResultRow.ts` | New — result row (note + block variants), drag-to-link, context menu |
| `src/ui/semanticPanel/SemanticFeedbackService.ts` | New — pin/hide state CRUD against `semantic_feedback` table |
| `src/ui/semanticPanel/SemanticPanelNavigation.ts` | New — open/activate helper |
| `src/core/ui/SemanticPanelUIManager.ts` | New — view + commands (mirrors `TaskBoardUIManager`) |
| `src/agents/searchManager/tools/findRelated.ts` | New — MCP tool for semantic lookup |
| `src/agents/searchManager/searchManager.ts` | Register `FindRelatedTool` |
| `src/database/SQLiteCacheManager.ts` | Add `semantic_feedback` table; `findConversationsReferencingNote()` query |
| `src/services/embeddings/NoteEmbeddingService.ts` | Expose `findSimilarBlocks()` (Plan 04 Phase 2) |
| `src/core/PluginLifecycleManager.ts` | Register `SemanticPanelUIManager` |
| `src/types/plugin/PluginTypes.ts` | Add `SemanticPanelSettings` block |
| `src/constants/branding.ts` | Add `SEMANTIC_PANEL_VIEW_TYPE` |
| `styles.css` | All semantic panel styles — result rows, score badges, preview pane, conversation refs section, search input |

## Dependencies
- **Plan 04 Phases 1–3** must be complete (backfill, block indexing, cosine scoring)
- **Plan 04 Phase 2** specifically required for Phase 6 (blocks toggle)
- Plan 03 (Chat Action Buttons / `EditorInsertService`) useful for "Insert link at cursor" in context menu, but not blocking — can implement inline if Plan 03 not done
- No dependency on Plan 01 or Plan 02

## Estimated Complexity
High. The view registration and result rendering are well-established patterns (TaskBoardUIManager, ProgressiveToolAccordion). The complexity is in:
- Phase 4 (Send to Chat — requires EventBus bridge to chat view)
- Phase 7 (Pin/Hide — new DB table + feedback service)
- Phase 8 (Conversation cross-reference — JSON query in existing metadata)
- Phase 9 (MCP tool — straightforward but needs `SearchManager` wiring)

Phases 1–3, 5, 10, 11 are all low-to-medium effort individually.

## What This Enables That Smart Connections Cannot

| Feature | Smart Connections | Nexus (this plan) |
|---------|------------------|-------------------|
| Similar notes sidebar | ✓ | ✓ |
| Block-level matching | ✓ | ✓ |
| Drag-to-link | ✓ | ✓ |
| Pin/hide connections | ✓ | ✓ |
| Semantic search box | Separate plugin | ✓ Built-in |
| Score normalization | ✓ | ✓ |
| Random related note | ✓ | ✓ |
| **Send to Chat** | ✗ | **✓ Nexus-unique** |
| **Conversation cross-ref** | ✗ | **✓ Nexus-unique** |
| **MCP `findRelated` tool** | ✗ | **✓ Nexus-unique** |
| **Deep reranking (recency, session)** | ✗ | **✓ Nexus-unique** |
