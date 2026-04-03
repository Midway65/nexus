# Plan 08: Semantic Panel UX Improvements
**Status**: Analysis complete, not yet implemented  
**Branch**: local-fixes  
**Started**: 2026-04-02  
**Goal**: Close the UX gap between Nexus Semantic Panel and SmartConnections side panel, based on direct side-by-side code analysis.

---

## Analysis Methodology

- SmartConnections: read `main.js` (1.2MB bundled plugin) — all jsbrains packages inlined
- Nexus: read all 7 files in `src/ui/semanticPanel/` + `styles.css`
- Both panels examined with SmartConnections installed and active in the vault

---

## Layout Comparison

| Element | SmartConnections | Nexus |
|---------|-----------------|-------|
| Container | `.sc-connections-view` | `.semantic-panel-view` |
| Top bar | `.connections-top-bar` — shows context hierarchy (breadcrumb of current note path) | `.semantic-panel-header` — shows "Semantic Panel" title + icon buttons |
| Active context display | Full path breadcrumb prominently in top bar | `Active: NoteName` in mode bar (basename only) |
| Search | External SmartEnv lookup view | Native search input in mode bar (toggle button) |
| Result toggle | Not in connections view | Notes / Blocks toggle bar |
| Results | `.connections-list.sc-list` (ul-based) | `.semantic-panel-results` (div, role=list) |
| Footer | `.connections-bottom-bar` (empty in code) | `.semantic-panel-footer` (stats, chips, bulk actions) |
| Conversation refs | Not implemented | `.semantic-panel-conv-refs` section |

**Assessment:** Nexus layout is more structured and feature-rich. SC's top bar is more informative about the current context (shows folder hierarchy, not just filename).

---

## Result Row Comparison

| Element | SmartConnections | Nexus |
|---------|-----------------|-------|
| Title | `.sc-result-file-title` link + breadcrumb chain | `.semantic-result-title` span — basename only |
| Path display | Breadcrumb: `Folder > Subfolder > Title` inline in header | Optional subtitle — EITHER block heading OR full path; never both simultaneously |
| Score | `.sc-score` badge inline in breadcrumb chain; raw 2-decimal (e.g. `0.85`) | `.semantic-result-score` right-aligned badge; percentage (`85%`) |
| Heading (blocks) | Part of breadcrumb decomposition | `.semantic-result-subtitle` — replaces path display |
| Folder context | Always visible (breadcrumb) | Only visible if `showFullPath = true`; hidden by default |
| Pin indicator | `.sc-result-pinned` — box-shadow + bg highlight | `.semantic-result-pin-indicator` icon — pin icon only |
| Preview | Markdown-rendered via `render_markdown()` | Plain text (`textContent`) |
| Preview trigger | Expansion click | Expansion click (lazy-loaded on first expand) |
| Drag | `draggable=true` via SmartEnv | `draggable=true` via `app.dragManager.dragFile()` |
| Keyboard | Implicit (SmartEnv) | Explicit: arrows, Enter expand/collapse, Cmd+Enter open |
| Accessibility | Implicit | Explicit: `tabindex=0`, `role=listitem`, `aria-expanded` |

---

## Header Controls Comparison

| Control | SmartConnections | Nexus |
|---------|-----------------|-------|
| Refresh | Menu item | Dedicated button (refresh-cw icon) |
| Settings | Menu item | Dedicated button (settings icon) → popover |
| Search/lookup | Menu item → separate view | Toggle button → inline search input |
| Pause auto-refresh | Dedicated button (pause-circle) | Not in UI (setting only) |
| Expand/Collapse All | Menu item | **Not implemented** |
| Send to context | Menu item | Header send button (per-result) |
| More actions | Hamburger menu (8 items) | No overflow menu |

---

## Context Menu Comparison

| Item | SmartConnections | Nexus |
|------|-----------------|-------|
| Pin | ✅ `Pin <name>` | ✅ `Pin result` |
| Unpin | ✅ `Unpin <name>` (shown when pinned) | ❌ **Missing — no way to undo from UI** |
| Hide | ✅ `Hide <name>` | ✅ `Hide result` |
| Unhide | ✅ `Unhide <name>` (shown when hidden) | ❌ **Missing — no way to undo from UI** |
| Unhide All (N) | ✅ with count | ❌ Missing |
| Unpin All (N) | ✅ with count | ❌ Missing |
| Copy as links | ✅ | ❌ Missing |
| Open | ❌ (click title) | ✅ Action bar button |
| Insert Link | ❌ | ✅ Action bar button |
| Send to Chat | ❌ | ✅ (header button + action bar) |

---

## Score Display Comparison

| Aspect | SmartConnections | Nexus |
|--------|-----------------|-------|
| Format | Raw decimal: `0.85` | Percentage: `85%` |
| Position | Inline in breadcrumb chain (left of title) | Right-aligned badge |
| Color | Background: `var(--background-modifier-hover)` | Background: `var(--background-modifier-border)` |
| Visual scale | None (no bar, no color coding) | None |
| Score rescaling | Multiplies until max > 0.5 (UI hack) | Raw cosine, no rescaling |

---

## Preview Comparison

| Aspect | SmartConnections | Nexus |
|--------|-----------------|-------|
| Rendering | Markdown-rendered HTML | Plain text (`textContent`) |
| Trigger | First expansion (mutation observer) | First expansion (`loadPreview()`) |
| Size | Full file or ~3000 chars | 2000 chars from `contentPreview` or 3000 chars from file fallback |
| Scrollable | Via container | `max-height: 240px` (from styles.css) |
| Frontmatter | Stripped via `process_for_rendering()` | Stripped via regex `/^---[\s\S]*?---\n?/` |

---

## Empty / Loading States Comparison

| State | SmartConnections | Nexus |
|-------|-----------------|-------|
| Loading | Not shown explicitly | `.is-loading` class (opacity 0.6, pointer-events none) + refresh button spin |
| No results | Generic `.sc-no-results` paragraph | `renderEmptyState()` — 5 distinct states |
| Note not indexed | Not distinguished | Explicit state with "Index now" button + 2.5s auto-retry |
| Index not ready | Not distinguished | Explicit state + 3.5s auto-retry |
| Error | Not shown | Shown only when no existing results to preserve |

**Nexus is significantly better on empty states.**

---

## Critical Gaps (Functional Bugs vs UX Gaps)

### 🔴 CRITICAL: No Unpin / Unhide in context menu

`SemanticResultRow.showContextMenu()` always shows "Pin result" and "Hide result" regardless of the current feedback state. Once a result is pinned or hidden, the **only** way to undo is via Settings (⚙) → "Reset feedback for this note". Users have no per-result undo from the UI.

SmartConnections shows "Unpin `<name>`" when the result is currently pinned, and "Unhide `<name>`" when hidden.

**Fix:** `showContextMenu()` must read the current feedback state and show the appropriate toggle. `SemanticFeedbackService` needs a `getFeedback(sourcePath, targetPath)` method if it doesn't exist, or the feedback state needs to be passed in via `SemanticResultRowOptions.isPinned` (already present) + a new `isHidden` field.

**Files:** `SemanticResultRow.ts`, `SemanticFeedbackService.ts`, `SemanticPanelView.ts` (pass `isHidden` alongside `isPinned`)

---

### 🟡 HIGH: No folder breadcrumb in result rows

By default (`showFullPath = false`), result rows show only the note basename. For a vault with many notes named similarly across folders ("Overview.md", "Notes.md", etc.), there's no folder disambiguation at all. SmartConnections always shows the breadcrumb chain regardless of the showFullPath setting.

Currently, turning on `showFullPath` shows the FULL path as a subtitle — a long string that takes up space. SC's approach is the middle ground: show folder hierarchy as a compact chain in a distinct style.

**Fix:** Add a breadcrumb subtitle line that shows `Folder > Subfolder` (parent path only, not the filename) beneath the title. This is always shown regardless of `showFullPath`. `showFullPath` could then control whether to show all path segments or just the immediate parent folder.

**Files:** `SemanticResultRow.ts` (buildHeader), `styles.css`

---

### 🟡 HIGH: No Expand All / Collapse All

SmartConnections has this in its overflow menu. Nexus has `expand()` and `collapse()` methods on each `SemanticResultRow` and `isExpanded` getter — the infrastructure exists. Only a header button is missing.

**Files:** `SemanticPanelView.ts` (buildHeaderBar), `styles.css`

---

### 🟡 HIGH: No "Copy as links" in context menu

Quick export of results as `[[wikilinks]]` is a common SmartConnections workflow. Nexus has Insert Link (one at a time, into a note) but no copy-to-clipboard of the result as a link.

**Files:** `SemanticResultRow.ts` (showContextMenu)

---

### 🟠 MEDIUM: Preview is plain text only

SmartConnections renders markdown in previews — headings, lists, bold text are all visible. Nexus uses `textContent` which flattens formatting. For notes with heavy structure, the plain text preview is harder to scan.

Using Obsidian's `MarkdownRenderer.render()` (static method, requires a container element and source path) would give proper rendering. Risk: slightly heavier; need to clear rendered content on collapse.

**Files:** `SemanticResultRow.ts` (loadPreview), `styles.css`

---

### 🟠 MEDIUM: No score-tier section dividers

Neither panel groups by score tier, but adding dividers (High 80%+, Medium 60-79%, Other) would let users scan confidence levels at a glance without reading individual badges.

**Files:** `SemanticPanelView.ts` (renderResults), `styles.css`

---

### 🟠 MEDIUM: No Unhide All / Unpin All bulk actions

SmartConnections shows these with counts (e.g. "Unhide All (3)") in the context menu of each result. The overall feedback count for a given source note is a single query — easy to surface.

**Files:** `SemanticPanelView.ts` (settings popover or footer), `SemanticFeedbackService.ts`

---

### 🟢 LOW: Active context bar shows basename only

The mode bar shows `Active: NoteName`. SmartConnections shows the full folder path of the active note in the top bar, making it clear which note's connections are being displayed (important when multiple notes are open).

**Fix:** Show `Folder > Subfolder > NoteName` in the mode bar, or add the path as a `title` attribute tooltip (already implemented — `activeLabel.setAttribute('title', this.activeNotePath)`). The tooltip exists but breadcrumb display does not.

**Files:** `SemanticPanelView.ts` (buildModeBar)

---

### 🟢 LOW: No score visual indicator

Both panels show a score badge with no color or bar encoding. SC does apply a rescaling hack to push scores above 0.5. Nexus shows raw cosine (more accurate). Adding a subtle color gradient (green/yellow/red) to the score badge based on tier would let users read quality at a glance without reading the number.

**Files:** `styles.css` (CSS variables + score badge classes)

---

## Recommended Implementation Order

| Priority | Feature | Effort | Files |
|----------|---------|--------|-------|
| 1 | Unpin / Unhide in context menu (functional bug) | Small | `SemanticResultRow.ts`, `SemanticFeedbackService.ts`, `SemanticPanelView.ts` |
| 2 | Folder breadcrumb subtitle | Small | `SemanticResultRow.ts`, `styles.css` |
| 3 | Expand All / Collapse All button | Small | `SemanticPanelView.ts`, `styles.css` |
| 4 | Copy as links in context menu | Tiny | `SemanticResultRow.ts` |
| 5 | Markdown rendering in preview | Medium | `SemanticResultRow.ts`, `styles.css` |
| 6 | Score-tier section dividers | Small | `SemanticPanelView.ts`, `styles.css` |
| 7 | Unhide All / Unpin All | Small | `SemanticPanelView.ts`, `SemanticFeedbackService.ts` |
| 8 | Breadcrumb in mode bar (active context) | Tiny | `SemanticPanelView.ts` |
| 9 | Score color coding | Tiny | `styles.css` |

---

## Implementation Notes

### Unpin / Unhide (Priority 1)

`SemanticResultRowOptions` already has `isPinned?: boolean`. Need to add `isHidden?: boolean`. Then in `showContextMenu()`:

```typescript
// Check current state from opts
if (this.opts.isPinned) {
  menu.addItem(item => item.setTitle('Unpin result').setIcon('pin-off').onClick(async () => {
    await this.opts.feedbackService?.removeFeedback(source, target);
    this.opts.onRefresh?.();
  }));
} else {
  menu.addItem(item => item.setTitle('Pin result').setIcon('pin').onClick(...));
}

if (this.opts.isHidden) {
  menu.addItem(item => item.setTitle('Unhide result').setIcon('eye').onClick(async () => {
    await this.opts.feedbackService?.removeFeedback(source, target);
    this.opts.onRefresh?.();
  }));
} else {
  menu.addItem(item => item.setTitle('Hide result').setIcon('eye-off').onClick(...));
}
```

`SemanticFeedbackService` needs a `removeFeedback(sourcePath, targetPath)` method.
`SemanticPanelView.renderResults()` must pass `isHidden` to each row. Currently hidden results are filtered out before rendering — so `isHidden` would only appear on the pinned partition (currently: hidden notes never shown, only pinned stay and normal remain). **If Unhide is desired, hidden results must be retained in the render with a visual distinction** (faded? collapsed? separate section?). Alternative: add an "Show hidden" toggle that re-queries without hiding.

### Folder Breadcrumb (Priority 2)

Replace the subtitle logic in `buildHeader()`:
```typescript
// Always show parent folder as subtitle unless it's a root-level note
const parts = this.opts.result.notePath.split('/');
if (parts.length > 1) {
  const subtitleEl = header.createEl('span', { cls: 'semantic-result-subtitle' });
  if (this.opts.result.kind === 'block' && this.opts.result.heading) {
    // Block: show heading + parent folder
    subtitleEl.textContent = `${this.opts.result.heading} · ${parts.slice(0, -1).join(' › ')}`;
  } else {
    subtitleEl.textContent = parts.slice(0, -1).join(' › ');
  }
}
```

### Expand All / Collapse All (Priority 3)

Add button to `buildHeaderBar()`. Toggle icon between `unfold-vertical` and `fold-vertical`:
```typescript
const expandAllBtn = actions.createEl('button', { cls: 'semantic-panel-icon-btn' });
setIcon(expandAllBtn, 'unfold-vertical');
expandAllBtn.setAttribute('aria-label', 'Expand all results');
this.registerDomEvent(expandAllBtn, 'click', () => {
  const allExpanded = this.rows.every(r => r.isExpanded);
  this.rows.forEach(r => allExpanded ? r.collapse() : r.expand());
  setIcon(expandAllBtn, allExpanded ? 'unfold-vertical' : 'fold-vertical');
  expandAllBtn.setAttribute('aria-label', allExpanded ? 'Expand all results' : 'Collapse all results');
});
```

### Copy as Links (Priority 4)

Add to `showContextMenu()` after the separator:
```typescript
menu.addSeparator();
menu.addItem(item => {
  item.setTitle('Copy as link').setIcon('copy').onClick(async () => {
    const basename = this.opts.result.notePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
    const link = this.opts.result.kind === 'block' && this.opts.result.heading
      ? `[[${basename}#${this.opts.result.heading}]]`
      : `[[${basename}]]`;
    await navigator.clipboard.writeText(link);
    new Notice('Copied', 1500);
  });
});
```

### Markdown Preview (Priority 5)

Replace `textContent` assignment in `loadPreview()` with Obsidian's renderer:
```typescript
import { MarkdownRenderer } from 'obsidian';

// In loadPreview():
if (this.previewEl) {
  this.previewEl.empty();
  await MarkdownRenderer.render(
    this.opts.app,
    truncated,
    this.previewEl,
    this.opts.result.notePath,
    this  // component for cleanup
  );
}
```
Note: `SemanticResultRow` is not a `Component` — it would need to extend `Component` or use a stub component for lifecycle management. Alternative: use `MarkdownRenderer.renderMarkdown()` (older API) or add the class extension. This is the main complexity of this item.

---

## Source Files

| File | Role |
|------|------|
| `src/ui/semanticPanel/SemanticResultRow.ts` | Individual result row — context menu, preview, actions |
| `src/ui/semanticPanel/SemanticPanelView.ts` | Panel container — header, layout, results rendering |
| `src/ui/semanticPanel/SemanticFeedbackService.ts` | Pin/hide persistence — needs `removeFeedback()` method |
| `src/ui/semanticPanel/ConnectionsService.ts` | Filter pipeline — unchanged |
| `styles.css` | All visual styling |
| `C:\Users\middl\Documents\Obsidian\Michael\.obsidian\plugins\smart-connections\main.js` | SmartConnections reference (examined, not modified) |
