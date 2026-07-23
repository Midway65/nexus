# Upstream Merge Plan — v5.15.2 → v5.15.4

**Date prepared:** 2026-07-22
**Local branch:** `my-custom-branch` (at 5.15.2, HEAD `3f622d9c`)
**Target:** `upstream/main` `373d5ec8` (v5.15.4)
**Merge base:** `d3e612fe` (v5.15.2 tip — clean linear catch-up)
**Scope:** 6 non-merge commits (spans v5.15.3 + v5.15.4)

---

## 1. Verdict: routine merge — 1 conflict, zero divergence touches

Back to the clean profile after the big TS6 release. `git merge-tree` predicts **1 conflict** (CLAUDE.md, keep ours). **Not a single fork-divergence file is touched by upstream.**

| File | Resolution |
|------|-----------|
| `CLAUDE.md` | **keep ours** (`--ours`) |

`connectorContent.ts` fast-forwards. `cliAssets.ts` (CLI-bridge generated file) will regenerate during build — real content this time (CLI transport source changed); expect the regen to match upstream's committed version.

---

## 2. Divergence-file survival check (all PASS — zero touches)

| File | Tier | Upstream touched? |
|------|------|-------------------|
| `SchemaMigrator.ts` | 2 | No — stays `CURRENT_SCHEMA_VERSION=21` |
| `JSONLWriter.ts` | 2 | No — eslint-disable descriptions + `readEventsStreaming` intact |
| `eslint.config.mjs` | 2 | No — JSONLWriter exemption intact |
| `SettingsView.ts` | 3 | No — `availableUpdateVersion` guard intact |
| `ChatView.ts` | 3 | No — `getChatService` thunk intact |
| `ChatSendCoordinator.ts` / `ChatSessionCoordinator.ts` / `ChatSubagentIntegration.ts` | 3 | No |
| `tests/unit/SchemaMigrator.test.ts` | 3 | No |
| `connector.ts` | — | No |
| `package.json` | infra | Version bump only — **typescript stays ^6.0.3** (TS6 settled), dependency set verified identical |

### No SchemaMigrator renumber
Upstream still v13; fork at 21. **No action.**

### No toolchain / dependency change
TypeScript stays `^6.0.3` (no repeat of the v5.15.2 migration gate). Package key set verified identical — Realtime 2.1 / Kimi K3 / Voxtral add **no new packages** (reuse existing HTTP/transcription infra).

---

## 3. What's in v5.15.4 (feature substance)

**Models + transcription (#295, `c118c1f9`)** — additive, verified no prune
- Adds **Realtime 2.1**, **Kimi K3**, and **Voxtral transcription**. **Purely additive** — zero apiNames removed; the vault's `whisper-1` transcription default and all chat models are untouched. Voxtral is a *new* transcription option alongside whisper-1.

**Nexus CLI bridge hardening (#373d5ec8, #4c6b392f, #5b563d0d)**
- **Shell-safe CLI content transport** + **preserve quoted CLI values across shells** — hardens the `nexus` shell bridge's argument/content handling across PowerShell/bash/zsh. Touches `cli/` source + regenerates `src/utils/cliAssets.ts` (generated file, like connectorContent). Fork has no `cli/` divergence → auto-merges.
- **#294 fix CLI Node discovery on macOS** — inert on this Windows machine (macOS-specific), but the cross-shell quoting fixes would benefit CLI use on Windows PowerShell if installed.

---

## 4. Execution steps

```powershell
git checkout -- src/utils/connectorContent.ts   # if timestamp-only churn present
git merge upstream/main --no-edit

git checkout --ours CLAUDE.md
git add CLAUDE.md
git commit --no-edit

# SchemaMigrator: NO ACTION (verify stays 21)

npm install        # version-field lockfile sync only (TS6 already installed)
npm run build      # lint + cli-build + tsc + esbuild + connector/cli regen

# connectorContent.ts + cliAssets.ts: discard if regen is only a timestamp/hash-noop;
# if cliAssets.ts has real regen content matching the merge, it'll already be git-clean.
git checkout -- src/utils/connectorContent.ts   # if timestamp-only
git add package-lock.json
git commit -m "chore: reconcile package-lock version field post v5.15.4 merge build"

git diff upstream/main HEAD --name-only   # expect fork set only
```

### Post-merge verification checklist
- [ ] `CLAUDE.md` resolved ours; no other conflicts
- [ ] `npm run build` fully green (still under TS6; expect same 2 non-blocking JSONLWriter warnings as v5.15.2)
- [ ] `getChatService` thunk (×3) + `availableUpdateVersion` guard (×8) + JSONLWriter exemption + descriptions intact
- [ ] `SchemaMigrator.ts` = 21; `SchemaMigrator.test.ts` 8/8 green
- [ ] `cliAssets.ts` / `connectorContent.ts` regenerated correctly (git-clean or committed if real change)
- [ ] Divergence surface = expected fork set only

### npm audit note
Standing rule: no `npm audit fix`. Carried hono/js-yaml dev-tree advisories — not shipped, leave for upstream.

---

## 5. Risk callouts (post-deploy smoke)

| Risk | Level | Check |
|------|-------|-------|
| **Data-folder reset** | **LOW** | No storage-coordinator touches. Verify `storage.rootPath = "00-System/Nexus"` + `migration.state = verified`. |
| **DB migration on launch** | **NONE** | SchemaMigrator unchanged. |
| **CLI bridge transport change** | **LOW** | Only affects the opt-in `nexus` shell bridge. If installed, a quick CLI round-trip with a quoted argument confirms the shell-safe fix. |
| **MCP connection** | LOW | Quick stdio smoke. |

---

## 6. Post-merge housekeeping
- Update `docs/fork_divergence.md` audit header → v5.15.4 (zero divergence-file touches; surface stable).
- Update CLAUDE.md version marker 5.15.2 → 5.15.4.
- Write `project_v5_15_4_merge` memory + MEMORY.md index line.
- Deploy `npm run deploy`, then §5 data-folder check.
