# Upstream Merge Plan — v5.14.0 → v5.15.2

**Date prepared:** 2026-07-20
**Local branch:** `my-custom-branch` (at 5.14.0, HEAD `66ef6270`)
**Target:** `upstream/main` `d3e612fe` (v5.15.2)
**Merge base:** `bb496e9e` (v5.14.0 tip)
**Scope:** 18 non-merge commits (spans v5.14.1 → v5.15.2)

---

## 1. Verdict: substantial merge — 2 conflicts + a toolchain upgrade to verify

The largest merge since the voice batch. `git merge-tree` predicts **2 conflicts**, and the headline risk is not a conflict at all — it's the **TypeScript 6 migration** (the whole build must pass under a new compiler).

| Conflict | Resolution |
|------|-----------|
| `CLAUDE.md` | **keep ours** (`--ours`) |
| `package-lock.json` | **take theirs, then `npm install` to regenerate** (TS6 devDep bump `^5.9.3`→`^6.0.3` is the driver) |

Two divergence-relevant files auto-merge and must be verified: `eslint.config.mjs` (5 commits — security arch guard) and `ChatView.ts` (thunk). `connector.ts` changed (TS6) → `connectorContent.ts` regen will be **real content this time, not just a timestamp**.

---

## 2. Divergence-file survival check

| File | Tier | Upstream touched? | Outcome |
|------|------|-------------------|---------|
| `eslint.config.mjs` | 2 | **YES (5 commits)** | **Auto-merges** — adds Phase-3 arch-guard rules (against direct `vault.` mutation) + CLI-bridge scoping. Fork's JSONLWriter exemption is a separate block. ⚠️ Verify: exemption present + **the new arch guard doesn't flag fork code** (lint is part of build). |
| `src/ui/chat/ChatView.ts` | 3 | **YES (1 commit)** | **Auto-merges** — verify `getChatService` thunk count=3 + tsc clean. |
| `src/database/schema/SchemaMigrator.ts` | 2 | No | Auto-merges; stays `CURRENT_SCHEMA_VERSION=21`. **No renumber** (security phases added no migration; upstream still v13). |
| `src/database/storage/JSONLWriter.ts` | 2 | No | Auto-merges; `readEventsStreaming` intact |
| `src/settings/SettingsView.ts` | 3 | No | Auto-merges; `availableUpdateVersion` guard intact |
| `ChatSendCoordinator.ts` / `ChatSessionCoordinator.ts` / `ChatSubagentIntegration.ts` | 3 | No | Auto-merge |
| `tests/unit/SchemaMigrator.test.ts` | 3 | No | Auto-merges |
| `connector.ts` | — | **YES (TS6)** | Auto-merges (no fork divergence); triggers real `connectorContent.ts` regen post-build |
| `package.json` | infra | typescript `^5.9.3`→`^6.0.3` + others | Auto-merges (fork didn't touch these lines) |

### ⭐ Headline risk: TypeScript 6 migration (#285)
Upstream migrated the whole codebase to TS `^6.0.3`. **Verification gate: `npm run build` must pass under TS6** — specifically `tsc --noEmit` over the fork's divergent code (thunk, `JSONLWriter.readEventsStreaming`, SchemaMigrator v17–v21 additions, SettingsView guard). These are simple TS and *should* compile, but TS6 can tighten inference. If tsc errors, fix the fork code minimally to satisfy TS6 (do not downgrade typescript — that would fight upstream). `npm install` must pull TS6 before building.

### No dependency additions
Package **key set** verified identical fork↔upstream (only the `typescript` version differs + the CLI bridge reuses existing infra). No new packages, no new mobile-crash vector from packages.

---

## 3. Storage cutover — analyzed, SAFE for this vault (reset risk LOW)

`d3b65e8f` ("harden storage cutover") edits `HybridStorageAdapter.ts` (+13): once migration is `verified`/`not_needed`, it now sets legacy read base paths to `[]` instead of keeping them active. Rationale (upstream): *"Legacy roots are migration inputs, not permanent read replicas. Keeping them active after cutover can resurrect deleted data and race cloud-sync deletion/placeholder ops during every startup read."*

- **This vault: `migration.state = verified`, data live at `00-System/Nexus/Data`** (primary write path, unaffected). Legacy roots (`.nexus/`) were cleaned up 2026-05-12 per [[project_nexus_data_folder]] and are empty/gone. → **Net-positive reliability fix; no data-visibility risk here.**
- **`PluginScopedStorageCoordinator` / `VaultRootResolver` / `PluginStoragePathResolver` are UNTOUCHED** → rootPath stays `00-System/Nexus`; **data-folder reset risk LOW**.

---

## 4. What's in v5.15.2 (feature substance)

**Local CLI agent bridge — `nexus` (#287, #289, #291; the 5.15.0 headline)**
- A shell command (`nexus`) to drive the vault directly, **no MCP config needed** — plus `nexus --help` manual + `nexus playbook` recipes, and a get-started provider-picker (Claude Code / Cursor / Codex). New `src/services/cli/` (incl. `LocalCliInstaller`). Desktop-only (spawns processes) — smoke that it doesn't break mobile init (upstream audited; lazy-loaded).
- **Windows CLI discovery/install hardening (#259ab88e, #d3b65e8f)** — relevant on this Windows machine if the CLI bridge gets installed.

**Vault-path confinement security (Phases 1–3: #967d3f31, #fdbe94fa, #cdb28656, #3de83f58)**
- Fuses `resolveVaultPath`, types `VaultOperations` to a `VaultPath`, consolidates write-boundary guards, strips POSIX leading-slash instead of rejecting it, and adds an **eslint arch guard** against direct vault mutation. Hardening; fork has no `VaultOperations` divergence → auto-merges. The arch guard is the §2 lint-verify item.

**Toolchain + models**
- **TypeScript 6 migration (#285)** — see §2.
- **GPT-5.6 model family (#284)** — additive catalog entry (Anthropic-adjacent OpenAI models); vault defaults untouched.
- Clearer MCP integration setup docs; lint fixes.

---

## 5. Execution steps

```powershell
git checkout -- src/utils/connectorContent.ts   # if timestamp-only churn present
git merge upstream/main --no-edit

# Resolve the 2 conflicts
git checkout --ours   CLAUDE.md
git checkout --theirs package-lock.json          # will be regenerated by npm install anyway
git add CLAUDE.md package-lock.json
git commit --no-edit

# ⚠️ VERIFY auto-merges BEFORE building:
#   grep -c "getChatService: () => this.chatService" src/ui/chat/ChatView.ts   → 3
#   grep -c "JSONLWriter.ts" eslint.config.mjs                                 → 1
# SchemaMigrator: NO ACTION (verify stays 21)

npm install        # PULLS TypeScript 6 + regenerates lockfile — REQUIRED before build
npm run build      # ⭐ TS6 gate: lint (arch guard) + tsc --noEmit + esbuild + connector regen
                   # If tsc errors on fork code, fix minimally for TS6 (do NOT downgrade typescript)

# connectorContent.ts WILL have real changes this time (connector.ts changed under TS6) — commit it
git add src/utils/connectorContent.ts package-lock.json
git commit -m "chore: regen connectorContent.ts (connector.ts TS6 change) + reconcile package-lock post v5.15.2 merge build"

git diff upstream/main HEAD --name-only   # expect fork set only
```

### Post-merge verification checklist
- [ ] `CLAUDE.md` ours; `package-lock.json` regenerated (TS6) — no other conflicts
- [ ] **`npm run build` fully green under TypeScript 6** (the gate — lint arch guard + tsc + esbuild + regen)
- [ ] `ChatView.ts` thunk count=3; `eslint.config.mjs` JSONLWriter exemption present + arch guard didn't flag fork code
- [ ] `SchemaMigrator.ts` = 21; `SchemaMigrator.test.ts` 8/8 green
- [ ] `availableUpdateVersion` guard (×8) + `readEventsStreaming` intact
- [ ] `connectorContent.ts` regenerated with real content and committed
- [ ] Divergence surface = expected fork set only

### npm audit note
Standing rule: no `npm audit fix`. Carried transitive advisories (hono/js-yaml, dev-tree, not shipped) — leave for upstream. Re-check the set post-`npm install` (TS6 may shift it) but do not apply fixes.

---

## 6. Risk callouts (post-deploy smoke)

| Risk | Level | Check |
|------|-------|-------|
| **TypeScript 6 build** | **MEDIUM (the gate)** | `npm run build` green before deploy. This is the one that could actually fail. |
| **eslint arch guard flags fork code** | **LOW** | Fork does no direct vault mutation; lint (in build) confirms. |
| **Data-folder reset / legacy-read cutover** | **LOW** | rootPath logic untouched; `verified` state → cutover is net-positive (§3). Verify `rootPath = "00-System/Nexus"` + `migration.state = verified` post-deploy. Confirm chat/workspace/task data all still load (cutover stops legacy-root reads). |
| **CLI bridge / mobile init** | **LOW** | Desktop-only, lazy-loaded, upstream-audited. On desktop: confirm plugin loads clean. CLI install is opt-in via GetStarted. |
| **ChatView thunk** | LOW | count=3 + tsc (§5). |
| **MCP connection** | LOW | Quick stdio smoke. |

---

## 7. Post-merge housekeeping
- Update `docs/fork_divergence.md` audit header → v5.15.2. Note TS6 toolchain is now in effect; `ChatView.ts` thunk survived another touch (3rd release running).
- Update CLAUDE.md version marker 5.14.0 → 5.15.2.
- Write `project_v5_15_2_merge` memory + MEMORY.md index line; note the storage-cutover behavior change (legacy roots no longer read post-verified) in [[project_nexus_data_folder]].
- Deploy `npm run deploy`, then §6 smoke — emphasis on **data still loads** (storage cutover) + **build was green under TS6**.
