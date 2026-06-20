# Upstream Merge Plan — v5.12.0 → v5.12.1

**Date prepared:** 2026-06-20
**Local branch:** `my-custom-branch` (at 5.12.0, HEAD `3e45fea1`)
**Target:** `upstream/main` `f9c31b44` (v5.12.1)
**Merge base:** `949dc233` (v5.12.0 tip — clean linear catch-up)
**Scope:** 5 non-merge commits

---

## 1. Verdict: routine merge — 1 conflict

`git merge-tree` predicts **exactly 1 conflict**:

| File | Resolution |
|------|-----------|
| `CLAUDE.md` | **keep ours** (`--ours`) |

`connectorContent.ts` fast-forwards to upstream's regen (fork converged it in v5.11.2; `connector.ts` itself untouched). `.gitignore` auto-merges. **No divergence-file conflicts** — every Tier 2/3 file is untouched by upstream this release (§2).

---

## 2. Divergence-file survival check (all PASS — none touched upstream)

| File | Tier | Upstream touched? | Outcome |
|------|------|-------------------|---------|
| `src/database/schema/SchemaMigrator.ts` | 2 | No | Auto-merges; stays `CURRENT_SCHEMA_VERSION=21` |
| `src/database/storage/JSONLWriter.ts` | 2 | No | Auto-merges |
| `eslint.config.mjs` | 2 | No | Auto-merges; JSONLWriter exemption intact |
| `src/settings/SettingsView.ts` | 3 | No | Auto-merges; `availableUpdateVersion` guard intact |
| `src/ui/chat/ChatView.ts` | 3 | No | Auto-merges; `getChatService` thunk intact |
| `src/ui/chat/services/Chat{Send,Session}Coordinator.ts`, `ChatSubagentIntegration.ts` | 3 | No | Auto-merge |
| `tests/unit/SchemaMigrator.test.ts` | 3 | No | Auto-merges |
| `connector.ts` | — | No | Unchanged |
| `package.json` | infra | **No dep changes** (version bump only) | Fast-forwards clean |

### SchemaMigrator: no renumber
Upstream still v13; fork at 21. No migration added. **No action.**

### No new npm dependencies
Version bump only; lockfile diff will be the version field alone.

---

## 3. What's in v5.12.1 (feature substance)

**Model catalog refresh + prune (#268, `9e46062a`)** — the only user-visible change
- **Adds:** GLM 5.2, Kimi K2.7 Code (OpenRouter); Requesty catalog additions (+35 lines).
- **Prunes (stale):** Claude 4.5 Opus / 4.5 Sonnet / 4.5 Sonnet (1M); GPT-5 / 5-Mini / 5-Nano / 5.1; Gemini 2.5 Pro / 2.5 Flash / 3.0 Pro-Preview / 3.0 Flash-Preview; Groq Llama-3.1/3.3 + Gemma2; GLM 5V Turbo (OpenRouter). Google text default constant `gemini-3-pro-preview` → `gemini-3.1-pro-preview`.
- Touches `{Anthropic,Google,Groq,OpenAI,OpenRouter,Requesty}Models.ts` + `SystemPromptBuilder.ts` + `useTools.ts`. **No fork divergence in any** → all auto-merge.
- **✅ User-impact verified NIL:** cross-referenced the prune list against this vault's `data.json` model selections. All survive —
  - `defaultModel = claude-opus-4-7` ✅ present (newer than pruned 4.5-era)
  - `agentModel = claude-sonnet-4-6` ✅ present
  - `defaultImageModel = gemini-2.5-flash-image` ✅ separate image catalog, untouched by the prune
  - `defaultVideoModel = veo-3.1-generate-preview`, `defaultOcrModel = mistral-ocr`, `defaultTranscriptionModel = whisper-1`, `webllmModel = nexus-tools-q4f16` ✅ none pruned
  - **No dropdown gaps or invalid saved defaults expected post-upgrade.**

**Eval + toolManager hardening (#269 `8d7939e1`, #270 `f9c31b44`)**
- Eval harness now grades the real two-tool (`getTools`/`useTools`) surface; adds context contract, failure-analysis prompt iteration, harness hardening, and a new `nexus-model-eval` skill. Internal dev/eval tooling — no runtime behavior change for the plugin.

**useTools CLI guidance clarification (#268 `dfa3799b`)**
- Prompt/description wording in `useTools.ts`. Aligns with the fork's CLI-first ToolManager contract (no code divergence there) → auto-merges.

---

## 4. Execution steps

> Working tree carries the usual untracked fork-local docs + prior merge plans — leave them. If `connectorContent.ts` shows a timestamp-only `M` from the last deploy build, discard it first.

```powershell
git checkout -- src/utils/connectorContent.ts   # if timestamp-only churn present
git merge upstream/main --no-edit

# Resolve the single expected conflict
git checkout --ours CLAUDE.md
git add CLAUDE.md
git commit --no-edit

# SchemaMigrator: NO ACTION (verify stays 21)

npm install        # version-field lockfile sync only
npm run build      # lint + tsc + esbuild + connector regen

# Commit regen/lockfile (connectorContent expected timestamp-only → discard; commit package-lock)
git checkout -- src/utils/connectorContent.ts
git add package-lock.json
git commit -m "chore: reconcile package-lock version field post v5.12.1 merge build"

git diff upstream/main HEAD --name-only   # verify expected fork set only
```

### Post-merge verification checklist
- [ ] `CLAUDE.md` resolved ours; no other conflicts
- [ ] `SchemaMigrator.ts` = 21; `SchemaMigrator.test.ts` 8/8 green
- [ ] `getChatService` thunk (×3) + `availableUpdateVersion` guard (×8) + JSONLWriter exemption intact
- [ ] `npm run build` fully green
- [ ] Divergence surface = expected fork set only

### npm audit note
Standing rule: do **not** `npm audit fix --force`. The esbuild HIGH advisory (GHSA-gv7w-rqvm-qjhr) carried over from v5.12.0 — **build-time-only devDep, not shipped, upstream pins same version**. Leave for upstream to bump.

---

## 5. Risk callouts (post-deploy smoke)

| Risk | Level | Check |
|------|-------|-------|
| **Data-folder reset** | **LOW** | No storage-coordinator touches. Verify `storage.rootPath = "00-System/Nexus"` + `migration.state = verified` post-deploy per [[project_nexus_data_folder]]. |
| **DB migration on launch** | **NONE** | SchemaMigrator unchanged. |
| **Model prune breaking a saved default** | **NONE (verified)** | All configured models survive (§3). If you *manually* select a pruned model in a chat, it'd be gone — but none are wired as defaults. |
| **MCP connection** | LOW | Quick stdio smoke (useTools guidance is prompt-only). |

---

## 6. Post-merge housekeeping
- Update `docs/fork_divergence.md` audit header → v5.12.1 (note: zero divergence-file touches; surface stable).
- Update CLAUDE.md version marker 5.12.0 → 5.12.1 (within keep-ours resolution or follow-up).
- Write `project_v5_12_1_merge` memory + MEMORY.md index line.
- Deploy `npm run deploy`, then the §5 data-folder check (model-prune impact already cleared, so the usual smoke suffices).
