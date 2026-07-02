# Upstream Merge Plan — v5.13.1 → v5.14.0

**Date prepared:** 2026-07-02
**Local branch:** `my-custom-branch` (at 5.13.1, HEAD `fe25f392`)
**Target:** `upstream/main` `bb496e9e` (v5.14.0)
**Merge base:** `efcac800` (v5.13.1 tip — clean linear catch-up)
**Scope:** 3 non-merge commits (spans v5.13.2 + v5.14.0)

---

## 1. Verdict: trivial merge — 1 conflict, zero divergence touches

`git merge-tree` predicts **1 conflict** (CLAUDE.md, keep ours). **Not a single fork-divergence file is touched by upstream this release.** Smallest, lowest-risk merge in the series to date.

| File | Resolution |
|------|-----------|
| `CLAUDE.md` | **keep ours** (`--ours`) |

`connectorContent.ts` fast-forwards. `package.json`/lockfile = version field only.

---

## 2. Divergence-file survival check (all PASS — zero touches)

| File | Tier | Upstream touched? |
|------|------|-------------------|
| `SchemaMigrator.ts` | 2 | No — stays `CURRENT_SCHEMA_VERSION=21` |
| `JSONLWriter.ts` | 2 | No |
| `eslint.config.mjs` | 2 | No — JSONLWriter exemption intact |
| `SettingsView.ts` | 3 | No — `availableUpdateVersion` guard intact |
| `ChatView.ts` | 3 | No — `getChatService` thunk intact |
| `ChatSendCoordinator.ts` / `ChatSessionCoordinator.ts` / `ChatSubagentIntegration.ts` | 3 | No |
| `tests/unit/SchemaMigrator.test.ts` | 3 | No |
| `connector.ts` | — | No |
| `package.json` | infra | Version bump only — **dependency set verified identical** |

### No SchemaMigrator renumber
Upstream still v13; fork at 21. **No action.**

### No new dependencies
Full package key set verified identical fork↔upstream. Native Mistral OCR uses existing HTTP/pdfjs infra — no new package, no mobile-compat vector.

---

## 3. What's in v5.14.0 (feature substance)

**Native Mistral OCR + PDF image extraction (#0bf465f1)** — user-relevant (`defaultOcrModel = mistral-ocr`)
- Touches only `src/agents/ingestManager/tools/services/` (`OcrService` +231, `IngestionPipelineService` +146, `IngestModelCatalog` +8) + types + tests. Fork has no divergence in `ingestManager` → auto-merges.
- Adds native Mistral OCR + PDF image extraction and **fixes OCR truncation**. Direct improvement to the ingest/OCR path this vault already uses. No new dep, no schema/storage change.

**Claude Sonnet 5 (#18534243, v5.13.2)** — additive catalog entry
- Adds `claude-sonnet-5` (1M context, 128K max output, vision + tools + streaming + adaptive thinking) to Anthropic / OpenRouter / Requesty. **Purely additive** — removes nothing; the vault's `claude-opus-4-7` (default) and `claude-sonnet-4-6` (agent) are untouched. Sonnet 5 becomes selectable in the dropdown for those three providers.

**Housekeeping:** version bumps to 5.13.2 and 5.14.0; changelog + guide updates.

---

## 4. Execution steps

```powershell
git checkout -- src/utils/connectorContent.ts   # if timestamp-only churn present
git merge upstream/main --no-edit

git checkout --ours CLAUDE.md
git add CLAUDE.md
git commit --no-edit

# SchemaMigrator: NO ACTION (verify stays 21)

npm install        # version-field lockfile sync only
npm run build      # lint + tsc + esbuild + connector regen

git checkout -- src/utils/connectorContent.ts   # if regen timestamp-only
git add package-lock.json
git commit -m "chore: reconcile package-lock version field post v5.14.0 merge build"

git diff upstream/main HEAD --name-only   # expect fork set only
```

### Post-merge verification checklist
- [ ] `CLAUDE.md` resolved ours; no other conflicts
- [ ] `SchemaMigrator.ts` = 21; `SchemaMigrator.test.ts` 8/8 green
- [ ] `getChatService` thunk (×3) + `availableUpdateVersion` guard (×8) + JSONLWriter exemption intact
- [ ] `npm run build` fully green
- [ ] Divergence surface = expected fork set only

### npm audit note
Standing rule: no `npm audit fix --force`. esbuild HIGH advisory (GHSA-gv7w-rqvm-qjhr) still carried — build-time devDep, not shipped.

---

## 5. Risk callouts (post-deploy smoke)

| Risk | Level | Check |
|------|-------|-------|
| **Data-folder reset** | **LOW** | No storage-coordinator touches. Verify `storage.rootPath = "00-System/Nexus"` + `migration.state = verified`. |
| **DB migration on launch** | **NONE** | SchemaMigrator unchanged. |
| **OCR pipeline change** | **LOW** | If you use ingest/OCR: run one PDF/image ingest with `mistral-ocr`, confirm text extracts fully (the truncation fix + PDF image extraction are the changed paths). |
| **MCP connection** | LOW | Quick stdio smoke. |

---

## 6. Post-merge housekeeping
- Update `docs/fork_divergence.md` audit header → v5.14.0 (zero divergence-file touches; surface stable).
- Update CLAUDE.md version marker 5.13.1 → 5.14.0.
- Write `project_v5_14_0_merge` memory + MEMORY.md index line.
- Deploy `npm run deploy`, then §5 data-folder check (+ optional OCR smoke).
