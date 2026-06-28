# Upstream Merge Plan — v5.12.2 → v5.13.1

**Date prepared:** 2026-06-28
**Local branch:** `my-custom-branch` (at 5.12.2, HEAD `73f43b28`)
**Target:** `upstream/main` `efcac800` (v5.13.1)
**Merge base:** `fe0ec8b5` (v5.12.2 tip — clean linear catch-up)
**Scope:** 7 non-merge commits (spans v5.13.0 + v5.13.1)

---

## 1. Verdict: routine merge — 1 conflict, 2 auto-merges (both verified safe)

`git merge-tree` predicts **1 conflict** (CLAUDE.md, keep ours). Two divergence-relevant files auto-merge, and I verified *why* each is safe (not just textually non-conflicting):

| File | Resolution |
|------|-----------|
| `CLAUDE.md` | **keep ours** (`--ours`) |

`connectorContent.ts` fast-forwards. `package.json`/lockfile = version field only this time (tab-indent already settled in v5.12.2).

---

## 2. Divergence-file survival check

| File | Tier | Upstream touched? | Outcome |
|------|------|-------------------|---------|
| `src/ui/chat/ChatView.ts` | 3 | **YES (#279/#280, 3 commits)** | **Auto-merges — verified SAFE.** Base→upstream diff shows upstream's edits are at lines 32 (import), 92 (field), 530/627+ (new `WorkingIndicatorController` wiring) — **none in the 118–160 thunk region**. The fork's 3 `getChatService` thunk sites (121/141/159) sit in untouched territory. Verify count=3 + tsc post-merge (routine). |
| `eslint.config.mjs` | 2 | **YES (#3e94d14c)** | **Auto-merges — verified SAFE.** Upstream extends the (upstream-owned) `sentence-case` block: acronyms `+KV,MTP,GLM`, ignoreRegex `+^OLLAMA_` (line ~110). The fork's only eslint divergence — the JSONLWriter exemption (line ~140) — is a different region, untouched. |
| `src/database/schema/SchemaMigrator.ts` | 2 | No | Auto-merges; stays `CURRENT_SCHEMA_VERSION=21` |
| `src/database/storage/JSONLWriter.ts` | 2 | No | Auto-merges |
| `src/settings/SettingsView.ts` | 3 | No | Auto-merges; `availableUpdateVersion` guard intact |
| `ChatSendCoordinator.ts`, `ChatSessionCoordinator.ts`, `ChatSubagentIntegration.ts` | 3 | No | Auto-merge (thunk-carriers untouched this release) |
| `tests/unit/SchemaMigrator.test.ts` | 3 | No | Auto-merges |
| `connector.ts` | — | No | Unchanged |

### SchemaMigrator: no renumber
Upstream still v13; fork at 21. No migration added. **No action.**

### No new dependencies
Full package key set verified identical fork↔upstream. The local-model "native thinking" / Ollama tool-calling features add **no npm deps** (native runtime integrations over existing HTTP). No mobile-compat vector.

---

## 3. What's in v5.13.1 (feature substance)

**Local-model upgrades (user-relevant — this vault has `ollama` + `lmstudio` configured)**
- **#281 Ollama: native tool calling, structured output, model discovery** — Ollama can now drive Nexus tools natively + enumerate installed models.
- **#283 local models: native thinking, resilient streaming, speculative-decoding recovery (LM Studio + Ollama)** — surfaces reasoning, hardens streaming against drops, recovers from spec-decode stalls.
- These are meaningful behavior upgrades for the two local providers this vault uses → worth a quick smoke if local models get used.

**Working-indicator continuity (#279 `3a6ae5b2`, #280 `98cffb51`)** — touches `ChatView.ts` (§2)
- New `WorkingIndicatorController` keeps the "working" ticker **alive during silent tool-execution gaps** and renders it **in-bubble so it stays attached**. Same intent as the fork's historical "ThinkingLoader continuity" work (CLAUDE.md) — now upstream's native implementation. No conflict; the fork never had a code divergence here, only the old branch experiment.

**Content-replace robustness (#282 `047559d0`)**
- `content replace` now tolerates quote/dash/invisible/whitespace **anchor drift**. Direct continuation of the Unicode-replace safety lineage (#183/#186/#187). No fork divergence in the replace tool → auto-merges. Welcome reliability fix for AI-driven note edits.

**Lint/store-compliance (#3e94d14c)** — touches `eslint.config.mjs` (§2)
- Removes store-bot-rejected inline `sentence-case` disables added by #281/#282/#283; allowlists genuine acronyms (KV/MTP/GLM) + `OLLAMA_` env-var in eslint config instead. Keeps `eslint .` green AND obsidian-store-bot clean.

---

## 4. Execution steps

```powershell
git checkout -- src/utils/connectorContent.ts   # if timestamp-only churn present
git merge upstream/main --no-edit

# Resolve the single conflict
git checkout --ours CLAUDE.md
git add CLAUDE.md
git commit --no-edit

# VERIFY the two auto-merges landed correctly:
#   grep -c "getChatService: () => this.chatService" src/ui/chat/ChatView.ts   → expect 3
#   grep -c "JSONLWriter.ts" eslint.config.mjs                                 → expect 1
#   grep "KV.*MTP.*GLM" eslint.config.mjs                                      → upstream acronyms present
# SchemaMigrator: NO ACTION (verify stays 21)

npm install        # version-field lockfile sync only (tab-indent already settled)
npm run build      # lint + tsc + esbuild + connector regen

git checkout -- src/utils/connectorContent.ts   # if regen timestamp-only
git add package-lock.json
git commit -m "chore: reconcile package-lock version field post v5.13.1 merge build"

git diff upstream/main HEAD --name-only   # expect fork set only
```

### Post-merge verification checklist
- [ ] `CLAUDE.md` resolved ours; no other conflicts
- [ ] `ChatView.ts` `getChatService` thunk count = 3 (survived #279/#280 auto-merge)
- [ ] `eslint.config.mjs`: JSONLWriter exemption present + upstream KV/MTP/GLM acronyms present + lint green
- [ ] `SchemaMigrator.ts` = 21; `SchemaMigrator.test.ts` 8/8 green
- [ ] `availableUpdateVersion` guard (×8) intact
- [ ] `npm run build` fully green (esp. tsc — ChatView is a merge point)
- [ ] Divergence surface = expected fork set only

### npm audit note
Standing rule: no `npm audit fix --force`. esbuild HIGH advisory (GHSA-gv7w-rqvm-qjhr) still carried — build-time devDep, not shipped, upstream pins same version.

---

## 5. Risk callouts (post-deploy smoke)

| Risk | Level | Check |
|------|-------|-------|
| **ChatView thunk + WorkingIndicator auto-merge** | **LOW-watch** | Verified upstream edits are outside the thunk region. Confirm count=3 + tsc (§4). After deploy: send a chat message that triggers a tool call, confirm the "working" ticker stays visible through the tool gap and streaming completes. |
| **Local-model behavior change** | **LOW** | Ollama tool-calling + LM Studio/Ollama native thinking are new. If you use local models: confirm a basic chat + tool call works on `ollama`/`lmstudio`. |
| **Data-folder reset** | **LOW** | No storage-coordinator touches. Verify `storage.rootPath = "00-System/Nexus"` + `migration.state = verified`. |
| **DB migration on launch** | **NONE** | SchemaMigrator unchanged. |
| **MCP connection** | LOW | Quick stdio smoke. |

---

## 6. Post-merge housekeeping
- Update `docs/fork_divergence.md` audit header → v5.13.1. Note `ChatView.ts` thunk survived another upstream-touch release (now 2 consecutive: v5.11.x voice, v5.13 ticker) — reinforces the case to propose the `getChatService` thunk upstream.
- Update CLAUDE.md version marker 5.12.2 → 5.13.1.
- Write `project_v5_13_1_merge` memory + MEMORY.md index line.
- Deploy `npm run deploy`, then §5 smoke (chat round-trip with a tool call this release).
