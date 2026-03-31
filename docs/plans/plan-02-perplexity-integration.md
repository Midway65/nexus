# Plan 02 — Perplexity Integration Enhancement
Last Updated: 2026-03-30

## Goal
Surface Perplexity's unique search capabilities (citations, search filters, related questions, academic/SEC mode, recency filtering) as first-class features in the Nexus chat UI, rather than sending bare chat completions that ignore the API's strengths.

---

## API Capabilities (from official docs — verified 2026-03-30)

### Perplexity-Specific Request Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| `search_mode` | `"web" \| "academic" \| "sec"` | Target general web, academic papers, or SEC filings |
| `enable_search_classifier` | `boolean` | Let Perplexity auto-decide if search is needed (useful for general-purpose use) |
| `disable_search` | `boolean` | Fall back to training data only (must be `true` for `r1-1776`) |
| `search_recency_filter` | `"hour" \| "day" \| "week" \| "month" \| "year"` | Limit results by publication date |
| `search_after_date_filter` | `MM/DD/YYYY` | Explicit publish-date start |
| `search_before_date_filter` | `MM/DD/YYYY` | Explicit publish-date end |
| `last_updated_after_filter` | `MM/DD/YYYY` | Filter by page last-modified date (distinct from publish date) |
| `last_updated_before_filter` | `MM/DD/YYYY` | Filter by page last-modified date |
| `search_domain_filter` | `string[]` (max 20) | Allowlist or denylist domains (prefix `-` to exclude; cannot mix) |
| `search_language_filter` | `ISO-639-1[]` (max 10) | Filter sources by language |
| `language_preference` | `ISO-639-1` | Controls response *output* language (distinct from `search_language_filter`) |
| `return_citations` | `boolean` | Include numbered citation URLs |
| `return_related_questions` | `boolean` | Suggest follow-up queries |
| `return_images` | `boolean` | Include image results |
| `image_format_filter` | `string[]` | e.g. `["png", "jpg"]` — only with `return_images: true` |
| `image_domain_filter` | `string[]` | Restrict image results to these domains |
| `web_search_options.search_context_size` | `"low" \| "medium" \| "high"` | Retrieval depth; **API default is `"low"`** |
| `web_search_options.search_type` | `"fast" \| "pro" \| "auto"` | Search quality tier |
| `web_search_options.user_location` | `{ latitude, longitude, country, city, region }` | Geo context for localised results |
| `web_search_options.image_results_enhanced_relevance` | `boolean` | Enhanced image filtering |
| `reasoning_effort` | `"minimal" \| "low" \| "medium" \| "high"` | CoT depth — **reasoning models only** (`sonar-reasoning`, `sonar-reasoning-pro`) |
| `stream_mode` | `"full" \| "concise"` | `"full"` (default): reasoning suppressed, metadata inline in final chunk; `"concise"`: separate reasoning events emitted — **reasoning models only** |

### Constraints
- `search_recency_filter` and explicit date filters (`search_after_date_filter` / `search_before_date_filter`) are **mutually exclusive**
- `search_domain_filter` must be exclusively allowlist **or** exclusively denylist — cannot mix in one request
- `reasoning_effort` and `stream_mode: "concise"` are only meaningful for `sonar-reasoning` and `sonar-reasoning-pro`; sending them with `sonar` or `sonar-pro` is a no-op at best and may cause a validation error
- `r1-1776` is an offline model — `disable_search` **must** be forced to `true`; no web search parameters apply
- First JSON Schema (`response_format`) request incurs 10–30s delay on first token
- `sonar-deep-research` has very low rate limits (5 RPM at Tier 0, 100 RPM max) — worth surfacing in UI

### Response Fields (currently unused by Nexus)
| Field | Type | Shape |
|-------|------|-------|
| `citations` | `string[]` | URLs of sources used (numbered, matching inline `[1]` markers in response text) |
| `search_results` | `object[]` | `{ title, url, date, snippet }` per result |
| `related_questions` | `string[]` | Suggested follow-up questions |
| `images` | `object[]` | `{ url, origin, dimensions }` — **not** `image_url`/`origin_url`/`width`/`height` |
| `usage.reasoning_tokens` | `integer` | Reasoning computation tokens |
| `usage.citation_tokens` | `integer` | Tokens for citations |
| `usage.num_search_queries` | `integer` | Number of searches executed |
| `usage.cost` | `object` | Full USD cost breakdown (input, output, reasoning, citations, search, total) |

**Streaming note**: Citations, `search_results`, `related_questions`, and `images` appear only in the **final SSE chunk**, not progressively. The Perplexity docs explicitly warn: *"consider non-streaming requests for use cases where search result display is critical."* For Nexus, streaming text first then appending citations on completion is the right UX.

### Models
| Model | Strength | Notes |
|-------|---------|-------|
| `sonar` | Fast, cost-efficient, basic web search | 128K ctx |
| `sonar-pro` | Deep search, complex queries, follow-ups | 200K ctx |
| `sonar-reasoning` | Chain-of-thought + web search | 128K ctx; supports `reasoning_effort` |
| `sonar-reasoning-pro` | Extended CoT + web search | 200K ctx; supports `reasoning_effort` |
| `sonar-deep-research` | Exhaustive multi-source reports | 200K ctx; rate-limited (5–100 RPM) |
| `r1-1776` | Offline reasoning (no search) | `disable_search` forced `true` |

---

## Current State (PerplexityAdapter.ts)

The adapter currently:
- Wraps search params in an invalid `extra: { search_mode, reasoning_effort, web_search_options }` object — these are **top-level** fields; `extra` is silently ignored by Perplexity
- Extracts `search_results` from the response but discards `citations`, `related_questions`, and `images`
- Has no UI controls for any search parameters
- Sends `reasoning_effort` unconditionally to all models (should be gated to reasoning models only)
- Does not force `disable_search: true` for `r1-1776`
- `PerplexityChatResponse` interface missing `citations`, `related_questions`, `images` fields

---

## Implementation Plan

### Phase 1 — Fix the Request Body (PerplexityAdapter.ts)

Move search parameters from the invalid `extra` wrapper to top-level fields. Gate reasoning-only params behind a model check. Force offline behaviour for `r1-1776`. Also **remove** `presence_penalty` and `frequency_penalty` — these are OpenAI-specific and not in the Perplexity API spec; sending them currently risks 422 validation errors.

```typescript
const isReasoningModel = modelId.includes('reasoning');
const isOfflineModel = modelId === 'r1-1776';

const requestBody: Record<string, unknown> = {
  model: modelId,
  messages: this.buildMessages(prompt, options?.systemPrompt),
  temperature: options?.temperature,
  max_tokens: options?.maxTokens ?? modelSpec?.maxTokens ?? 8000,
  top_p: options?.topP,
  stream: true,

  // Search on/off
  disable_search: isOfflineModel ? true : (options?.disableSearch ?? false),

  // Search configuration — only for non-offline models
  ...(isOfflineModel ? {} : {
    search_mode: options?.searchMode ?? 'web',
    enable_search_classifier: options?.enableSearchClassifier,
    search_recency_filter: options?.searchRecencyFilter,
    search_after_date_filter: options?.searchAfterDate,
    search_before_date_filter: options?.searchBeforeDate,
    last_updated_after_filter: options?.lastUpdatedAfter,
    last_updated_before_filter: options?.lastUpdatedBefore,
    search_domain_filter: options?.domainFilter,
    search_language_filter: options?.languageFilter,
    language_preference: options?.languagePreference,
    return_citations: true,       // always on for non-offline
    return_related_questions: options?.returnRelatedQuestions ?? false,
    return_images: options?.returnImages ?? false,
    web_search_options: {
      search_context_size: options?.searchContextSize ?? 'low', // API default is 'low'
      search_type: options?.searchType ?? 'auto',
    },
  }),

  // Reasoning — only for sonar-reasoning / sonar-reasoning-pro
  ...(isReasoningModel ? {
    reasoning_effort: options?.reasoningEffort ?? 'medium',
    stream_mode: options?.streamMode ?? 'full',
  } : {}),
};

// Remove undefined fields before serialising
Object.keys(requestBody).forEach(k => requestBody[k] === undefined && delete requestBody[k]);
```

Extend `PerplexityOptions` interface:

```typescript
export interface PerplexityOptions extends GenerateOptions {
  // Search on/off
  webSearch?: boolean;
  disableSearch?: boolean;
  enableSearchClassifier?: boolean;
  // Mode & recency
  searchMode?: 'web' | 'academic' | 'sec';
  searchRecencyFilter?: 'hour' | 'day' | 'week' | 'month' | 'year';
  searchAfterDate?: string;        // MM/DD/YYYY
  searchBeforeDate?: string;       // MM/DD/YYYY
  lastUpdatedAfter?: string;       // MM/DD/YYYY
  lastUpdatedBefore?: string;      // MM/DD/YYYY
  // Domain / language
  domainFilter?: string[];
  languageFilter?: string[];
  languagePreference?: string;     // ISO 639-1, controls response language
  // Result types
  returnRelatedQuestions?: boolean;
  returnImages?: boolean;
  // Quality
  searchContextSize?: 'low' | 'medium' | 'high';
  searchType?: 'fast' | 'pro' | 'auto';
  // Reasoning models only
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  streamMode?: 'full' | 'concise';
}
```

Update `PerplexityChatResponse` to include all response fields:

```typescript
interface PerplexityChatResponse {
  choices: PerplexityChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
    citation_tokens?: number;
    num_search_queries?: number;
    cost?: Record<string, number>;
  };
  citations?: string[];
  search_results?: Array<{ title: string; url: string; date?: string; snippet?: string }>;
  related_questions?: string[];
  images?: Array<{ url: string; origin: string; dimensions?: { width: number; height: number } }>;
}
```

### Phase 2 — Extract Citations and Related Questions from Stream

Perplexity delivers `citations`, `search_results`, `related_questions`, and `images` in the **final SSE chunk only**. The `extractMetadata` callback in `processNodeStream` is called on every chunk and merged — the implementation must overwrite arrays, not spread them.

#### 2a — Adapter: populate `StreamChunk.metadata`

Update `generateStreamAsync` to add:

```typescript
extractMetadata: (parsed) => {
  // These fields only appear on the final chunk; earlier chunks will have none.
  // Overwrite (not merge) to avoid stale partial data from intermediate chunks.
  const hasMeta = parsed.citations || parsed.search_results
    || parsed.related_questions || parsed.images;
  if (!hasMeta) return null;
  return {
    perplexityCitations: parsed.citations ?? [],
    perplexitySearchResults: parsed.search_results ?? [],
    perplexityRelatedQuestions: parsed.related_questions ?? [],
    perplexityImages: parsed.images ?? []  // shape: { url, origin, dimensions }
  };
}
```

In `generateWithChatCompletions` (non-streaming path), capture from the response directly:

```typescript
const perplexityMeta = {
  perplexityCitations: data.citations ?? [],
  perplexitySearchResults: data.search_results ?? [],
  perplexityRelatedQuestions: data.related_questions ?? [],
  perplexityImages: data.images ?? []
};
return this.buildLLMResponse(text, model, usage, {
  provider: 'perplexity',
  searchMode: options?.searchMode,
  ...perplexityMeta
}, finishReason);
```

#### 2b — Streaming pipeline: three-level fix required

**Confirmed full chain (verified against source):**

```
PerplexityAdapter.generateStreamAsync()
  → yields StreamChunk { content, complete, metadata: { perplexityCitations, ... } }

StreamingOrchestrator.generateResponseStream()   [src/services/llm/core/StreamingOrchestrator.ts]
  → iterates raw StreamChunk from adapter
  → reads chunk.metadata.responseId for OpenAI only (provider-guarded side-effect)
  → yields StreamYield { chunk, complete, content, toolCalls, usage } — NO metadata field
  → StreamYield is defined in ToolContinuationService.ts and has no metadata field

LLMService.generateResponseStream()
  → yield* orchestrator.generateResponseStream() — passes StreamYield as-is

StreamingResponseService.generateResponse()      [src/services/chat/StreamingResponseService.ts]
  → iterates LLMService (gets StreamYield, no metadata)
  → yields StreamingChunk { chunk, complete, messageId, ... } — NO metadata

MessageStreamHandler.streamResponse()            [src/ui/chat/services/MessageStreamHandler.ts]
  → iterates ChatService (gets StreamingChunk, no metadata)
```

**Fix 1 — `ToolContinuationService.ts`**: Add `metadata?` to `StreamYield` interface:
```typescript
export interface StreamYield {
  chunk: string;
  complete: boolean;
  content: string;
  toolCalls?: ChatToolCall[];
  toolCallsReady?: boolean;
  reasoning?: string;
  reasoningComplete?: boolean;
  usage?: TokenUsage;
  metadata?: Record<string, unknown>;  // ← ADD
}
```

**Fix 2 — `StreamingOrchestrator.ts`**: Capture metadata from final raw chunk and pass through. `StreamingOrchestrator` has **two streaming loops**: the primary loop (lines ~129–186) and a Codex 429 fallback loop (lines ~205–255). Both break on `chunk.complete` without capturing metadata. Both must be updated identically.

Declare `let finalMetadata` before the primary loop (it is reset inside the fallback block when streaming state is reset). When `chunk.complete === true` in either loop, capture `finalMetadata = chunk.metadata`. Include in the no-tool-calls final yield:

```typescript
let finalMetadata: Record<string, unknown> | undefined;

// PRIMARY LOOP — inside the for-await loop (after persistLatestResponseId):
if (chunk.complete) {
  this.persistLatestResponseId(activeProvider, chunk, options);
  finalMetadata = chunk.metadata;  // ← ADD
  break;
}

// CODEX 429 FALLBACK LOOP — reset finalMetadata with the other streaming state:
fullContent = '';
detectedToolCalls = [];
finalUsage = undefined;
finalMetadata = undefined;  // ← ADD (reset alongside other streaming state)

// Inside the fallback for-await loop (after persistLatestResponseId):
if (chunk.complete) {
  this.persistLatestResponseId(activeProvider, chunk, options);
  finalMetadata = chunk.metadata;  // ← ADD (same as primary loop)
  break;
}

// In the no-tool-calls final yield (after either loop path):
yield {
  chunk: '',
  complete: true,
  content: fullContent,
  toolCalls: undefined,
  usage: finalUsage,
  metadata: finalMetadata  // ← ADD (undefined for Claude, ChatGPT, OpenRouter, etc.)
};
```

Note: Perplexity never triggers the Codex fallback path (it's OpenAI-Codex-specific), so the fallback loop fix is purely defensive — ensuring `finalMetadata` is `undefined` rather than stale from a previous iteration if code paths ever change.

**Fix 3 — `StreamingResponseService.ts`**: Capture forwarded `chunk.metadata`, save to DB, yield on final:

```typescript
// Add to StreamingChunk interface:
metadata?: Record<string, unknown>;

// In the generateResponse() loop, alongside chunk.usage:
let accumulatedMetadata: Record<string, unknown> | undefined;
if (chunk.metadata) { accumulatedMetadata = chunk.metadata; }

// In the chunk.complete DB save block:
if (accumulatedMetadata) {
  msg.metadata = { ...(msg.metadata || {}), ...accumulatedMetadata };
}

// In the yield:
yield {
  ...,
  metadata: chunk.complete ? accumulatedMetadata : undefined  // ← ADD
};
```

**Fix 4 — `MessageStreamHandler.ts`**: Capture and apply to in-memory message:

```typescript
// Add to StreamResult interface:
metadata?: Record<string, unknown>;

// In loop:
let accumulatedMetadata: Record<string, unknown> | undefined;
if (chunk.metadata) { accumulatedMetadata = chunk.metadata; }

// In isFinalComplete block:
conversation.messages[placeholderMessageIndex] = {
  ...conversation.messages[placeholderMessageIndex],
  content: streamedContent,
  state: 'complete',
  toolCalls,
  reasoning: reasoningAccumulator || undefined,
  metadata: accumulatedMetadata  // ← ADD
};
```

**Isolation guarantee for other providers**: `finalMetadata` in `StreamingOrchestrator` is `undefined` for all non-Perplexity providers because no other adapter registers an `extractMetadata` callback — confirmed by grep (only `BaseAdapter` defines the hook; no adapter except Perplexity will use it after Phase 2a). An `undefined` value passed through all four levels is a no-op at each stage.

The existing `responseId` mechanism for OpenAI/Codex is a separate side-effect path through `persistLatestResponseId()` and `onResponsesApiId` callback — it does not touch `StreamYield.metadata` and is unaffected.

**Non-streaming path**: The chat UI exclusively uses `chatService.generateResponseStreaming()`. `generateWithChatCompletions()` is only called by non-chat consumers (e.g., `executePrompts`). Citations only need to work in the streaming path.

#### 2c — UI update: message metadata reaches `MessageBubble` automatically

After Fixes 1–4, `conversation.messages[index].metadata` is set before `onStreamingUpdate(isComplete=true)` fires. The `updateWithNewMessage()` call in the UI looks up the message from the in-memory conversation object, so `message.metadata.perplexityCitations` will be present when `updateCitations()` runs.

### Phase 3 — Citations UI in Chat (MessageBubble)

When a message has `metadata.perplexityCitations`, render a collapsible "Sources" section below the message text.

#### DOM Structure Constraints (verified against codebase)

`MessageBubble` has two render modes:

**Standard mode** (assistant without tools):
```
.message-bubble
  .message-actions-external  ← position: sticky; float: right; z-index: 20
  .message-header
  .message-content           ← markdown rendered here; cleared on every streaming update
  .perplexity-citations-panel ← append here, as last child of .message-bubble
```

**Group mode** (assistant with tools) — verified against `ToolBubbleFactory.createTextBubble()`:
```
.message-group
  .message-container.message-tool  (tool bubble)
  .message-container.message-assistant  ← this.textBubbleElement
    .message-bubble                      ← target for .querySelector('.message-bubble')
      .message-actions-external
      .message-header
      .message-content
      .perplexity-citations-panel ← append here
```
`ToolBubbleFactory.createTextBubble()` creates: `messageContainer.createDiv('message-bubble')` at line 107, then inside: `bubble.createDiv('message-actions-external')` → `bubble.createDiv('message-header')` → `bubble.createDiv('message-content')`. Structure confirmed — `this.textBubbleElement?.querySelector('.message-bubble')` is correct.

**Critical**: append `.perplexity-citations-panel` to `.message-bubble`, **never** inside `.message-content`. `updateContent()` calls `contentElement.empty()` on every streaming chunk, which would destroy any child of `.message-content`. The bubble itself is stable.

#### Float Clearance — Required CSS

`.message-actions-external` on assistant messages is `float: right`. Without explicit clearance, the citations panel may render alongside (not below) the floated pill. The panel must clear the float:

```css
.perplexity-citations-panel {
    clear: both;   /* clears the float: right pill above */
    /* ... */
}
```

#### Rendering Lifecycle — `renderContent` is async

`renderContent()` is `async` and called with `.catch()` (not awaited). The inline `[N]` → superscript replacement must be chained via `.then()`, not run synchronously after the call:

```typescript
// In updateCitations() — called after streaming completes
this.renderContent(contentElement, content).then(() => {
  linkifyCitations(contentElement, citations);
}).catch(/* ... */);
```

Do NOT attempt superscript replacement during streaming — only after `message.isLoading === false` and `metadata.perplexityCitations` is present.

#### When to Render Citations

Add `updateCitations(message: ConversationMessage)` to `MessageBubble`:
- Called from **both** `createElement()` and `updateWithNewMessage()`:
  - `createElement()`: messages loaded from storage already have `metadata.perplexityCitations` — citations must render on initial load, not just after streaming
  - `updateWithNewMessage()`: called when `!newMessage.isLoading && newMessage.metadata?.perplexityCitations`
- Checks if `.perplexity-citations-panel` already exists on the bubble (idempotent — don't render twice)
- For group mode: `this.textBubbleElement?.querySelector('.message-bubble')`
- For standard mode: `this.element?.querySelector('.message-bubble')`
- After `rebuildElement()`: since `rebuildElement()` calls `createElement()` internally, citations will re-render automatically if the `createElement()` path includes the `updateCitations()` call

#### Visual layout

```
┌─────────────────────────────────┐
│ AI response text with [1][2]... │
├─────────────────────────────────┤  ← top border, flush to bubble edges
│ ▶ Sources (3)                   │  ← collapsed by default
│   [1] Title — domain.com        │
│   [2] Title — domain.com        │
│   [3] Title — domain.com        │
└─────────────────────────────────┘
```

The `.message-bubble` has `padding: 0.75rem 1rem`. Use negative margins to make the separator flush:

```css
.perplexity-citations-panel {
    clear: both;
    margin: 0.5rem -1rem -0.75rem;  /* cancel bubble padding on 3 sides */
    padding: 0.5rem 1rem 0.75rem;   /* restore inner spacing */
    border-top: 1px solid var(--background-modifier-border);
}
```

Implementation notes:
- Each source row is a `<a>` element; open external URLs with `window.open(url, '_blank')` — **not** `openLinkText`, which is for vault-internal links
- Collapsed state toggled by a CSS class (no inline styles)
- Use `createEl` / `createDiv` — no `innerHTML` with dynamic data
- Source domain extracted via `new URL(url).hostname` for the muted subtitle
- CSS classes: `.perplexity-citations-panel`, `.perplexity-citation-row`, `.perplexity-superscript`

**Superscript inline replacement** — text node walker, run inside `.then()` after `renderContent` resolves:

```typescript
function linkifyCitations(container: HTMLElement, citations: string[]): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = (node as Text).parentElement?.closest('code, pre');
      return parent ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  const toReplace: Array<{ node: Text; matches: RegExpMatchArray[] }> = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const matches = [...node.textContent!.matchAll(/\[(\d+)\]/g)];
    if (matches.length) toReplace.push({ node, matches });
  }
  // Process in reverse to preserve offsets
  for (const { node, matches } of toReplace.reverse()) {
    // replace each [N] with <sup><a ...>[N]</a></sup>
  }
}
```

### Phase 4 — Related Questions UI

When `metadata.perplexityRelatedQuestions` is present and non-empty, render a "Continue exploring" strip below the citations panel.

```
┌─────────────────────────────────┐
│ Continue exploring:             │
│ [What is X?] [How does Y work?] │  ← clickable chips
└─────────────────────────────────┘
```

- Clicking a chip calls `ChatInput.setValue(question)` — confirmed at [ChatInput.ts:344](src/ui/chat/components/ChatInput.ts#L344); sets the contenteditable text without submitting
- `PerplexityToolbar` cannot call `chatInput.setValue()` directly — it has no reference to `ChatInput`. Pass a callback at construction: `onRelatedQuestionClicked: (question: string) => void`. `ChatView` provides `(q) => this.chatInput?.setValue(q)` when wiring the toolbar.
- If the chip text exceeds ~60 chars, truncate with ellipsis in CSS (`text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 180px`)
- CSS class: `.perplexity-related-questions`, `.perplexity-related-chip`
- Only show when `returnRelatedQuestions` is enabled in the active options

### Phase 5 — Search Controls UI (Sidebar-Safe Design)

The Nexus chat sidebar is ~280–360px wide. A full horizontal toolbar with multiple dropdowns **will not fit** at minimum width. Use a **single trigger button + popover panel** pattern instead.

#### Toolbar Mounting — Critical Structural Constraint

`ChatInput` is instantiated with `layoutElements.inputContainer` as its root `container`, and its `render()` method calls `this.container.empty()` on every render. **Any child appended to `inputContainer` will be destroyed.**

The toolbar must be a **sibling** of `inputContainer` in `chat-main`, following the same pattern as `ingestBannerContainer` and `branchHeaderContainer`:

```
chat-main (flex column)
  .chat-header
  .nexus-ingest-banner-container
  .nexus-branch-header-container
  .message-display-container
  .perplexity-toolbar-container  ← NEW — add here in ChatLayoutBuilder
  .chat-input-container          ← ChatInput.render() empties this; toolbar is safe above it
  .chat-context-container
```

**Required changes to `ChatLayoutBuilder`**:
1. Add `const perplexityToolbarContainer = mainContainer.createDiv('perplexity-toolbar-container')` before `inputContainer`
2. Add `perplexityToolbarContainer: HTMLElement` to `ChatLayoutElements` interface
3. Return it from `buildLayout()`

`PerplexityToolbar` receives this container element and mounts into it. Show/hide is triggered from `ChatView.handleModelChanged()` — confirmed in [ChatView.ts:1241](src/ui/chat/ChatView.ts#L1241), currently near-empty and the correct hook:

```typescript
private handleModelChanged(model: any | null): void {
  this.updateContextProgress();
  // ADD:
  this.perplexityToolbar?.setVisible(model?.provider === 'perplexity');
}
```

#### `PerplexityToolbar` Component

Extends `Component` (not `Modal`), enabling native `registerDomEvent` for all listeners. **Do not** use raw `addEventListener`.

Constructor signature:
```typescript
constructor(
  container: HTMLElement,
  onRelatedQuestionClicked: (question: string) => void,  // ← ChatView provides this
  component: Component  // parent component for registerDomEvent scope
)
```

`ChatView` wires it as:
```typescript
this.perplexityToolbar = new PerplexityToolbar(
  this.layoutElements.perplexityToolbarContainer,
  (q) => this.chatInput?.setValue(q),
  this
);
```

```css
.perplexity-toolbar-container {
    flex-shrink: 0;
    /* shown/hidden by JS — no border-top when hidden avoids layout gap */
}

.perplexity-toolbar-container.is-visible {
    border-top: 1px solid var(--background-modifier-border);
    padding: 6px 12px;
}
```

#### Popover Dismiss Behaviour

The popover opens inline below the trigger. Two dismiss paths, both using `registerDomEvent`:

```typescript
// 1. Click outside — registered when popover opens, unregistered when it closes
const outsideClickHandler = (e: MouseEvent) => {
  if (!this.popoverEl.contains(e.target as Node)
    && !this.triggerEl.contains(e.target as Node)) {
    this.closePopover();
  }
};
this.registerDomEvent(document, 'click', outsideClickHandler);

// 2. Escape key
this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape' && this.isOpen) this.closePopover();
});
```

Use a class toggle (`.perplexity-toolbar-popover.is-open`) to show/hide — **not** inline `display` style.

#### Z-Index for Popover

- `.message-actions-external` (assistant): `z-index: 20`
- `.chat-sidebar`: `z-index: 100`
- Toolbar popover must sit between: use `z-index: 50`

#### Compact trigger (always visible when Perplexity is active):

```
┌─────────────────────────────────────────┐
│  [🔍 Web · Any recency · low ctx ▾]     │
└─────────────────────────────────────────┘
```

The label is a summary of current settings. Clicking opens the popover inline below.

#### Popover panel (inline below trigger, not a floating modal):

```
┌──────────────────────────────────┐
│ Search mode     [Web ▾]          │
│ Recency         [Any ▾]          │
│ Context size    [Low ▾]          │
│ Related Qs      [Toggle]         │
│ Domains         [+ add domain]   │
│                                  │
│ ─── Advanced ───                 │
│ Search type     [Auto ▾]         │
│ Date from       [MM/DD/YYYY]     │
│ Date to         [MM/DD/YYYY]     │
│ Language        [text input]     │
└──────────────────────────────────┘
```

Controls:
- **Mode**: Web / Academic / SEC / Off (`disable_search: true`)
- **Recency**: Any / Past hour / Past day / Past week / Past month / Past year
- **Context size**: Low (default) / Medium / High — label each with cost implication
- **Related questions toggle**: on/off
- **Domain filter**: tag-input style; prefix `-` to exclude; UI label clarifies allowlist vs. denylist (cannot mix)
- **Advanced section** (collapsed by default): search type, date range, language preference

**`r1-1776` handling**: Replace popover content with notice: "Offline model — web search disabled."

**Reasoning model handling**: Show "Reasoning depth" dropdown (Minimal / Low / Medium / High) when `sonar-reasoning` or `sonar-reasoning-pro` is active.

**`sonar-deep-research` handling**: Show rate limit notice inline in the trigger or popover header.

#### Per-conversation persistence

Settings stored in `ConversationMetadata.metadata.perplexityOptions` — uses the existing `metadata?: Record<string, unknown>` catch-all in `src/types/storage/HybridStorageTypes.ts`. Load on conversation switch; save on option change via `ConversationService.updateConversationMetadata`.

### Phase 6 — Settings Defaults

Add a Perplexity section to `DefaultsTab`:
- Default search mode (Web / Academic / SEC)
- Default recency filter
- Default context size — label the options with cost implications: "Low (default, cheapest) / Medium / High (most thorough, costs more)"
- Return related questions toggle (default: on)
- Return images toggle (default: off)
- Default reasoning depth for reasoning models (Minimal / Low / Medium / High)

Add a note near `sonar-deep-research` in the model list or settings: *"Deep Research incurs higher costs and has strict rate limits. Suitable for long-form research tasks, not conversational use."*

---

## Files to Change

| File | Change |
|------|--------|
| `src/services/llm/adapters/perplexity/PerplexityAdapter.ts` | Fix request body; remove `presence_penalty`/`frequency_penalty`; gate reasoning params; force `disable_search` for r1-1776; extract all metadata fields from response |
| `src/services/llm/adapters/perplexity/PerplexityModels.ts` | Verify `sonar-reasoning` is present; confirm `sonar-deep-research` and `sonar-reasoning-pro`; add rate-limit metadata if needed |
| `src/services/llm/core/ToolContinuationService.ts` | Add `metadata?: Record<string, unknown>` to `StreamYield` interface |
| `src/services/llm/core/StreamingOrchestrator.ts` | Capture `chunk.metadata` on `chunk.complete`; pass through in final `StreamYield` |
| `src/services/chat/StreamingResponseService.ts` | Add `metadata?` to `StreamingChunk` interface; accumulate; save to DB; yield on final |
| `src/ui/chat/services/MessageStreamHandler.ts` | Add `metadata?` to `StreamResult`; capture forwarded `chunk.metadata`; include in final in-memory message update |
| `src/ui/chat/builders/ChatLayoutBuilder.ts` | Add `perplexityToolbarContainer` div before `inputContainer`; add to `ChatLayoutElements` interface and `buildLayout()` return |
| `src/ui/chat/components/PerplexityToolbar.ts` | **New** — extends `Component`; compact trigger + popover; `registerDomEvent` for all listeners |
| `src/ui/chat/components/MessageBubble.ts` | Add `updateCitations()` method called from both `createElement()` and `updateWithNewMessage()`; append `.perplexity-citations-panel` to `.message-bubble`; superscript inline links; related questions strip |
| `src/ui/chat/ChatView.ts` | Wire `PerplexityToolbar` into `layoutElements.perplexityToolbarContainer`; call `setVisible()` from `handleModelChanged()` |
| `src/settings/tabs/DefaultsTab.ts` | Add Perplexity defaults section |
| `styles.css` | `.perplexity-toolbar-container`, `.perplexity-toolbar-container.is-visible`, `.perplexity-toolbar-popover` (z-index: 50), `.perplexity-citations-panel` (clear: both; negative margins), `.perplexity-citation-row`, `.perplexity-superscript`, `.perplexity-related-questions`, `.perplexity-related-chip` |

## Dependencies
- No other plan dependencies
- `ConversationMetadata.metadata` (already `Record<string, unknown>`) — no type change required

## Estimated Complexity
Medium-High. Phase 1–2 are adapter-only (low risk). Phase 3 has a subtle ordering dependency (markdown render → DOM walk). Phase 5 requires careful sidebar layout work — the popover pattern avoids the width constraint but needs thoughtful focus/dismiss handling.

## Provider Isolation Analysis

All changes to shared pipeline files are additive and safe for non-Perplexity providers (Claude, ChatGPT, OpenRouter, Groq, Mistral, Ollama, LM Studio, etc.):

| Shared file changed | Impact on other providers |
|---------------------|--------------------------|
| `ToolContinuationService.ts` — add `metadata?` to `StreamYield` | Optional field, `undefined` for all non-Perplexity adapters. Zero behaviour change. |
| `StreamingOrchestrator.ts` — capture `finalMetadata = chunk.metadata` | No other adapter registers `extractMetadata`; their `StreamChunk.metadata` is always `undefined`. `finalMetadata` is `undefined` → passed through as `undefined` → no-op at every downstream stage. |
| `StreamingResponseService.ts` — capture `chunk.metadata` | `undefined` for non-Perplexity → no DB write, no yield change. |
| `MessageStreamHandler.ts` — `metadata: accumulatedMetadata` in message | `undefined` → existing message object unchanged (spread of `undefined` is a no-op). |
| `MessageBubble.ts` — `updateCitations()` called from `createElement` / `updateWithNewMessage` | Guard: `if (!message.metadata?.perplexityCitations) return`. Non-Perplexity messages never have this key. Zero DOM changes for other providers. |
| `ChatLayoutBuilder.ts` — new `perplexityToolbarContainer` div | Empty div, hidden via `display: none` on the base class. No height, no border, no padding in non-visible state. Zero layout impact for other providers. The CSS must set `display: none` by default (not only absent on `.is-visible`). |
| `ChatView.ts` — `handleModelChanged()` calls `setVisible(provider === 'perplexity')` | Called for every provider change. Non-Perplexity → `setVisible(false)` hides the container. Existing `updateContextProgress()` call is unchanged. |
| `styles.css` — new `.perplexity-*` classes | All new selectors. No overlap with existing classes. No cascade side-effects. |

**OpenAI `responseId` mechanism is unaffected**: `persistLatestResponseId()` in `StreamingOrchestrator` reads `chunk.metadata?.responseId` from raw adapter chunks directly, fires `onResponsesApiId` callback, and writes to a private `Map`. This side-effect path is completely separate from the `StreamYield.metadata` field being added and is guarded by `provider !== 'openai' && provider !== 'openai-codex'`.

**CSS isolation**: All new rules are `.perplexity-`-prefixed. The `clear: both` on `.perplexity-citations-panel` is scoped to that class and cannot affect floats in other messages. The negative margins are also scoped. No existing rule is modified.

**One CSS fix required**: The base `.perplexity-toolbar-container` class must include `display: none` so the empty container has zero layout footprint when Perplexity is not active:

```css
.perplexity-toolbar-container {
    display: none;   /* hidden by default — zero layout impact for all other providers */
    flex-shrink: 0;
}

.perplexity-toolbar-container.is-visible {
    display: block;
    border-top: 1px solid var(--background-modifier-border);
    padding: 6px 12px;
}
```

## Known Risks
1. **`ChatInput.render()` destroys `inputContainer` children**: Confirmed in code — `render()` calls `this.container.empty()`. The `PerplexityToolbar` **must not** mount inside `inputContainer`. The `perplexityToolbarContainer` sibling approach is the only safe option.
2. **`updateContent()` destroys `.message-content` children on every stream chunk**: Confirmed — `contentElement.empty()` is called at line 337 in `MessageBubble.ts`. Citations panel must be a child of `.message-bubble`, not `.message-content`.
3. **`float: right` pill requires `clear: both` on citations panel**: The `.message-actions-external` on assistant messages is `float: right`. Without `clear: both` on `.perplexity-citations-panel`, the panel may render beside the pill instead of below it.
4. **`renderContent` is async — superscript replacement must be in `.then()`**: Cannot run the `[N]` → superscript DOM walk synchronously after `renderContent()` is called. Must chain in `.then()`. Citations should only be rendered once per message (after `isLoading === false`).
5. **Three-level metadata stripping confirmed**: `StreamingOrchestrator` strips metadata from `StreamYield`; `StreamingResponseService` then receives it without metadata; `MessageStreamHandler` is further downstream. Four files need changes (Phase 2b Fixes 1–4). The existing OpenAI `responseId` side-effect path is isolated and unaffected.
10. **`StreamingOrchestrator` has a second (Codex 429 fallback) streaming loop**: Lines ~205–255 duplicate the primary streaming loop for the OpenAI Codex 429 rate-limit fallback case. Both loops must set `finalMetadata = chunk.metadata` on `chunk.complete`. The fallback is never triggered for Perplexity, but `finalMetadata` must be reset to `undefined` alongside the other streaming state at the top of the fallback block to prevent a stale value leaking through if code paths ever change. See Fix 2 detail in Phase 2b.
6. **`presence_penalty`/`frequency_penalty` sent to Perplexity — confirmed bug**: These are OpenAI-specific params not in Perplexity's API spec. Already in the current adapter at lines 91–92 and 197–198. Likely causing 422 errors silently if Perplexity rejects them, or being silently ignored. Remove in Phase 1.
7. **Streaming citation timing**: If `processNodeStream` completes before the metadata chunk is fully buffered, citations may arrive empty. Test with a slow network and with `sonar-deep-research` (longest stream).
8. **`sonar-deep-research` timeout**: Can take 30–120s for complex queries. The existing 120s stream timeout in the adapter may be insufficient. Consider extending to 180s or making it model-specific.
9. **`createElement()` must also call `updateCitations()`**: Messages loaded from storage already have `metadata.perplexityCitations`. If `updateCitations()` is only called from `updateWithNewMessage()`, historical messages will never show citation panels. Confirmed: both paths need the call.
