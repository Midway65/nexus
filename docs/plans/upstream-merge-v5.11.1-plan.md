# Upstream Merge Plan — v5.10.0 → v5.11.1

**Date prepared:** 2026-06-11
**Local branch:** `my-custom-branch` (currently at 5.10.0, HEAD `ded923a3`)
**Target:** `upstream/main` `3f0b7a7c` (v5.11.1)
**Merge base:** `e2db3ed7`
**Scope:** 27 non-merge commits (spans upstream v5.11.0 + v5.11.1)

---

## 1. Verdict: routine merge, low risk

Despite a large feature surface (live voice, read-aloud, video-gen, dependency slimming, security/audit pass), the mechanical merge is **routine**. `git merge-tree` predicts **only 2 conflicts**, both standard for this fork:

| File | Resolution | Rationale |
|------|-----------|-----------|
| `CLAUDE.md` | **keep ours** (`--ours`) | Fork-management doc; never takes upstream |
| `src/utils/connectorContent.ts` | **take theirs**, then regen via build | Generated artifact; rebuilt post-merge |

**Every fork divergence auto-merges cleanly** — verified individually below.

---

## 2. Divergence-file survival check (all PASS)

| File | Tier | Upstream touched? | Outcome |
|------|------|-------------------|---------|
| `src/database/schema/SchemaMigrator.ts` | 2 | **No** | Auto-merges; fork stays at `CURRENT_SCHEMA_VERSION=21` |
| `src/database/storage/JSONLWriter.ts` | 2 | No | Auto-merges; `readEventsStreaming()` preserved |
| `eslint.config.mjs` | 2 | Yes (#251 adds `.claude/` ignore @ line 20) | **Non-overlapping** with fork's JSONLWriter exemption @ line 122 → clean auto-merge |
| `src/settings/SettingsView.ts` | 3 | Yes (#241 voice settings) | **Non-overlapping** with fork's `availableUpdateVersion` guard (lines 265–319) → clean auto-merge |
| `src/ui/chat/ChatView.ts` | 3 | Yes (voice features, heavy) | **Non-overlapping** with fork's `getChatService` thunk (lines 117/137/155) → clean auto-merge |
| `src/ui/chat/services/Chat{Send,Session}Coordinator.ts`, `ChatSubagentIntegration.ts` | 3 | No | Auto-merge (untouched) |
| `tests/unit/SchemaMigrator.test.ts` | 3 | No | Auto-merges; v20+v21 assertions intact |
| `.gitignore` | infra | Yes (#251 adds `*.map`) | Auto-merges |
| `package.json` | infra | Yes (dep slimming) | Byte-identical to base → fast-forwards to upstream cleanly |

### ⚠️ Assumption that broke (and held anyway)
The v5.10.0 merge memo recorded "upstream never touches `src/ui/chat/`." That is **no longer true** — v5.11 voice features heavily edited `ChatView.ts`. The fork's `getChatService` thunk still auto-merges (different line regions), but this assumption can no longer be relied on for *future* merges. Treat `ChatView.ts` as a live-overlap candidate going forward.

### SchemaMigrator: no renumber this merge
Upstream still at `CURRENT_SCHEMA_VERSION=13`; fork at `21`. Upstream added **no** migration in v5.11.x. **No renumber action.** Convergence gap unchanged: upstream needs 8 more migrations before catch-up.

---

## 3. What's actually in v5.11.1 (feature substance)

Grouped from the 27 commits:

**Live voice + audio (the headline)**
- Live voice runtime for **OpenAI** (`#248`-adjacent series) and **Google Gemini** (`#248`): composer shell, transcript append, prior-context builder, dedup, settings sync (`#249`).
- Voice/audio settings + **read-aloud** (`#241`), read-aloud **save + embed** audio (`#245`).
- New script `smoke:google-live` (`scripts/smoke-google-live.mjs`).

**Other features**
- **Video generation** artifact jobs (`#242`).
- **Model catalog**: Requesty catalog refresh + **Claude Fable 5** added to Anthropic/OpenRouter/Requesty (`#258`).
- Short task refs (`#239`); use Obsidian file manager for moves (`244c754f`).

**Slimming / hygiene / security**
- **Removed unused HTTP MCP transport** (`50ba6047`) → `express` dropped.
- **Dependency slimming** (`#251`): dropped `winston`, `tough-cookie`, `uuid`, `@mlc-ai/web-llm`, `@huggingface/transformers`, `cors`, dev `crypto` stub, `@types/{cors,express,request}`; moved `yaml` → devDeps (`#246` slimmed runtime YAML bundle). package-lock 854→746 packages, **0 vulnerabilities**.
  - **NOT a feature loss:** web-llm + transformers are "loaded from CDN at runtime, never bundled" per the commit — WebLLM/Nexus local-model path still functions.
- Security/audit fixes (`#255`, `#256` surface swallowed JSON-parse errors, `#250` audit report, `#252` `ToolParamValidator` + createTask required-field guards).
- Docs-only: HybridStorageAdapter split plan (`#260`), canonical-pipeline passthrough regression tests (`#259`).

---

## 4. Risk callouts (post-deploy smoke)

| Risk | Level | Check |
|------|-------|-------|
| **Data-folder reset** (rootPath → upstream default) | **LOW** | No `PluginScopedStorageCoordinator` / `PluginStorage*` touches this merge. Still verify `rootPath = "00-System/Nexus/Data"` post-deploy per [[project_nexus_data_folder]] — deploy has reset it before (v5.9.0). |
| **DB migration on first launch** | **NONE** | SchemaMigrator unchanged; nothing new runs. |
| **MCP connection** (HTTP transport removed) | LOW | stdio connector is the path Claude Desktop uses; quick MCP-connection smoke after deploy. |
| **Mobile compat** of new voice/video code | LOW (upstream's concern, but verify) | Voice/video are desktop-only; net dep *removal* means fewer mobile-crash vectors, not more. |
| **Voice features need API keys** | n/a | New live-voice paths are opt-in; no impact if unused. |

---

## 5. Execution steps (follow fork merge pattern)

> Working tree is currently dirty: `M src/utils/connectorContent.ts` (a **timestamp-only** stale regen — discard it) + 4 untracked fork-local docs (leave them; they don't interfere).

```powershell
# 0. Clean the stale regen (timestamp-only, will be rebuilt anyway)
git checkout -- src/utils/connectorContent.ts
# (Untracked docs/plans + docs/review files: leave as-is, or commit them first if desired)

# 1. Fetch (already done) + merge
git fetch upstream
git merge upstream/main --no-edit

# 2. Resolve the 2 expected conflicts
git checkout --ours   CLAUDE.md
git checkout --theirs src/utils/connectorContent.ts
git add CLAUDE.md src/utils/connectorContent.ts

# 3. Complete the merge
git commit --no-edit

# 4. SchemaMigrator: NO ACTION (upstream added no migration; fork stays v21) — but verify:
#    git show HEAD:src/database/schema/SchemaMigrator.ts | Select-String "CURRENT_SCHEMA_VERSION = 21"

# 5. Build (reruns generate-connector-content)
npm install        # reconcile package-lock to slimmed dep tree (854->746)
npm run build      # eslint + tsc --noEmit + esbuild + connector regen

# 6. Commit the regen
git add src/utils/connectorContent.ts package-lock.json
git commit -m "chore: regen connectorContent.ts + reconcile package-lock post v5.11.1 merge build"

# 7. Verify divergence surface
git diff upstream/main HEAD --name-only      # expect only fork-infra + Tier2/3 files
```

### Post-merge verification checklist
- [ ] `git merge-tree` predicted-conflict files resolved (CLAUDE.md ours, connectorContent theirs)
- [ ] `eslint.config.mjs` retains JSONLWriter exemption **and** picked up `.claude/` ignore
- [ ] `SettingsView.ts` retains `availableUpdateVersion` guard alongside new voice settings
- [ ] `ChatView.ts` retains all 3 `getChatService` thunk sites alongside voice code
- [ ] `SchemaMigrator.ts` = 21; `SchemaMigrator.test.ts` 8/8 green
- [ ] `npm run build` fully green (eslint, tsc, esbuild, connector regen)
- [ ] `git diff upstream/main HEAD --name-only` shows **only**: `.gitignore`, `CLAUDE.md`, `docs/fork_divergence.md`, `docs/plans/*`, `package-lock.json`, `postbuild.ps1`, `eslint.config.mjs`, `SchemaMigrator.ts`, `JSONLWriter.ts`, `SettingsView.ts`, `tests/unit/SchemaMigrator.test.ts`, 4 chat coordinators, `connectorContent.ts`

### npm audit note
Carry forward the standing rule: do **not** run `npm audit fix --force` (breaking, out of scope). Upstream's #251 already reports the slimmed lockfile at **0 vulnerabilities**, so this merge likely clears the prior 4 transitive advisories on its own — confirm after `npm install`.

---

## 6. Post-merge housekeeping

- Update `docs/fork_divergence.md` audit header to v5.11.1.
- Update CLAUDE.md "Latest features" + version marker (5.10.0 → 5.11.1) as part of the keep-ours resolution, or in a follow-up doc commit.
- Deploy: `npm run deploy`, then **verify data-folder rootPath** before first real use.
- Write a `project_v5_11_1_merge` memory + MEMORY.md index line once merged.
- Note for next merge: `ChatView.ts` is now a live-overlap file (voice). The `getChatService` thunk (Tier 3) remains upstream-eligible — consider proposing it upstream to retire the divergence before voice churn causes a real conflict.
