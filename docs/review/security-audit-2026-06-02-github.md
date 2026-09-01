<!--
SUBMISSION GUIDANCE
- Findings #1 (arbitrary file write) and #2 (SSRF) are exploitable. Prefer a PRIVATE
  GitHub Security Advisory (repo → Security → Advisories → "Report a vulnerability")
  over a public issue for those, to avoid disclosing a working exploit path before a fix.
- The LOW/dependency items are fine as a public issue.
- Suggested title and labels are at the top of this document.
-->

> **Suggested title:** `Security audit (v5.9.9): arbitrary file write, WebTools SSRF, streaming-markdown XSS + 5 hardening items`
> **Suggested labels:** `security` · `bug` · `dependencies`
> **Affected version:** v5.9.9 · **Platforms:** desktop (Electron); SSRF/process items desktop-only

> [!IMPORTANT]
> **NOT SUBMITTED (status added 2026-09-01).** This is the submission copy; it was never sent to
> `ProfSynapse/nexus`. Do not file it as-is — 4 of the 9 findings have since been fixed upstream
> (independently, via their own `#292` post-audit hardening) and 2 more are partially fixed.
> Current per-finding status lives in
> [`security-audit-2026-06-02.md`](./security-audit-2026-06-02.md#remediation-status--re-checked-2026-09-01-fork-at-v5164).
> If submitting now, cut it down to what is still open: **#2 (SSRF — the private-address half),
> #3 (`javascript:` URLs in streaming markdown), #9 (logger redaction)**, plus the shipped
> `pdfjs-dist` advisory from #5. #2 and #3 are the two that still warrant a private advisory.

## Summary

A full security audit of Nexus v5.9.9 across 7 attack surfaces plus a dependency scan. The codebase is **well-architected for security** — no Critical/High issues on the *active* attack surface. The real risks are **reachable via prompt injection** (untrusted note/web/ingest content steering the LLM into hostile tool calls), which is the primary threat model for this plugin.

This report contains **1 HIGH, 4 MEDIUM, and 4 LOW** findings.

> [!WARNING]
> Findings **#1 (arbitrary file write)** and **#2 (SSRF + read-back)** are exploitable through prompt injection. Consider handling these two via a **private Security Advisory** rather than a public issue.

## Severity overview

| # | Sev | Finding | Location |
|---|-----|---------|----------|
| 1 | 🔴 **HIGH** | ElevenLabs audio tools write LLM-chosen paths with no `..`/absolute guard → arbitrary binary file write | `src/agents/apps/elevenlabs/tools/textToSpeech.ts:113-126` (+ `soundEffects.ts`, `musicGeneration.ts`) |
| 2 | 🟠 **MEDIUM** | WebTools agent has no URL allowlist → SSRF to `169.254.169.254`/localhost/RFC-1918 + read-back oracle | `src/agents/apps/webTools/utils/webViewer.ts:55-79`, `extractLinks.ts` |
| 3 | 🟠 **MEDIUM** | Streaming markdown renders `javascript:` URLs unsanitized during the streaming window | `src/ui/chat/utils/MarkdownRenderer.ts:59` |
| 4 | 🟠 **MEDIUM** | Core ContentManager/StorageManager/Canvas destination paths lack explicit traversal validation | `write.ts`, `move.ts`, `copy.ts`, `archive.ts`, `CanvasOperations.ts` |
| 5 | 🟠 **MEDIUM** | 20 dependency vulns (2 critical, 10 high) incl. protobufjs/handlebars code-injection | `package.json` transitive deps |
| 6 | 🟡 **LOW** | Dormant HTTP transport: `cors:'*'`, no auth, no DNS-rebinding protection ("loaded gun") | `src/server/transport/HttpTransportManager.ts:46-50` |
| 7 | 🟡 **LOW** | Unix domain socket created `0o666` (world-accessible) in `/tmp` | `src/server/transport/IPCTransportManager.ts:249-252` |
| 8 | 🟡 **LOW** | Vault-cwd + hardcoded `--dangerously-skip-permissions` for Claude Code/Gemini CLI adapters | `AnthropicClaudeCodeAdapter.ts:126,152` |
| 9 | 🟡 **LOW** | Vault file logger has no key-redaction filter (writes to synced `.nexus/logs`) | `src/services/llm/utils/Logger.ts:273-333` |

---

## Findings

### 🔴 #1 HIGH — Arbitrary file write via ElevenLabs `outputPath`

**Impact:** A prompt-injection payload can write attacker-controlled **binary** bytes to a path outside the vault.

The ElevenLabs write tools (`textToSpeech`, `soundEffects`, `musicGeneration`) take `params.outputPath` directly from the LLM/MCP caller and pass it through Obsidian's `normalizePath` only — which **collapses slashes but does not strip `..` segments** (documented in-repo at `src/agents/apps/skills/services/skillPaths.ts:9-12`) — then write via `vault.createBinary`.

```ts
// src/agents/apps/elevenlabs/tools/textToSpeech.ts:113-126
const outputPath = normalizePath(params.outputPath || `audio/tts-${Date.now()}.mp3`);
const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
if (dir && !vault.getAbstractFileByPath(dir)) { await vault.createFolder(dir); /* ... */ }
await vault.createBinary(outputPath, response.arrayBuffer);
```

Sibling apps already guard this — Composer (`compose.ts:93`) and DataAnalysis (`runPython.ts:81`) both call `isValidPath()`. ElevenLabs does not import it. Because the write is binary and has no existing-file resolution to limit it, this is the highest-leverage write primitive in the codebase.

**Steps to reproduce (conceptual):** with the ElevenLabs app enabled, a `useTools` call (or injected instruction) with `outputPath: "../../../../<target>"` reaches `vault.createBinary` with `..` segments intact.

**Fix:** add `isValidPath(params.outputPath)` rejection to all three tools, matching `compose.ts` / `runPython.ts`.

---

### 🟠 #2 MEDIUM — SSRF in WebTools agent (no URL validation)

**Impact:** The plugin can be driven to fetch internal/metadata/localhost endpoints and read the response back into the conversation.

`openWebViewerUrl` passes the caller-supplied `url` straight into Obsidian's Web Viewer webview with **zero scheme/host validation**:

```ts
// src/agents/apps/webTools/utils/webViewer.ts:63-71
await leaf.setViewState({
  type: WEB_VIEWER_VIEW_TYPE, active: focus,
  state: { url, title: url, navigate: true },
});
```

`extractLinks.ts` then runs `executeJavaScript` against the loaded page and returns `document.links` to the model — a **read-back oracle**. An injection can load `http://169.254.169.254/latest/meta-data/`, `http://localhost:<port>`, RFC-1918 hosts, or `file://`, then exfiltrate rendered content into a synced note via `content write` / `captureToMarkdown`. Gated behind the WebTools app being enabled (desktop only), but unguarded once enabled.

**Fix:** before `openWebViewerUrl`, allowlist `http:`/`https:` and block `localhost`/`127.0.0.0/8`/`::1`/RFC-1918/`169.254.0.0/16`/`fc00::/7`, with an explicit opt-in override.

---

### 🟠 #3 MEDIUM — `javascript:` URL injection in streaming markdown

**Impact:** A crafted LLM response can render a live `<a href="javascript:...">` in the Electron renderer during streaming.

The streaming renderer uses `streaming-markdown`'s `default_set_attr`, which sets `href`/`src` with no scheme validation (`MarkdownRenderer.ts:59`).

<details>
<summary>Why this is MEDIUM, not HIGH</summary>

- streaming-markdown builds the DOM via `createElement`/`createTextNode`, so raw `<script>`/`onerror=` **cannot** be injected — only the URL *scheme* of legitimately-parsed links is attacker-controlled.
- The finalize/reload path re-renders through Obsidian's native renderer, which neutralizes `javascript:`.
- **Gap:** `finalizeStreamingContent` (`MarkdownRenderer.ts:102`) only re-renders when `hasAdvancedMarkdownFeatures()` is true. A message whose only rich element is a plain `[text](javascript:...)` link matches none of those patterns, so the unsafe streaming DOM **persists until the conversation is reloaded.**
</details>

**Fix:** wrap the streaming-markdown renderer to allowlist URL schemes (`http:`, `https:`, `mailto:`, `obsidian:`, `app://`, relative), or always finalize through Obsidian's renderer.

---

### 🟠 #4 MEDIUM — Inconsistent path-traversal defense in core tools

Core ContentManager/StorageManager/CanvasManager tools strip only a leading slash and rely entirely on Obsidian's indexed Vault API for confinement; none call the plugin's own `ObsidianPathManager.validatePath` (`:51-89`), which correctly rejects `..`/`~`/absolute/drive paths.

- Reads/moves of existing files are largely self-limiting (`getAbstractFileByPath` won't resolve outside-vault paths).
- Residual risk is on **create/destination** paths: `write` (new file), `copy`/`move` dest, `archive` target, `createFolder`, canvas `write` — an unvalidated `..`-bearing destination reaches `vault.create`/`vault.rename`. Confinement is not asserted in-code.

The newer "app" agents (Skills, via `assertInside`) are best-in-class and are the model to follow.

**Fix:** add a shared `assertVaultRelative(path)` gate (reuse `isValidPath`/`assertInside`) on every destination/create/write path in the core tools.

---

### 🟠 #5 MEDIUM — Dependency vulnerabilities (`npm audit`: 20 — 2 critical, 10 high, 8 moderate)

<details>
<summary>Full vulnerability table</summary>

| Sev | Package | Issue | Reachability |
|-----|---------|-------|-------------|
| CRITICAL | `protobufjs` | Arbitrary code execution, prototype injection | Transitive under `@xenova/transformers` / `@huggingface/transformers` |
| CRITICAL | `handlebars` | JS injection (AST type confusion), prototype pollution | Transitive |
| HIGH | `@modelcontextprotocol/sdk` | ReDoS; DNS-rebinding off by default; cross-client leak | Direct — live MCP path |
| HIGH | `tar` | Path traversal / symlink poisoning | Transitive only — **no tar extraction in `src/`** (N/A) |
| HIGH | `path-to-regexp`, `fast-uri`, `picomatch` | ReDoS / path traversal | Express 5 + glob — only live if HTTP transport enabled (dormant) |
| HIGH | `onnxruntime-web`, `onnx-proto` | via protobufjs | ML inference path |
| HIGH | `fast-xml-builder` | attribute injection | XML build (ingest) |
| MODERATE | `body-parser`, `qs`, `brace-expansion`, `yaml`, `js-yaml`, `uuid`, `fast-xml-parser`, `@protobufjs/utf8` | DoS / prototype pollution | Mixed; most DoS or dormant |

</details>

Most are DoS or reachable only in dormant code paths (HTTP transport, unused tar). The protobufjs/handlebars criticals warrant attention.

**Fix:** `npm audit fix`; bump `@modelcontextprotocol/sdk`; confirm protobufjs is not reachable at runtime in the embedding/WebLLM paths (or that those only process trusted model files).

---

### 🟡 #6 LOW — Dormant HTTP transport is an un-hardened "loaded gun"

`HttpTransportManager` is constructed (`MCPServer.ts:79`) but its `startTransport()` is **never called** — the live transport is IPC named-pipe/Unix-socket only, with no network exposure. However the dead code carries `cors({origin:'*'})`, no auth, and no `enableDnsRebindingProtection`/`allowedHosts`. If ever wired into the lifecycle, it becomes a browser-reachable, unauthenticated, full-vault `useTools` endpoint.

**Fix:** delete it, or pre-harden (bind `127.0.0.1`, `cors({origin:false})`, `enableDnsRebindingProtection:true`, `allowedHosts:['127.0.0.1:3000']`, body limit) before it can be enabled.

### 🟡 #7 LOW — Unix domain socket created `0o666`

`IPCTransportManager.ts:249-252` creates a world-accessible socket in `/tmp`; on a multi-user host any local user can connect and drive full `useTools` (the IPC channel has no auth — by design, the socket *is* the trust boundary). **Fix:** `0o600`. (Windows named pipes use current-user ACLs — Unix-specific.)

### 🟡 #8 LOW — Vault-cwd + hardcoded `--dangerously-skip-permissions`

Claude Code/Gemini CLI adapters spawn with `cwd: vaultPath` and skip-permissions hardcoded (`AnthropicClaudeCodeAdapter.ts:126,152`). A planted `CLAUDE.md`/project-settings file in an untrusted vault could influence the spawned agent. MCP config is pinned (`--strict-mcp-config`), limiting the worst case. **Fix:** document the untrusted-vault trust assumption, or use a neutral temp cwd.

### 🟡 #9 LOW — Vault file logger has no redaction filter

`Logger.ts:273-333` serializes full `metadata` to synced `.nexus/logs/*.log` with no scrubbing. No active key leak found, but the sink is unguarded. **Fix:** redact keys matching `/key|token|secret|authorization|bearer/i` before write (defense-in-depth — the only sink writing structured data to a synced location).

---

## Verified secure (positives)

<details>
<summary>Strengths confirmed during the audit</summary>

- **Process spawning** — every `child_process` call uses arg-array `spawn` (never shell-string concat); untrusted payloads go via stdin/temp-files, never argv; `shell:true` only for Windows `.cmd`/`.bat` wrappers with discovered binary paths; `where`/`which` args are hardcoded literals; spawned env strips provider API keys. **No command injection.**
- **Credential handling** — HTTPS enforced on all key-bearing requests (`ProviderHttpClient.enforceHttps`); cloud base URLs hardcoded (no key-redirect SSRF); `getApiKey()` masks; OAuth uses PKCE-S256 + `timingSafeEqual` + 127.0.0.1-only single-use callback; CLI auth returns sentinels, never extracts real tokens; no hardcoded secrets; no keys in traces/JSONL.
- **CLI parser** (`ToolCliNormalizer.ts`) — single-pass O(n), ReDoS-free; params bound only to schema-derived names → no prototype pollution; no `eval`/`new Function` on untrusted input.
- **Deserialization** — safe `yaml@2` (not `js-yaml.load` with custom tags); `fast-xml-parser` v5 doesn't expand external entities (no XXE); config merge uses object spread, not `__proto__`-walking deep merge.
- **DOM/XSS** — broadly compliant with `createEl`/`textContent`; the two literal `innerHTML` uses are benign; no `BrowserWindow`/`nodeIntegration`/`<webview>`/`srcdoc` with untrusted content.
- **MCP input** — schema-validated, allowlist agent routing, no dynamic dispatch, no RCE reachable from `getTools`/`useTools`; `runPython` runs in a network-isolated Pyodide WASM worker.

</details>

---

## Remediation checklist

- [ ] **#1 (HIGH)** Add `isValidPath()` to ElevenLabs `outputPath` in all 3 tools
- [ ] **#2 (MEDIUM)** Add SSRF URL guard to `webViewer.openWebViewerUrl`
- [ ] **#3 (MEDIUM)** Sanitize URL schemes in the streaming-markdown render path
- [ ] **#5 (MEDIUM)** `npm audit fix` + bump `@modelcontextprotocol/sdk`; verify protobufjs/handlebars unreachable at runtime
- [ ] **#4 (MEDIUM)** Add shared `assertVaultRelative()` gate to core-tool destination paths
- [ ] **#6 (LOW)** Delete/pre-harden the dormant HTTP transport
- [ ] **#7 (LOW)** `0o600` the Unix domain socket
- [ ] **#8 (LOW)** Document untrusted-vault trust assumption for CLI providers
- [ ] **#9 (LOW)** Add key-redaction filter to the vault file logger

> **Primary takeaway:** prompt injection is the main threat vector. Findings **#1** and **#2** most expand its blast radius — fixing those two plus the dependency bumps addresses the bulk of the real risk.

<sub>Audit method: parallel source review across secrets, MCP/HTTP server, process execution, filesystem/path-traversal, injection/SSRF/deserialization, and DOM/XSS, plus `npm audit`. Reviewed at v5.9.9.</sub>
