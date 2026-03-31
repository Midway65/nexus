# Plan 01 — Chat Layout Bug Fixes
Last Updated: 2026-03-29

## Problem Summary

Two distinct layout bugs in the chat sidebar:

1. **Accordion word-wrap**: Tool output text inside `.progressive-tool-content` and `.tool-accordion-content` overflows horizontally past the sidebar boundary. Long JSON values, file paths, and code strings are not wrapping.
2. **Chat panel collapse**: The chat window occasionally shrinks to the bottom of the sidebar. Root cause is likely a flex layout not constraining height correctly when the sidebar is resized or when Obsidian redraws the leaf.

---

## Bug 1 — Accordion Overflow

### Root Cause
`styles.css` has `overflow: hidden` on `.progressive-tool-accordion` and `.tool-accordion` (the containers), but the inner content elements — specifically `.tool-result-content` / pre/code blocks inside the accordion body — lack `word-break: break-word` or `overflow-wrap: anywhere`. Long unbreakable strings (URLs, JSON keys, base64 snippets) push the container width beyond the sidebar.

The `white-space: pre-wrap` on monospace blocks is correct, but `word-break` is not universally applied.

### Fix — styles.css only

Add the following rules:

```css
/* Ensure all text inside tool accordions wraps */
.progressive-tool-content,
.tool-accordion-content {
    overflow: hidden;
    min-width: 0;
}

.progressive-tool-content *,
.tool-accordion-content * {
    max-width: 100%;
}

/* Pre/code blocks: wrap long lines, allow horizontal scroll as fallback */
.progressive-tool-content pre,
.tool-accordion-content pre {
    white-space: pre-wrap;
    word-break: break-all;
    overflow-wrap: anywhere;
    overflow-x: auto;
}

/* Inline strings (JSON values, paths) */
.tool-result-value,
.tool-param-value {
    word-break: break-word;
    overflow-wrap: anywhere;
}
```

Also add `min-width: 0` to the flex children in the accordion header to prevent header text from forcing expansion.

---

## Bug 2 — Chat Panel Collapsing

### Root Cause
`ChatView` extends `ItemView`. The outer layout container (`.nexus-chat-container` or equivalent) likely uses `flex-direction: column` but the message list flex child is missing `flex: 1 1 0` or `min-height: 0`. Without `min-height: 0`, a flex child cannot shrink below its content size — when content height exceeds the sidebar, the browser recalculates layout and can collapse the parent. This is a well-known flexbox pitfall in Obsidian sidebar views.

### Fix — styles.css only

Locate the chat container hierarchy in styles.css. The fix:

```css
.nexus-chat-container {        /* top-level container filling the leaf */
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;             /* critical: allows flex children to shrink */
    overflow: hidden;
}

.nexus-messages-container {    /* the scrollable message list */
    flex: 1 1 0;
    min-height: 0;             /* critical: prevents overflow pushing parent */
    overflow-y: auto;
    overflow-x: hidden;
}

.nexus-input-container {       /* input area at the bottom */
    flex-shrink: 0;            /* never shrink the input row */
}
```

### Verification
- Open Obsidian with the chat sidebar visible
- Generate a response with long tool output — accordion content should wrap, not overflow
- Resize the sidebar narrower and wider — chat panel should maintain layout
- Trigger a long conversation — messages list should scroll, panel should not collapse

---

## Files to Change
- `styles.css` — all fixes are CSS-only, no TypeScript changes needed

## Dependencies
None. Standalone fix, safe to implement first.

## Estimated Complexity
Low — CSS-only changes. Risk of side effects is minimal since rules are scoped to Nexus class selectors.
