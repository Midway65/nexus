# Nexus — Complete Security Audit

**Date:** 2026-06-02
**Version reviewed:** v5.9.9 (local fork `my-custom-branch`, essentially congruent with upstream `claudesidian-mcp`)
**Scope:** Full codebase (826 TS files) across 7 attack surfaces + dependency audit
**Method:** Parallel focused source review (secrets, MCP/HTTP server, process execution, filesystem/path traversal, injection/SSRF/deserialization, DOM/XSS) + `npm audit`

---

## Remediation status — re-checked 2026-09-01 (fork at v5.16.4)

Re-verified every finding against the working tree, 3 months and 7 upstream releases after the
audit. **4 fixed, 2 partially fixed, 2 open, 1 materially improved.**

Provenance note: none of these fixes came from this audit. It was never submitted upstream (the
`-github.md` submission copy still sits unsent). Upstream red-teamed their own local CLI bridge in
July, found the path-traversal class independently, and shipped `db10ccbd` — *"5.15.0 — Local CLI
bridge + post-audit security hardening (#292)"* — which is where `src/core/vaultPath.ts` comes
from. The fork inherited all of it through the normal merge train. Two independent audits
converging on the same top finding is corroboration, not duplication.

| # | Sev | Finding | Status | Evidence |
|---|-----|---------|--------|----------|
| 1 | 🔴 HIGH | ElevenLabs arbitrary file write | ✅ **FIXED** | All three tools (`textToSpeech`, `soundEffects`, `musicGeneration`) route `outputPath` through `tryResolveVaultPath` before `createBinary`. |
| 2 | 🟠 MED | WebTools SSRF | ⚠️ **PARTIAL** | A scheme guard landed at [`webViewer.ts:56-69`](../../src/agents/apps/webTools/utils/webViewer.ts#L56) — http/https only, so `file://` is blocked. The audit's actual concern is **not** addressed: no allowlist and no private-address check, so `169.254.169.254`, `localhost` and RFC-1918 remain reachable over http, read-back oracle intact. |
| 3 | 🟠 MED | `javascript:` URL in streaming markdown | ❌ **OPEN** | [`MarkdownRenderer.initializeStreamingParser`](../../src/ui/chat/utils/MarkdownRenderer.ts) still hands `smd.default_renderer(contentDiv)` straight to the parser with no scheme sanitization on the streaming path. |
| 4 | 🟠 MED | Core tools path traversal | ✅ **FIXED** | The shared gate the audit asked for exists: [`src/core/vaultPath.ts`](../../src/core/vaultPath.ts) (`tryResolveVaultPath` / `resolveVaultPath` / `VaultPathError` / `vaultPathFromTrusted`), wired through 18 call sites incl. `FileOperations`, `ContentOperations`, `CanvasOperations`, `BaseFileOperations`. `FileOperations.moveNote` confines **both** source and destination. |
| 5 | 🟠 MED | Dependency vulnerabilities | 🔶 **IMPROVED, partly open** | 20 (2 critical, 10 high) → **9 (0 critical, 7 high)**. The critical `protobufjs`/`handlebars` code-injection pair is gone with the dependency slimming. Eight of the nine remaining are dev-tree only (`hono`, `@hono/node-server`, `body-parser`, `brace-expansion`, `browserslist`, `fast-uri`, `ip-address`, `js-yaml`) and are not shipped. **One is a shipped runtime dep and worth a decision: `pdfjs-dist` HIGH — arbitrary JavaScript execution on opening a malicious PDF**, directly reachable from the ingest path. |
| 6 | 🟡 LOW | Dormant HTTP transport | ✅ **FIXED by deletion** | `HttpTransportManager.ts` removed in `50ba6047` "Remove unused HTTP MCP transport". Only `HttpTransportStatus.ts` remains in `src/server/transport/`. The loaded gun was unloaded rather than hardened — the right call. |
| 7 | 🟡 LOW | Unix socket `0o666` | ✅ **FIXED** | [`IPCTransportManager.ts`](../../src/server/transport/IPCTransportManager.ts#L282) now wraps the synchronous `listen()` in a `0o177` umask so the socket is *born* `0o600`, with a synchronous `chmodSync(ipcPath, 0o600)` backstop. The fix explicitly closes the race the audit did not raise. |
| 8 | 🟡 LOW | Vault-cwd + `--dangerously-skip-permissions` | ⚠️ **PARTIAL** | `GoogleGeminiCliAdapter` now documents the trust assumption and no longer passes the flag. `AnthropicClaudeCodeAdapter.ts:126` and `ClaudeHeadlessService.ts:145` still pass it unconditionally. |
| 9 | 🟡 LOW | Vault file logger has no redaction | ❌ **OPEN** | [`Logger.ts`](../../src/services/llm/utils/Logger.ts) still writes to `.nexus/logs` with no key-redaction filter. |

### What upstream's v5.17–5.18 security work is *not*

Two commits in the unmerged range look security-adjacent but answer a different question —
Obsidian's **community scorecard**, not this audit:

- `919d725f` — `BaseAdapter.buildHeaders()` was sending `User-Agent: Synaptic-Lab-Kit/1.0.0`, and
  `RequestyAdapter` hardcoded a dead `HTTP-Referer` domain. A branding/attribution correction.
- `fecda0ef` — a README section disclosing outbound network calls.

Neither touches findings #1–#9.

### Suggested next actions

1. **#5 `pdfjs-dist`** — the only shipped-runtime vulnerability. Check whether a patched version is
   available and whether the fork's PDF path (`PdfJsLoader`, `PdfTextExtractor`, `PdfPageRenderer`)
   can take it without a rebuild of the legacy-build worker seeding. Note the standing repo rule:
   **no `npm audit fix`** — bump deliberately or not at all.
2. **#2 SSRF** — the remaining half is the exploitable half. A private-address/metadata-endpoint
   deny check next to the existing scheme guard is a small, self-contained patch and a clean
   upstream PR candidate.
3. **#3 and #9** are both still open and both cheap; neither has moved in 3 months.
4. If any of #2/#3/#9 get fixed here rather than upstream, they become new fork divergences —
   register them in [`docs/fork_divergence.md`](../fork_divergence.md) and offer them upstream, per
   the fork's full-congruence goal.

---

## Threat model

A local Obsidian plugin that:
1. Runs a local MCP server consumed by Claude Desktop (IPC transport).
2. Executes LLM-driven tools (`useTools`) against the vault.
3. Processes **untrusted content** — notes, fetched web pages, ingested PDF/docx/pptx files — any of which may carry a **prompt-injection** payload.

The primary adversary is **prompt injection** (untrusted content steering the LLM into hostile tool calls), not a remote network attacker. The two findings that most expand prompt-injection blast radius are #1 (arbitrary file write) and #2 (SSRF + read-back).

---

## Overall assessment

The codebase is **notably defensive and well-architected for security.** No Critical or High findings exist on the *active* attack surface. Verified strengths include hardened HTTPS enforcement, safe arg-array process spawning, careful OAuth/credential handling, a ReDoS-free hand-rolled CLI parser, and broad compliance with the no-`innerHTML` UI rule. Real risks cluster in three areas: an unvalidated file-write path in the ElevenLabs app, missing SSRF guards in the WebTools agent, and vulnerable transitive dependencies (mostly dormant/DoS).

---

## Severity summary

| Sev | Finding | Location |
|-----|---------|----------|
| **HIGH** | ElevenLabs audio tools write LLM-chosen paths with no `..`/absolute guard → arbitrary binary file write | `src/agents/apps/elevenlabs/tools/textToSpeech.ts:113-126` (+ soundEffects.ts, musicGeneration.ts) |
| **MEDIUM** | WebTools agent has no URL allowlist → SSRF to `169.254.169.254`/localhost/RFC-1918 + read-back oracle | `src/agents/apps/webTools/utils/webViewer.ts:55-79`, `extractLinks.ts` |
| **MEDIUM** | Streaming markdown renders `javascript:` URLs unsanitized during the streaming window | `src/ui/chat/utils/MarkdownRenderer.ts:59` (streaming-markdown lib) |
| **MEDIUM** | Core ContentManager/StorageManager/Canvas destination paths lack explicit traversal validation | `write.ts`, `move.ts`, `copy.ts`, `archive.ts`, `CanvasOperations.ts` |
| **MEDIUM** | 20 dependency vulns (2 critical, 10 high) incl. protobufjs/handlebars code-injection in bundled ML stack | `package.json` transitive deps |
| **LOW** | Dormant HTTP transport: `cors:'*'`, no auth, no DNS-rebinding protection, binds TCP:3000 — never started ("loaded gun") | `src/server/transport/HttpTransportManager.ts:46-50` |
| **LOW** | Unix domain socket created `0o666` (world-accessible) in `/tmp` — multi-user-host data boundary | `src/server/transport/IPCTransportManager.ts:249-252` |
| **LOW** | Vault-cwd + hardcoded `--dangerously-skip-permissions` for Claude Code/Gemini CLI adapters | `AnthropicClaudeCodeAdapter.ts:126,152` |
| **LOW** | Vault file logger has no key-redaction filter (latent; writes to synced `.nexus/logs`) | `src/services/llm/utils/Logger.ts:273-333` |
| INFO | API keys plaintext in `data.json` — unavoidable (no Obsidian secrets API); not git-tracked | `src/core/PluginDataManager.ts` |

---

## Detailed findings

### 1. HIGH — Arbitrary file write via ElevenLabs `outputPath`

The ElevenLabs app's three write tools (`textToSpeech`, `soundEffects`, `musicGeneration`) take `params.outputPath` directly from the LLM/MCP caller, pass it through Obsidian's `normalizePath` only — which **collapses slashes but does not strip `..` segments** (documented in the codebase itself at `src/agents/apps/skills/services/skillPaths.ts:9-12`) — then call `vault.createFolder(dir)` and `vault.createBinary(outputPath, ...)`.

```ts
// src/agents/apps/elevenlabs/tools/textToSpeech.ts:113-126
const outputPath = normalizePath(params.outputPath || `audio/tts-${Date.now()}.mp3`);
const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
if (dir && !vault.getAbstractFileByPath(dir)) { await vault.createFolder(dir); ... }
await vault.createBinary(outputPath, response.arrayBuffer);
```

Sibling apps (Composer `compose.ts:93`, DataAnalysis `runPython.ts:81`) correctly guard with `isValidPath()`; ElevenLabs does not import it. A prompt-injected payload supplying `outputPath: "../../../../<path>"` could write attacker-controlled **binary** bytes outside the vault. This is the single highest-leverage write primitive found (binary, no existing-file resolution to limit it).

**Fix:** add `isValidPath(params.outputPath)` rejection to all three tools, matching `compose.ts` / `runPython.ts`.

### 2. MEDIUM — SSRF in WebTools agent (no URL validation)

`openWebViewerUrl` feeds the caller-supplied `url` straight into Obsidian's Web Viewer webview with **zero scheme/host validation**:

```ts
// src/agents/apps/webTools/utils/webViewer.ts:63-71
await leaf.setViewState({ type: WEB_VIEWER_VIEW_TYPE, active: focus,
  state: { url, title: url, navigate: true } });
```

`extractLinks.ts` then runs `executeJavaScript` against the loaded page and returns `document.links` to the model — making the webview a **read-back oracle**. A prompt injection can drive the plugin to load `http://169.254.169.254/latest/meta-data/` (cloud metadata), `http://localhost:<port>`, internal RFC-1918 hosts, or `file://`, exfiltrate the rendered content back into the conversation, then stage it into a synced note via `content write` / `captureToMarkdown`. Gated behind the WebTools app being enabled (desktop only), but unguarded once enabled.

**Fix:** before `openWebViewerUrl`, allowlist `http:`/`https:` schemes and block `localhost`/`127.0.0.0/8`/`::1`/RFC-1918/`169.254.0.0/16`/`fc00::/7`, with an explicit opt-in override setting.

### 3. MEDIUM — `javascript:` URL injection in streaming markdown

The live streaming LLM renderer uses `streaming-markdown`'s `default_set_attr`, which sets `href`/`src` with **no scheme validation** (`MarkdownRenderer.ts:59` → `node_modules/streaming-markdown/smd.js:1622`). A response like `[click](javascript:...)` produces a live `<a href="javascript:...">` in the Electron renderer.

Two mitigations limit this to MEDIUM:
- streaming-markdown builds the DOM via `createElement`/`createTextNode` (raw `<script>`/`onerror=` text **cannot** be injected — only the URL scheme of legitimately-parsed links is attacker-controlled).
- The finalize/reload path re-renders through Obsidian's native renderer, which neutralizes `javascript:`.

**Gap:** `finalizeStreamingContent` (`MarkdownRenderer.ts:102`) only re-renders when `hasAdvancedMarkdownFeatures()` is true. A message whose only rich element is a plain `[text](javascript:...)` link matches none of those patterns, so the unsafe streaming DOM **persists in the live view until the conversation is reloaded.**

**Fix:** wrap the streaming-markdown renderer to allowlist URL schemes (`http:`, `https:`, `mailto:`, `obsidian:`, `app://`, relative), or always finalize through Obsidian's renderer regardless of `hasAdvancedMarkdownFeatures`.

### 4. MEDIUM — Inconsistent path-traversal defense in core tools

Core ContentManager/StorageManager/CanvasManager tools strip only a leading slash and rely entirely on Obsidian's indexed Vault API for confinement; none call the plugin's own `ObsidianPathManager.validatePath` (`src/.../ObsidianPathManager.ts:51-89`), which correctly rejects `..`/`~`/absolute/drive paths.

- For **reads/moves of existing files** this is largely self-limiting: `getAbstractFileByPath` only resolves vault-indexed entries, so an outside-vault path no-ops with "not found."
- Residual risk is on the **create/destination** side: `write` (new file), `copy`/`move` `newPath`, `archive` target, `createFolder`, and canvas `write` pass an unvalidated, `..`-bearing destination into `vault.create`/`vault.rename`/`vault.createFolder`. Confinement is not asserted in-code.

Note: three different normalizers exist (`pathUtils.normalizePath` leading-slash-only, `ContentOperations.normalizePath` identical, Obsidian's `normalizePath`) — none strip `..`. The newer "app" agents (Skills especially, via `assertInside`) are best-in-class and are the model to follow.

**Fix:** add a single shared `assertVaultRelative(path)` gate (reuse `isValidPath`/`assertInside`) and apply it to every destination/create/write path in the core tools.

### 5. MEDIUM — Dependency vulnerabilities (`npm audit`: 20 total — 2 critical, 10 high, 8 moderate)

| Sev | Package | Issue | Reachability |
|-----|---------|-------|-------------|
| CRITICAL | `protobufjs` | Arbitrary code execution, prototype injection | Transitive under `@xenova/transformers` / `@huggingface/transformers` (embeddings) |
| CRITICAL | `handlebars` | JS injection via AST type confusion, prototype pollution | Transitive (build/ML tooling) |
| HIGH | `@modelcontextprotocol/sdk` | ReDoS; DNS-rebinding off by default; cross-client data leak | Direct dep — live MCP path |
| HIGH | `tar` | Path-traversal/symlink poisoning on extraction | Transitive only — **no tar extraction exists in `src/`** (N/A in practice) |
| HIGH | `path-to-regexp`, `fast-uri`, `picomatch` | ReDoS / path traversal | Express 5 + glob — only live if HTTP transport enabled (it is dormant) |
| HIGH | `onnxruntime-web`, `onnx-proto` | via protobufjs | ML inference path |
| HIGH | `fast-xml-builder` | attribute injection | XML build (ingest) |
| MODERATE | `body-parser`, `qs`, `brace-expansion`, `yaml`, `js-yaml`, `uuid`, `fast-xml-parser`, `@protobufjs/utf8` | DoS / prototype pollution | Mixed; most DoS or dormant |

Most are **DoS or reachable only in dormant code paths** (the HTTP transport, unused tar). The protobufjs/handlebars criticals warrant attention.

**Fix:** run `npm audit fix`; bump `@modelcontextprotocol/sdk`; confirm protobufjs is not reachable at runtime in the embedding/WebLLM paths (or that those paths only process trusted model files).

### 6. LOW findings (hardening)

- **Dormant HTTP transport** — `HttpTransportManager` is constructed (`MCPServer.ts:79`) but its `startTransport()` is **never called**; the live transport is IPC named-pipe (Windows) / Unix-socket (macOS/Linux) only, with no network exposure. But the dead code carries `cors({origin:'*'})`, no auth, and no `enableDnsRebindingProtection`/`allowedHosts` on `StreamableHTTPServerTransport`. If anyone ever wires it into the lifecycle, it becomes a browser-reachable, unauthenticated, full-vault `useTools` endpoint (a malicious web page could POST to `http://localhost:3000/mcp`). **Delete it, or pre-harden** (bind `127.0.0.1`, `cors({origin:false})`, `enableDnsRebindingProtection:true`, `allowedHosts:['127.0.0.1:3000']`, body limit) before it can ever be enabled.
- **Unix socket `0o666`** (`IPCTransportManager.ts:249-252`) — world-accessible in `/tmp`; on a multi-user host any local user can connect and drive full `useTools` (the IPC channel has no auth — by design, the socket *is* the trust boundary). Use `0o600`. Windows named pipes use current-user ACLs, so this is Unix-specific.
- **Vault-cwd + `--dangerously-skip-permissions`** — Claude Code/Gemini CLI adapters spawn with `cwd: vaultPath` and skip-permissions hardcoded (`AnthropicClaudeCodeAdapter.ts:126,152`). A planted `CLAUDE.md`/project-settings file in an untrusted vault could influence the spawned agent. MCP config is pinned (`--strict-mcp-config` + explicit `--mcp-config`), which limits the worst case. Document that these providers shouldn't run on untrusted vaults, or use a neutral temp cwd.
- **Logger redaction** — `Logger.ts:273-333` serializes full `metadata` to synced `.nexus/logs/*.log` with no scrubbing. No active key leak found, but add a redaction pass on keys matching `/key|token|secret|authorization|bearer/i` before write (defense-in-depth — this is the one sink writing structured data to a synced location).

---

## Verified secure (positives)

- **Process spawning** — every `child_process` call uses arg-array `spawn` (never shell-string concat); untrusted payloads (prompts, system prompts, MCP config) go via stdin/temp-files, never argv; `shell:true` is set only for Windows `.cmd`/`.bat` wrappers where the command is a discovered binary path; binary names in the one `execSync` (`where`/`which`) path are hardcoded literals. Spawned env strips provider API keys. **No command injection.**
- **Credential handling** — HTTPS enforced on all key-bearing requests (`ProviderHttpClient.enforceHttps`); all cloud base URLs hardcoded (no user-controllable key-redirect SSRF); only keyless local providers (Ollama/LMStudio) take a user URL; `getApiKey()` masks to `***+last4`; OAuth uses PKCE-S256 + `crypto.timingSafeEqual` CSRF check + 127.0.0.1-only single-use callback; Claude Code/Gemini CLI auth returns sentinels and never extracts the real token; no hardcoded secrets; no keys in traces/conversation JSONL.
- **CLI parser** (`ToolCliNormalizer.ts`) — single-pass O(n), ReDoS-free; params bound only to schema-derived names → no prototype pollution; no `eval`/`new Function` on untrusted input. (The one `new Function` in `HucreEnsurer.ts:115` wraps a vendored local asset URL, not untrusted data.)
- **Deserialization** — uses safe `yaml@2` (not `js-yaml.load` with custom tags) for frontmatter; `fast-xml-parser` v5 doesn't expand external entities (no classic XXE); config merge uses object spread, not `__proto__`-walking deep merge.
- **DOM/XSS** — broadly compliant with `createEl`/`textContent`; the two literal `innerHTML` uses are benign (escape idiom + static empty-string clear); no `BrowserWindow`/`nodeIntegration`/`<webview>`/`srcdoc` with untrusted content; `executeJavaScript` called only with static scripts (one numeric interpolation, coerced).
- **MCP input** — schema-validated against each tool's `getParameterSchema()`; allowlist agent routing; no dynamic dispatch; no RCE reachable from `getTools`/`useTools`. The data-analysis `runPython` executes in a Pyodide WASM worker (off-thread, no Node, network-isolated, path-jailed).

---

## Prioritized remediation

1. **HIGH** — Add `isValidPath()` to ElevenLabs `outputPath` in all 3 tools (smallest, highest-impact fix).
2. **MEDIUM** — Add SSRF URL guard to `webViewer.openWebViewerUrl` (collapses the prompt-injection exfiltration loop).
3. **MEDIUM** — Sanitize URL schemes in the streaming-markdown render path (or always finalize through Obsidian's renderer).
4. **MEDIUM** — `npm audit fix` + bump `@modelcontextprotocol/sdk`; confirm protobufjs/handlebars unreachable at runtime.
5. **MEDIUM** — Add a shared `assertVaultRelative()` gate to all core-tool destination paths.
6. **LOW** — Delete/pre-harden the dormant HTTP transport; `0o600` the Unix socket; add logger redaction; document the untrusted-vault trust assumption for CLI providers.

**Single most important takeaway:** prompt injection is the primary threat vector. The two findings that most expand its blast radius are #1 (arbitrary file write) and #2 (SSRF + read-back). Fixing those two, plus the dependency bumps, addresses the bulk of the real risk.
