# Plan 05 — Semantic Panel: Connections, Search & Chat
Last Updated: 2026-03-30 (post-critique revision)

## Goal

Build a Nexus-native semantic discovery panel for the chat sidepanel that turns the semantic database from Plan 04 into an interactive workflow surface.

The panel should be:

- **Useful in context** — automatically reacts to the active note in browse mode
- **Dual-purpose** — supports both related-note browsing and semantic query search in the same panel
- **Hybrid-aware** — works with note-level indexing always, and block-level indexing when enabled in the Embeddings tab
- **Chat-integrated** — can send related notes or blocks into the active conversation as explicit context
- **Curatable** — users can pin or hide noisy connections over time
- **Safe** — avoids surprising file edits and handles disabled/stale index states explicitly
- **Accessible and resilient** — keyboard-usable, race-safe, and explicit about empty/loading/error states
- **MCP-aligned** — UI behavior and `findRelated` tool behavior should use the same retrieval contracts and exclusion rules

This panel is not a clone of Smart Connections. It uses the same general semantic discovery pattern, but extends it into Nexus chat, conversation memory, and MCP workflows.[file:181][web:106]

**Prerequisites**: Plan 04 must be implemented with the final architecture: note-level indexing always on, block-level indexing optional, native-local embeddings only, Embeddings tab present, and retrieval contracts established.[file:81]

---

## Non-Goals / Deferred Scope

The following are out of scope for this plan:

- Online/cloud semantic search providers
- Auto-writing bidirectional links by default
- Query-conditioned pin/hide systems
- Per-folder or per-query panel modes
- Fully editable in-panel note previews
- Cross-vault semantic panel aggregation
- Semantic search over non-markdown assets beyond what Plan 04 already supports
- Advanced re-ranking experiments beyond the base scoring and filtering pipeline
- Random related note command for v1

---

## Panel Modes

The panel has two primary modes and two retrieval granularities.

### Browse mode

Browse mode is anchored to the current active markdown note.

Use cases:
- “What notes are related to the note I am viewing?”
- “What exact block in another note relates to this note?”

### Search mode

Search mode is anchored to a user-entered semantic query.

Use cases:
- “Find notes about intermittent fasting and cortisol.”
- “Find blocks mentioning ritual design.”

### Result granularities

- **Notes** — always available because note-level indexing is always enabled in Plan 04.[file:81]
- **Blocks** — available only if block indexing is enabled and current block data is not stale.[file:81]

---

## Retrieval Contract

This plan must stay aligned with Plan 04’s retrieval model.[file:81]

| Panel State | Retrieval Source | Availability | Notes |
|---|---|---|---|
| Browse + Notes | `findSimilarNotes(activePath)` | Always available | Primary default mode.[file:81] |
| Browse + Blocks | `findSimilarBlocks(activePath)` | Only if block indexing enabled | Disabled otherwise.[file:81] |
| Search + Notes | `semanticSearchNotes(query)` | Always available | Note-level query retrieval. |
| Search + Blocks | `semanticSearchBlocks(query)` | Only if block indexing enabled | Block-level query retrieval. |

### Rules

- Note mode always uses note-level embeddings as the primary source of truth.[file:81]
- Block mode is never shown as active if block indexing is disabled or stale.[file:81]
- Query search does **not** silently switch between note and block retrieval without reflecting that in the UI.[file:81]
- Exclusions from Plan 04 are enforced identically in the panel and in MCP tool results.[file:81]
- UI ranking/filtering uses raw cosine-based scores as the logic layer; any display normalization is visual only.[file:181][file:81]

---

## Score Semantics

Use raw cosine-based similarity from Plan 04 as the canonical score source.[file:81]

### Rules

- **Ranking** uses raw score.
- **Minimum-score filtering** uses raw score.
- **MCP output** uses raw score.
- **Display badges** may apply readability normalization, but normalized values must not affect ranking or filtering.[file:181]

Recommended display treatment:
- show rounded percentage from raw cosine,
- optionally apply mild UI-only normalization if needed for readability,
- avoid over-signaling certainty with strong traffic-light semantics.

---

## Panel Layout

```text
┌──────────────────────────────────────────────┐
│ Semantic Panel              [Search] [↻] [⚙] │
├──────────────────────────────────────────────┤
│ Active: Deep Work Strategies                 │
│ Notes ●  Blocks ○                            │
├──────────────────────────────────────────────┤
│ Pinned                                       │
│  📌 Flow State                       91%     │
│ Results                                      │
│  ▶ Attention and Control             88%     │
│  ▼ Ritual Design                     84%     │
│    preview excerpt…                          │
│    [Send to Chat] [Open] [Insert Link]       │
├──────────────────────────────────────────────┤
│ Referenced in conversations                  │
│  ▶ Planning session · 2 days ago             │
├──────────────────────────────────────────────┤
│ Showing 10 results                           │
└──────────────────────────────────────────────┘
```

Search mode replaces the active-note row with a query field.

---

## UI States

The panel needs explicit states. Do not treat all non-success cases as a generic empty state.

### Required states

- **No active markdown file** — “Open a markdown note to browse related notes.”
- **Index not ready** — “Semantic index is not ready yet.” with link to Embeddings tab.[file:81]
- **Note not indexed yet** — “This note has not been indexed yet.” with `Index now` action.
- **Block mode unavailable** — “Block indexing is disabled in Embeddings settings.” with `Open Embeddings` action. Triggered when `embedding_config.blockIndexingEnabled` is `'false'`.[file:81]
- **Block index stale** — “Block index needs rebuild after settings change.” with `Rebuild index` action. Triggered when `embedding_config.blockIndexStale` is `'true'` (see Plan 04 Phase 11 for the full stale lifecycle). Both conditions disable the Blocks toggle.[file:81]
- **Loading** — keep prior results visible with a loading overlay or skeletons.
- **No results (browse)** — “No related notes found for this note.”
- **No results (search)** — “No semantic matches found for this query.”
- **Error** — “Could not load semantic results.” with retry action.

These states must be explicit because the panel depends on background index lifecycle and model readiness from Plan 04.[file:81]

---

## Implementation Plan

### Phase 1 — View Registration and Navigation

Follow the existing UI-manager pattern used elsewhere in Nexus.

**New files:**
- `src/ui/semanticPanel/SemanticPanelView.ts`
- `src/ui/semanticPanel/SemanticResultRow.ts`
- `src/ui/semanticPanel/SemanticPanelNavigation.ts`
- `src/core/ui/SemanticPanelUIManager.ts`

**Constants:**
```typescript
export const SEMANTIC_PANEL_VIEW_TYPE = 'nexus-semantic-panel';
```

**Commands:**
- `Nexus: Open Semantic Panel`
- `Nexus: Refresh Semantic Panel`

---

### Phase 1a — Chat Header Button

The primary entry point for the semantic panel is a button in the Nexus chat header, placed to the left of the existing settings gear. This makes the semantic panel discoverable directly from chat without adding a ribbon icon.

#### Layout constraint

The chat header (`chat-header` in [ChatLayoutBuilder.ts](src/ui/chat/builders/ChatLayoutBuilder.ts)) uses `justify-content: space-between` with three direct children:

```
[hamburger]   [chat-title]   [settings-button]
```

Adding a fourth button as a direct sibling would break `space-between` spacing. The fix is to wrap the right-side buttons in a container div so the header still sees three logical children:

```
[hamburger]   [chat-title]   [chat-header-right]
                               ├─ semantic-panel-button
                               └─ settings-button
```

#### `AgentStatusMenu` interaction — confirmed safe

`AgentStatusMenu` in `src/ui/chat/components/AgentStatusMenu.ts` inserts the agent status button using `this.container.insertBefore(button, this.insertBefore)`, where `container = settingsButton.parentElement` and `insertBefore = settingsButton` (wired at [ChatView.ts:750-751](src/ui/chat/ChatView.ts#L750)).

Currently: `settingsButton.parentElement === chatHeader` — the agent button lands directly in the header.

After this plan's change: `settingsButton.parentElement === chat-header-right` — the agent button lands **inside `chat-header-right`**, to the left of the settings button within that group. This is the correct visual outcome: all right-side action buttons (agent status, semantic panel, settings) are grouped together in `chat-header-right`.

**No code change is needed in `AgentStatusMenu`.** The behavior is correct. Verify during implementation that the DOM order inside `chat-header-right` is: agent-status → semantic-panel → settings, left to right, by ensuring `settingsButton` is the last child appended to `headerRight` in `ChatLayoutBuilder`.

#### `ChatLayoutBuilder.ts` changes

1. Replace the bare `settingsButton` creation with a right-side wrapper:

```typescript
// Right: button group
const headerRight = chatHeader.createDiv('chat-header-right');

const semanticPanelButton = headerRight.createEl('button', {
  cls: 'chat-semantic-panel-button'
});
setIcon(semanticPanelButton, 'network');
semanticPanelButton.setAttribute('aria-label', 'Open Semantic Panel');

const settingsButton = headerRight.createEl('button', {
  cls: 'chat-settings-button'
});
setIcon(settingsButton, 'settings');
settingsButton.setAttribute('aria-label', 'Chat settings');
```

2. Add `semanticPanelButton` to the return value of `createHeader()`:

```typescript
return { chatTitle, hamburgerButton, settingsButton, semanticPanelButton };
```

3. Add `semanticPanelButton` to the `layoutElements` type so `ChatView.ts` can access it.

#### Event wiring in `ChatView.ts`

Wire via `registerDomEvent` on the component, following the existing pattern:

```typescript
this.registerDomEvent(
  this.layoutElements.semanticPanelButton,
  'click',
  () => this.semanticPanelUIManager.openSemanticPanel()
);
```

`openSemanticPanel()` in `SemanticPanelUIManager` calls `SemanticPanelNavigation.openSemanticPanelView(this.app)`, which focuses an existing panel leaf or creates a new one in the right sidebar — same **behavioral** pattern as `taskBoardNavigation.ts` (open-or-focus an existing leaf). Note: the existing navigation file at `src/ui/tasks/taskBoardNavigation.ts` uses camelCase; all files in the new `src/ui/semanticPanel/` directory use PascalCase for consistency with their peers. Do not rename `SemanticPanelNavigation.ts` to match the outlier camelCase convention.

#### CSS additions to `styles.css`

Add `.chat-semantic-panel-button` to the existing button selector to inherit all shared header button styles without duplication:

```css
/* Extend the existing shared rule — add to the comma list.
   NOTE: This modifies two existing CSS rules in-place by appending a new selector.
   The rule bodies are unchanged, but the diff will show existing lines as context.
   This is expected and intentional — do not extract into a separate rule to avoid
   the rule duplication that would result. */
.chat-hamburger-button,
.chat-settings-button,
.chat-semantic-panel-button {
    /* existing rules unchanged */
}

.chat-hamburger-button:hover,
.chat-settings-button:hover,
.chat-semantic-panel-button:hover {
    /* existing rules unchanged */
}

/* Right-side button group — keeps space-between layout intact */
.chat-header-right {
    display: flex;
    gap: 4px;
    align-items: center;
}
```

No other layout rules change. `chat-header` keeps its current `space-between`, padding, and border — this change is additive only.

#### Active state

When the semantic panel is open and focused, the button gets a subtle active indicator:

```css
.chat-semantic-panel-button.is-active {
    color: var(--text-accent);
    background: var(--background-modifier-hover);
}
```

`SemanticPanelView.ts` emits an event (or `SemanticPanelUIManager` tracks open state) so `ChatView` can toggle `is-active` on open/close. Use the same active-state pattern as the hamburger button uses for the sidebar.

#### Mobile

**The existing mobile selectors in `styles.css` are stale.** They target `.chat-hamburger` and `.chat-settings-btn`, but `ChatLayoutBuilder.ts` creates buttons with classes `.chat-hamburger-button` and `.chat-settings-button`. No TypeScript source uses the truncated names. The existing mobile rules therefore apply to nothing.

The implementation must add an explicit mobile touch-target rule for the new button:

```css
body.is-mobile .chat-hamburger-button,
body.is-mobile .chat-settings-button,
body.is-mobile .chat-semantic-panel-button {
    min-width: 44px;
    min-height: 44px;
}
```

This also fixes the existing mobile touch-target gap for the hamburger and settings buttons as a side effect. The `.chat-hamburger` and `.chat-settings-btn` selectors may be left in place (dead code) or cleaned up — either is safe.

---

### Phase 2 — Active File Tracking, Request Lifecycle, and Race Safety

Track active-file changes in browse mode with debounce.

```typescript
this.registerEvent(
  this.app.workspace.on('active-leaf-change', () => {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.onActiveFileChange(), 250);
  })
);
```

**Non-markdown leaf handling:** `active-leaf-change` fires whenever focus moves to any leaf — settings modal, task board, canvas, the semantic panel itself, etc. `onActiveFileChange()` must resolve the current active file using `this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null` rather than `this.app.workspace.activeEditor?.file`. If the result is `null`, render the "No active markdown file" UI state and stop. Do **not** attempt to run semantic retrieval for non-markdown views. This is expected behavior, not an error — do not log or surface a warning.

Add request tokens so stale async responses cannot overwrite newer state.

```typescript
private requestId = 0;

private async refreshResults(notePath: string): Promise<void> {
  const requestId = ++this.requestId;
  this.setLoading(true, { keepExisting: true });

  const raw = await this.loadResultsForCurrentMode(notePath);
  if (requestId !== this.requestId) return;

  const filtered = this.applyFeedbackAndThresholds(raw);
  this.renderResults(filtered);
  this.setLoading(false);
  this.refreshConversationRefs(notePath, requestId);
}
```

Requirements:
- stale active-file requests are discarded,
- stale search requests are discarded,
- old results remain visible until replacement results are ready,
- errors are tied to the latest request only.

---

### Phase 3 — Browse/Search Mode Controller

Implement an explicit mode controller.

```typescript
type PanelMode = 'browse' | 'search';
type ResultMode = 'notes' | 'blocks';
```

### Browse mode behavior

- Reads current active markdown file.
- If `autoRefresh` is on, refreshes automatically.
- If there is no active markdown file, render browse empty state.
- Shows conversation cross-references only in browse mode.

### Search mode behavior

- Query input debounced at 300ms.
- Empty query returns to browse mode.
- Search mode does not show active-note-specific conversation refs.
- Search mode still allows `Send to Chat`, `Open`, and `Insert Link at Cursor` if a markdown editor exists.

Keep browse and search rendering on the same result row component, but do not assume every browse-mode affordance belongs in search mode.

---

### Phase 4 — Result Row Component and Interaction Model

Each result row has:
- header,
- optional preview region,
- action bar,
- context menu.

### Header contents

- disclosure icon (`▶`/`▼`),
- note title or block snippet title,
- path/subtitle,
- score badge if enabled,
- context menu button.

### Expansion behavior

Use a simple rule:
- only one expanded row at a time.

On refresh:
- collapse all rows unless preserving the current top-row expansion is trivial and deterministic.

### Keyboard behavior

- Arrow keys navigate rows.
- Enter expands/collapses row.
- `Cmd/Ctrl+Enter` opens note.
- Context menu button is keyboard reachable.
- Expanded state uses `aria-expanded`.

### Drag-to-link

Support drag-to-link for note rows and block rows when a real note file exists.

```typescript
row.setAttribute('draggable', 'true');
this.registerDomEvent(row, 'dragstart', (e: DragEvent) => {
  const file = this.app.vault.getFileByPath(this.result.notePath);
  if (file) this.app.dragManager.dragFile(e, file);
});
```

### Safer linking principle

Do not make automatic reciprocal note editing the default quick action.[file:181]

Primary actions should be:
- `Send to Chat`
- `Open`
- `Insert Link`

Any future reciprocal-link action should be secondary and confirmed.

---

### Phase 5 — Preview Strategy

Preview behavior must differ by result type.

### Note-mode previews

Default strategy:
- If block indexing is enabled and a best matching block is available for that note, show that excerpt as the preview.
- Otherwise fall back to the opening excerpt of the note, capped at **600 characters**, truncated at the nearest word boundary.

### Block-mode previews

- Show the matched block excerpt (already naturally bounded by chunk size from Plan 04).
- Also show the parent note title/path.

### Loading rule

- Preview content is lazy-loaded on first expand.
- Cache preview content for the lifetime of the panel session.

This gives more relevant previews than always rendering the first 600 characters of a note.[file:181][file:81]

---

### Phase 6 — Chat Integration Contract

This is a core Nexus-specific feature and needs a strict contract.

### Transport: direct callback, not EventBus

There is no existing EventBus pattern for chat context injection in the codebase. The only EventBus (`SubagentEventBus`) carries a single `'status-changed'` event with no payload — it is not suitable for semantic context payloads.

**Use a direct callback instead.** The wiring is:

1. `ChatView` exposes a method `addSemanticContext(payload: SemanticContextPayload): void`.
2. When `ChatView` initialises `SemanticPanelUIManager`, it passes a reference to this method as a callback.
3. `SemanticPanelUIManager` stores the callback and passes it into `SemanticPanelView` on construction.
4. `SemanticResultRow` calls the callback when the user clicks `Send to Chat`.

```typescript
// In ChatView (new method):
addSemanticContext(payload: SemanticContextPayload): void {
  this.semanticContextTray.add(payload);  // dedup + tray render
}

// In ChatView.initializeSemanticPanel():
this.semanticPanelUIManager = new SemanticPanelUIManager(
  this.app,
  (payload) => this.addSemanticContext(payload)  // callback passed here
);
```

This follows the same direct-callback pattern already used elsewhere in ChatView (e.g. `ModelAgentManagerEvents` callbacks at ChatView line ~398). Do not introduce a new singleton EventBus for this feature.

### Relationship to existing context system

The existing chat context system (`ModelAgentManager.addContextNote(notePath)` → `ContextNotesManager`) injects full note content into the system prompt by path. Semantic context payloads are **different** — they carry pre-fetched content or block excerpts and need their own tray and injection path, because:

- Block payloads contain an excerpt, not a full note path to lazy-load.
- Both payload types need richer display in the tray (score badge, heading, semantic label).
- The content is already in memory from the retrieval call — re-reading the vault file is wasteful.

Implement `SemanticContextTray` as a new service within the chat, separate from `ContextNotesManager`. It holds `SemanticContextPayload[]` and renders entries into the existing `contextContainer` div alongside regular note context pills — or appended below them, depending on visual preference.

### Send to Chat behavior

Support sending either a note result or a block result.

### Context payloads

```typescript
type SemanticContextPayload =
  | {
      kind: 'semantic-note';
      path: string;
      title: string;
      score: number;
      content: string;        // pre-fetched, already size-capped
    }
  | {
      kind: 'semantic-block';
      path: string;
      title: string;
      heading?: string;
      chunkIndex: number;
      score: number;
      excerpt: string;        // the matched block text
    };
```

### Rules

- Context is added to a visible pending chat-context tray, not silently injected and forgotten.
- Deduplicate by `path` for note payloads, and by `path + chunkIndex` for block payloads.
  - On duplicate: silently skip and briefly flash the existing tray entry (visual acknowledgement, no modal).
- Note payloads are size-capped at **32,000 characters** before injection. Content is truncated at the nearest paragraph boundary below the cap, with a trailing `…(truncated)` marker so the user can see the cap was applied.
- Block sends default to the matched excerpt, not the full parent note.
- The user can remove pending semantic context before sending the next message.

---

### Phase 7 — Search Actions and Write Safety

#### Open
- Opens the target note.

#### Insert Link
- Inserts a `[[wikilink]]` at the current editor cursor using `EditorInsertService.insertAtCursor()` (introduced in Plan 03 / Chat Action Buttons, `src/ui/chat/services/EditorInsertService.ts`).
- `EditorInsertService` uses `iterateAllLeaves` as a fallback so insertion works correctly when the semantic panel itself has focus and `app.workspace.activeEditor` is null.
- If there is no active markdown editor, disable the action with an explanatory tooltip: "Open a note to insert a link."

#### Write safety rules

Any file-writing action must define:
- duplicate link avoidance,
- append location if ever implemented,
- newline handling,
- failure messaging.

Do not auto-edit both notes from a single casual click in v1.[file:181]

---

### Phase 8 — Notes / Blocks Toggle

The panel exposes a segmented toggle:

```text
Notes ●  Blocks ○
```

### Rules

- `Notes` is always available because note indexing is always available.[file:81]
- `Blocks` is only enabled when both conditions are met: `embedding_config.blockIndexingEnabled === 'true'` AND `embedding_config.blockIndexStale !== 'true'`. Read these values from `NoteEmbeddingService.getIndexState()` (or equivalent) at panel load and after each refresh.[file:81]
- If either condition fails, the `Blocks` segment is disabled with explanatory text and a link to Embeddings settings. Show the more specific reason (disabled vs. stale) from the UI states spec.[file:81]
- Selected mode is persisted in `SemanticPanelSettings.resultMode` (see Phase 12) and restored on panel open. If blocks become unavailable after the panel was last closed with `resultMode: 'blocks'`, auto-reset to `'notes'` on next open rather than immediately rendering the stale/disabled state.

This must stay synchronized with actual Plan 04 state, not act as a purely local preference.[file:81]

---

### Phase 9 — Pin / Hide Feedback

Use a simple note-level feedback model first.

This table is added in schema v13 (Plan 04 adds v12 for the embedding tables; this plan adds v13 for panel-specific data).

```sql
CREATE TABLE semantic_feedback (
  sourceNotePath TEXT NOT NULL,
  targetNotePath TEXT NOT NULL,
  state          TEXT NOT NULL CHECK(state IN ('pinned', 'hidden')),
  createdAt      INTEGER NOT NULL,
  PRIMARY KEY (sourceNotePath, targetNotePath, state)
);
```

### Scope decision

Feedback is **note-level only** in v1, even when viewing block results.

That means:
- pinning a result pins the parent note,
- hiding a result hides the parent note,
- there is no chunk-specific hide state yet.

This keeps the curation model understandable and avoids combinatorial complexity.[file:181]

---

### Phase 10 — Conversation Cross-Reference

This is a strong Nexus-unique feature, but define it precisely.

### Contract

The section shows conversations whose stored referenced-note metadata explicitly includes the active note path.

### Data source (already exists)

`conversation_embedding_metadata.referencedNotes` is a TEXT column added in schema v8. It stores a JSON-stringified array of vault-relative wiki-link paths extracted from each conversation embedding chunk at index time. No new data infrastructure is needed for this feature — query the existing column:

```sql
SELECT DISTINCT m.conversationId, m.sessionId, m.created
FROM conversation_embedding_metadata m
WHERE json_each.value = ?   -- active note path
  AND m.referencedNotes IS NOT NULL
JOIN json_each(m.referencedNotes)
ORDER BY m.created DESC
LIMIT 10;
```

The query can be added to `ConversationEmbeddingService` as `getConversationsReferencingNote(notePath: string)`.

### Behavior

- Only shown in browse mode.
- Hidden entirely if no conversations reference the active note.
- Loaded after semantic results, non-blocking.
- Clicking a row opens the conversation in chat UI.

### Known limitation

`referencedNotes` paths are captured at embedding time. If a note is later renamed, historical `referencedNotes` entries for that note go stale and the cross-reference will not appear. Fixing rename-sensitivity in conversation embeddings is out of scope for v1 — this is a known limitation, not a data-layer gap to solve before shipping.

---

### Phase 11 — MCP Integration: `findRelated`

Add a `findRelated` tool to `SearchManager`, aligned with panel retrieval behavior.

**The canonical input and output contract is defined in Plan 04 Phase 16.** Do not diverge from it. Summarized here for reference:

- Input: `notePath` or `query` (mutually exclusive, at least one required), optional `mode` (default `'notes'`), optional `limit`, optional `minScore`.
- Output: `{ success, mode, total, results: [{ path, title, score, preview?, heading?, chunkIndex? }] }`.
- `notePath` and `query` are mutually exclusive — return an error if both are provided.
- `minScore` filters results post-retrieval; does not affect ranking.

Rules:
- `notes` mode always available.
- `blocks` mode only available if block indexing is enabled.
- Exclusions are always enforced.
- Use raw cosine-based scores, not UI-normalized display scores.[file:181][file:81]

---

### Phase 12 — Panel Settings Popover

Keep this popover focused on panel-local display behavior, not global embedding configuration.

```text
Panel Settings
────────────────────────────────────
Result count      [10]
Minimum score     [70%]
Auto-refresh      [On]
Show score        [On]
Show full path    [Off]
Reset feedback    [Button]
```

Do **not** put these here:
- model selection,
- exclusions,
- block indexing enablement,
- chunking settings,
- rebuild/clean index controls.

Those belong in the Embeddings tab from Plan 04.[file:81]

### `SemanticPanelSettings` interface

Add to `src/types/plugin/PluginTypes.ts`:

```typescript
interface SemanticPanelSettings {
  resultCount: number;              // default: 10
  minScore: number;                 // default: 0.70  (raw cosine threshold, 0–1)
  resultMode: 'notes' | 'blocks';  // default: 'notes' — persisted from toggle
  autoRefresh: boolean;             // default: true
  showScore: boolean;               // default: true
  showFullPath: boolean;            // default: false
}
```

`resultMode` is the persistent backing for the Notes/Blocks toggle (Phase 8). All other fields map directly to the popover controls above.

---

### Phase 13 — Diagnostics and Performance

Add lightweight panel diagnostics for debugging.

Useful internal metrics:
- last result load duration,
- last search duration,
- last error,
- current panel mode,
- current result mode,
- active note path,
- whether block mode is enabled/disabled/stale.

### Performance rules

- debounce active-file changes,
- debounce search input,
- lazy-load previews,
- discard stale async responses,
- keep old results visible during refresh,
- cap results to avoid runaway block rendering.

---

## Files to Create / Change

| File | Change |
|------|--------|
| `src/ui/semanticPanel/SemanticPanelView.ts` | New — ItemView, panel controller, mode handling, UI states |
| `src/ui/semanticPanel/SemanticResultRow.ts` | New — note/block row rendering, expansion, actions, keyboard support |
| `src/ui/semanticPanel/SemanticFeedbackService.ts` | New — pin/hide CRUD against `semantic_feedback` |
| `src/ui/semanticPanel/SemanticPanelNavigation.ts` | New — open/focus helper |
| `src/core/ui/SemanticPanelUIManager.ts` | New — view and command registration; exposes `openSemanticPanel()` |
| `src/agents/searchManager/tools/findRelated.ts` | New — MCP tool for semantic retrieval |
| `src/agents/searchManager/searchManager.ts` | Register `findRelated` tool |
| `src/database/SQLiteCacheManager.ts` | Schema v13 migration: add `semantic_feedback` table; add conversation reference query (see Phase 10) |
| `src/services/embeddings/NoteEmbeddingService.ts` | Ensure note/block retrieval APIs match final Plan 04 contract |
| `src/core/PluginLifecycleManager.ts` | Register semantic panel UI manager |
| `src/types/plugin/PluginTypes.ts` | Add `SemanticPanelSettings`; extend `layoutElements` type with `semanticPanelButton` |
| `src/constants/branding.ts` | Add `SEMANTIC_PANEL_VIEW_TYPE` |
| `src/ui/chat/builders/ChatLayoutBuilder.ts` | Wrap settings button in `chat-header-right` container; add `semanticPanelButton`; return it from `createHeader()` |
| `src/ui/chat/ChatView.ts` | Wire `semanticPanelButton` click → `semanticPanelUIManager.openSemanticPanel()`; toggle `is-active` on panel open/close; expose `addSemanticContext(payload)` callback and pass it to `SemanticPanelUIManager` on construction |
| `src/ui/chat/services/SemanticContextTray.ts` | New — holds `SemanticContextPayload[]`; renders semantic context entries into `contextContainer` alongside regular note pills; receives payloads via the `addSemanticContext` callback from `ChatView` |
| `styles.css` | Add `chat-semantic-panel-button` to existing header button selector; add `.chat-header-right` container rule; add `.chat-semantic-panel-button.is-active`; semantic panel view styles, loading states, popover, row affordances |

---

## Dependencies

- Plan 04 must be implemented in its final form.[file:81]
- Block-mode UI depends on block indexing being enabled and current.[file:81]
- Embeddings settings and maintenance live in the Embeddings tab, not this panel.[file:81]
- Chat integration uses a direct callback: `ChatView.addSemanticContext(payload)` is passed to `SemanticPanelUIManager` on construction. No EventBus is required — the sole existing EventBus (`SubagentEventBus`) carries a no-payload `status-changed` event and is not suitable for semantic context payloads.

---

## Estimated Complexity

High.[file:181]

Highest-risk areas:
- chat integration contract,
- panel state/race handling,
- conversation cross-reference correctness,
- keeping block-mode behavior aligned with actual index state,
- interaction polish and write safety.[file:181][file:81]

Lower-risk areas:
- view registration,
- result row rendering,
- settings popover,
- MCP tool wiring once retrieval APIs are stable.[file:181][file:81]

---

## What this enables

Compared with a basic related-notes panel, this plan enables:

- semantic browse by active note,
- semantic search by free-text query,
- optional fine-grained block discovery,
- explicit context handoff into Nexus chat,
- conversation-to-note cross-reference,
- MCP access to semantic retrieval.[file:181][file:81]

That is the correct product shape for Nexus because it makes the semantic index operational inside the sidepanel rather than leaving it as a passive backend capability.[file:181][file:81]
