# Plan 12 — Strip Vault Ancillary Files (Semantic Panel & LCSH Semantic Work)

**Status**: Ready to implement  
**Created**: 2026-04-03 (revised with git diff audit)  
**Companion to**: plan-11-strip-semantic-panel.md (strips Nexus plugin code)  
**Goal**: Revert all changes made to Obsidian vault ancillary files as part of the semantic panel and LCSH semantic matching work.

---

## Scope — What the Git Log Shows

The semantic/LCSH semantic work spans **6 commits** against the vault repo (`C:\Users\middl\Documents\Obsidian\Michael\.git`):

| Commit | Description | Files touched |
|---|---|---|
| `fc13e8c` | Session end [LCSH]: semantic-to-LCSH planning and implementation spec | `02-Projects/LCSH/_notes/` (2 new files), `_states/cc_latest.md`, `project_outline.md`, `MASTER_LOG.md` |
| `5e9b281` | feat: LCSH semantic pipeline Steps 0-2 | `lcsh-concept-index.js` (new), `package.json` (+2 deps), `package-lock.json` (+~1000 lines), `Nexus-MCP-Rules-v2.22.md`, `nexus_operations.md`, `script-inventory.md`, `VAULT.md`, `CLAUDE.md`*, `nexus-chat-system-prompt.md`* |
| `382906b` | feat: lcsh-semantic-match.js | `lcsh-semantic-match.js` (new), `script-inventory.md` |
| `e41187a` | feat: lcsh-tag-infer.js --semantic flag | `lcsh-tag-infer.js` (+46 lines) |
| `6588124` | refactor: lcsh-tag-infer.js — CLI routing | `lcsh-tag-infer.js` (CLI refactor — **keep**) |
| `edd9511` | fix: lcsh-tag-infer.js async/label | `lcsh-tag-infer.js` (minor fix — **keep**) |

> \* `CLAUDE.md` and `nexus-chat-system-prompt.md` changes in `5e9b281` were **only** version ref updates (v2.21→v2.22, v2.12→v2.22) — these are correct and must NOT be reverted.

**Also outside git (filesystem-only):**
- `.nexus/models/Xenova/nomic-embed-text-v1.5/` — downloaded model, untracked
- `00-System/Attachments/linked-data-vocabularies/lcsh_vectors.db` — generated database, untracked
- `00-Inbox/plan-04-semantic-database-final.md` — untracked (never committed)
- `00-Inbox/plan-05-semantic-panel-final.md` — untracked (never committed)

---

## Scope Boundary

| Layer | What it is | Action |
|---|---|---|
| **Semantic overlay** | Nomic embeddings, sqlite-vec, `lcsh_vectors.db`, semantic scripts | **Remove** |
| **Base LCSH tagging** | `lcsh.db`, `lcsh-lookup.js`, `retag-lcsh.py`, frontmatter schema, tag rules | **Keep** |
| **`lcsh-tag-infer.js`** | Pre-existing base script; `--semantic` flag added in e41187a | **Keep file, remove `--semantic` additions** |
| **`CLAUDE.md`, `nexus-chat-system-prompt.md`** | Only version-ref changes in 5e9b281 | **Keep as-is** |

---

## Step 1 — Delete: Nomic Model (filesystem)

Not tracked in git — filesystem delete only.

```
C:\Users\middl\Documents\Obsidian\Michael\.nexus\models\Xenova\nomic-embed-text-v1.5\
```

Delete the entire `nomic-embed-text-v1.5\` folder (~140 MB ONNX weights).

**Keep** the other two models in `Xenova\` — they are upstream conversation/trace models:
- `all-MiniLM-L6-v2\` — **KEEP**
- `bge-small-en-v1.5\` — **KEEP**

---

## Step 2 — Delete: LCSH Vector Database (filesystem)

Not tracked in git — filesystem delete only.

From `C:\Users\middl\Documents\Obsidian\Michael\00-System\Attachments\linked-data-vocabularies\`:
```
lcsh_vectors.db
lcsh_vectors.db-shm
lcsh_vectors.db-wal
```

**Keep** in the same directory (all pre-existing or plugin-managed):
```
lcsh.db / lcsh.db-shm / lcsh.db-wal   ← FTS vocabulary for lcsh-tag-infer.js
lcshSuggester.json                      ← linked-data-vocabularies plugin data
lcshSubdivSuggester.json                ← linked-data-vocabularies plugin data
lcshUriToPrefLabel.json                 ← linked-data-vocabularies plugin data
```

---

## Step 3 — Delete: Semantic LCSH Scripts (git rm)

Both files were created as new files in tracked commits:

```bash
git rm "00-System/Claude_Code/scripts/lcsh-concept-index.js"   # added in 5e9b281
git rm "00-System/Claude_Code/scripts/lcsh-semantic-match.js"  # added in 382906b
```

Also delete the installed npm packages these scripts required:
```
00-System/Claude_Code/scripts/node_modules/@xenova/
00-System/Claude_Code/scripts/node_modules/sqlite-vec/
```
(These directories are likely gitignored; delete from filesystem.)

---

## Step 4 — Delete: Archived Scripts (git rm)

These were committed to the archive folder in a pre-semantic commit but are no longer relevant:

```bash
git rm "00-System/Claude_Code/scripts/archive/lcsh-rebuild-vocab.js"
git rm "00-System/Claude_Code/scripts/archive/lcsh-tag-resolver-3.js"
git rm "00-System/Claude_Code/scripts/archive/phase4-auto-lcsh.py"
```

---

## Step 5 — Delete: Untracked Planning Docs (filesystem)

These two files exist in the working tree but were **never committed** (untracked `??` in vault git):

```
C:\Users\middl\Documents\Obsidian\Michael\00-Inbox\plan-04-semantic-database-final.md
C:\Users\middl\Documents\Obsidian\Michael\00-Inbox\plan-05-semantic-panel-final.md
```

> **`00-Inbox/lcsh-validate-system-skip.md` — do NOT delete**: This file is git-tracked (committed in `0616d03`, before the semantic pipeline work). It is a task note about adding a `type: system` skip to `lcsh-validate.js` — part of the **base LCSH infrastructure**, not the semantic pipeline. Keep it unless the task is complete, in which case archive it separately.

---

## Step 6 — Revert: `package.json` and `package-lock.json`

Commit `5e9b281` added `@xenova/transformers` and `sqlite-vec` to `package.json` and expanded `package-lock.json` from 46 lines to 1,062 lines. Restore both files to the pre-semantic state (commit `ab2c0dc`):

```bash
cd "C:\Users\middl\Documents\Obsidian\Michael"
git checkout ab2c0dc -- "00-System/Claude_Code/scripts/package.json"
git checkout ab2c0dc -- "00-System/Claude_Code/scripts/package-lock.json"
```

The restored `package.json` will contain only: `@anthropic-ai/sdk`, `better-sqlite3`, `dotenv`.

---

## Step 7 — Surgical Edit: `Nexus-MCP-Rules-v2.22.md`

File: `C:\Users\middl\Documents\Obsidian\Michael\02-Projects\Nexus\Nexus-MCP-Rules-v2.22.md`

Commit `5e9b281` replaced the single-model `semantic_search:` block with a dual-model block. Revert to the pre-5e9b281 state:

```yaml
# Remove this entire block (added by 5e9b281):
  semantic_search:
    note: Two models run simultaneously — scope determines which is used.
    notes_model:                          # searchContent (semantic: true)
      applies_to: notes and blocks (searchContent)
      model: Xenova/nomic-embed-text-v1.5
      dimensions: 768
      size: ~275MB
      storage: .nexus/cache.db (sqlite-vec, note_embeddings + block_embeddings)
      platform: Desktop only (local .nexus/models/)
      configurable: true (EmbeddingsTab settings)
    memory_model:                         # searchMemory
      applies_to: traces and conversations (searchMemory)
      model: Xenova/all-MiniLM-L6-v2
      dimensions: 384
      size: ~23MB
      storage: .nexus/cache.db (sqlite-vec, trace_embeddings + conversation_embeddings)
      platform: Desktop only (transformers.js iframe CDN)
      configurable: false (fixed)
    shared:
      first_run: Requires internet for model download
      subsequent: Fully offline
      indexing: Watch status bar, click to pause/resume

# Restore to (pre-5e9b281 state):
  semantic_search:
    model: Xenova/all-MiniLM-L6-v2
    dimensions: 384
    size: ~23MB
    storage: .nexus/cache.db (sqlite-vec)
    platform: Desktop only (transformers.js)
    first_run: Requires internet for model download
    subsequent: Fully offline
    indexing: Watch status bar, click to pause/resume
```

---

## Step 8 — Surgical Edit: `00-System/nexus_operations.md`

Commit `5e9b281` updated the Search Operations section to describe two models. Revert to single-model:

```
# Change (lines 43-47 of current file):
     - Two models run simultaneously — scope determines which:
     - searchContent (notes/blocks): Xenova/nomic-embed-text-v1.5, 768d, ~275MB, local .nexus/models/
     - searchMemory (traces/conversations): Xenova/all-MiniLM-L6-v2, 384d, ~23MB, transformers.js
     - First run: Requires internet for model download
     - Subsequent runs: Fully offline

# To (pre-5e9b281):
     - First run: Downloads 23MB embedding model (requires internet)
     - Subsequent runs: Fully offline
     - Model: Xenova/all-MiniLM-L6-v2 (384d)
```

---

## Step 9 — Surgical Edit: `00-System/script-inventory.md`

Two entries were added across two commits. Remove both rows:

- Row for `lcsh-concept-index.js` (added in `5e9b281`) — the one-time LCSH semantic concept index builder entry
- Row for `lcsh-semantic-match.js` (added in `382906b`) — the semantic LCSH candidate retrieval entry

---

## Step 10 — Surgical Edit: `VAULT.md`

Commit `5e9b281` added `auto-tagged` to the `lcsh_status` field in two locations. Remove it from both:

**Location 1** — field definition line (~line 92):
```
# Change:
lcsh_status: pending | auto-tagged | needs-review | validated  # required

# Restore to:
lcsh_status: pending | needs-review | validated  # required
```

**Location 2** — the `lcsh_status` enum description (~line 198):
```
# Remove this line:
auto-tagged   — tagged by embedding pipeline with high confidence; not yet human-confirmed

# Also change the needs-review description back:
# From:
needs-review  — tagged but requires validation (medium confidence or manual)
# To:
needs-review  — tagged but requires validation
```

**Location 3** — the `cc_latest.md`/`state.md` frontmatter example block (~line 244):
```
# Change:
lcsh_status: validated | auto-tagged | needs-review | pending

# To:
lcsh_status: validated | pending
```

**Do NOT touch:**
- The vault.md frontmatter (`lcsh_status: validated`, `lcsh_related:` etc.) — pre-existing
- The LCSH schema section (field definitions, tag format rules) — pre-existing
- The "LCSH Tag Lookup" bash block at the end of the schema section — pre-existing

---

## Step 11 — Surgical Edit: `MASTER_LOG.md`

Commit `fc13e8c` added one row to the Active Work table and one session log entry. Remove both:

**Active Work table** — the LCSH row was REPLACED (not added). Replace the 2026-03-30 row with the original 2026-03-26 row:
```
# Change:
| LCSH | 2026-03-30 | nexus-chat | Planned semantic-to-LCSH YAML generation using note chunk embeddings plus local LCSH authority data. Wrote architecture plan and implementation spec for chunk-to-authority semantic tagging, candidate ranking, provenance, and evaluation against validated notes. | Build LCSH concept index and prototype chunk-to-authority retrieval on a validated gold set |

# To:
| LCSH | 2026-03-26 | nexus-chat | Vault-Spec-Compliance-Guide.md reviewed; Known Issues section appended (6 issues: academic category contradiction, scalar tags gap, readwise-triage.ps1 python path failure, hardcoded vault path in Phase 7, unreliable search command in Phase 8.6, no bulk script for 1,639 domain files). | Fix issues documented in Known Issues section; write domain-fill script for 1,639 MISSING:domain files |
```

Also revert `modified: 2026-03-30` in the frontmatter to `modified: 2026-03-29`.

**Session log** — remove this entry:
```
2026-03-30 | nexus-chat | LCSH | Wrote semantic-to-LCSH architecture plan and MVP implementation spec for chunk-to-authority YAML proposal generation.
```

Keep all other LCSH session entries (they predate the semantic panel work).

---

## Step 12 — Surgical Edit: `lcsh-tag-infer.js`

Commit `e41187a` added the `--semantic` flag (46 lines spread through the file). Commits `6588124` and `edd9511` made legitimate improvements (CLI routing, async fix) that should be **kept**.

Remove the following additions from the current file:

1. **Arg parsing** — remove the `--semantic` flag line:
   ```javascript
   const SEMANTIC    = args.includes('--semantic');
   ```

2. **Usage comment block** — remove the two lines referencing `--semantic`

3. **Module load** — remove:
   ```javascript
   const { findLcshCandidates } = SEMANTIC ? require('./lcsh-semantic-match') : {};
   if (SEMANTIC) console.log('Semantic matching active (lcsh-semantic-match.js).');
   ```

4. **Per-file processing block** — remove the entire `if (SEMANTIC) { ... }` block that calls `findLcshCandidates` (~25 lines)

5. **Result object** — remove:
   ```javascript
   matchedSemantic: validated.filter(h => h.fromSemantic).map(h => h.pL),
   semanticAdded,
   ```
   and the `semanticAdded` from the destructured return

6. **Output lines** — remove the two lines that print `Semantic added:` and `Semantic (+N):`

7. **Mode label** — simplify back to:
   ```javascript
   const modeLabel = DRY_RUN ? 'DRY RUN' : 'APPLY';
   ```

There is also one uncommitted working-tree change (adding `.replace(/\\/g, '/')` to the `relPath` line) — this is a legitimate Windows path fix unrelated to semantic work. **Keep it.**

---

## Step 13 — Archive: `02-Projects/LCSH/` Directory

The LCSH project directory contains 46+ notes (audit reports, phase completion docs, strategy analysis). Move to archive rather than delete — the tagging decisions and audit history are useful reference.

```
Move: 02-Projects/LCSH/ → 04-Archive/LCSH/
```

Use `git mv` to preserve history:
```bash
cd "C:\Users\middl\Documents\Obsidian\Michael"
git mv "02-Projects/LCSH" "04-Archive/LCSH"
```

Then update `Vault_map.md` — change the LCSH row in the Active Projects table:
```
# From:
| LCSH | System | `02-Projects/LCSH/project_outline.md` |

# To:
| LCSH | Archived | `04-Archive/LCSH/project_outline.md` |
```

---

## Step 14 — No Action: `CLAUDE.md` and `nexus-chat-system-prompt.md`

Commit `5e9b281` changed these files only to update version refs (`v2.21→v2.22`, `v2.12→v2.22`). These are correct and should stay as-is. **No revert needed.**

---

## Step 15 — No Action: `data.json` (Nexus plugin settings)

The Nexus plugin writes its settings to `.obsidian/plugins/claudesidian-mcp/data.json`. Once plan-11 is deployed (semantic settings fields removed from `PluginTypes.ts`), any persisted semantic settings will simply be ignored on next load. **No manual edit needed.**

---

## Summary

| Step | Type | Target | Action |
|---|---|---|---|
| 1 | Filesystem delete | `.nexus/models/Xenova/nomic-embed-text-v1.5/` | Delete ~140 MB |
| 2 | Filesystem delete | `lcsh_vectors.db` + shm/wal | Delete ~1.57 GB |
| 3 | git rm | `lcsh-concept-index.js`, `lcsh-semantic-match.js` | Delete tracked files |
| 4 | git rm | 3 archived scripts | Delete tracked files |
| 5 | Filesystem delete | 2 untracked `00-Inbox/` docs | Delete untracked files (plan-04, plan-05 only; lcsh-validate-system-skip.md is tracked, pre-existing, keep) |
| 6 | git checkout | `package.json`, `package-lock.json` | Restore to commit `ab2c0dc` |
| 7 | Surgical edit | `Nexus-MCP-Rules-v2.22.md` | Remove Nomic dual-model block |
| 8 | Surgical edit | `nexus_operations.md` | Revert to single-model description |
| 9 | Surgical edit | `script-inventory.md` | Remove 2 LCSH semantic script rows |
| 10 | Surgical edit | `VAULT.md` | Remove `auto-tagged` from enum (2 locations) |
| 11 | Surgical edit | `MASTER_LOG.md` | Remove 2026-03-30 LCSH semantic entries |
| 12 | Surgical edit | `lcsh-tag-infer.js` | Remove `--semantic` flag additions (~46 lines) |
| 13 | git mv + edit | `02-Projects/LCSH/` → `04-Archive/LCSH/` | Archive project; update Vault_map.md |
| 14 | No action | `CLAUDE.md`, `nexus-chat-system-prompt.md` | Version refs only — keep |
| 15 | No action | `data.json` | Plan-11 handles at code level |

**Storage recovered**: ~1.74 GB (lcsh_vectors.db 1.57 GB + Nomic model 140 MB)

---

## Order of Operations

1. Steps 1–5: Delete (no dependencies — any order)
2. Step 6: `git checkout ab2c0dc` for package files
3. Steps 3–4: `git rm` the tracked new files
4. Steps 7–12: Surgical edits (any order — all independent)
5. Step 13: `git mv` for LCSH project archive + Vault_map.md edit
6. Commit: `git commit -m "revert: remove LCSH semantic pipeline and Nomic embedding additions"`

---

## What Is NOT Reverted (Confirmed Pre-Existing via Git)

| Item | Why kept |
|---|---|
| `lcsh.db` and plugin JSON files | Pre-existing; used by linked-data-vocabularies plugin and base LCSH scripts |
| `lcsh-lookup.js`, `lcsh-validate.js`, `lcsh-apply-map.js`, `retag-lcsh.py` et al. | Pre-existing LCSH tools; no Nomic dependency |
| LCSH schema fields in `vault.md` | Pre-existing vault schema; `auto-tagged` enum value is the only removal |
| LCSH Commands in `claude.md` | Pre-existing section; no changes needed |
| `lcsh-tag-infer.js` CLI refactor (commits 6588124, edd9511) | Improvements to base script unrelated to Nomic; keep |
| Session log entries pre-2026-03-30 | Historical record of the tagging initiative |
| LCSH frontmatter on vault notes (`lcsh_status`, `lcsh_related`, etc.) | Applied by the base tagging pipeline; not the embedding work |

## Execution Log
- Step 1 ✓ Nomic model deleted: `.nexus/models/Xenova/nomic-embed-text-v1.5/`
- Step 2 ✓ lcsh_vectors.db + shm/wal deleted
- Step 5 ✓ 00-Inbox plan-04 and plan-05 docs deleted
- Step 6 ✓ package.json/lock restored to ab2c0dc (xenova/sqlite-vec absent confirmed)
- Step 3 ✓ git rm lcsh-concept-index.js, lcsh-semantic-match.js
- Step 4 ✓ git rm 3 archived scripts; node_modules/@xenova, sqlite-vec, sqlite-vec-windows-x64 deleted
- Step 7 ✓ Nexus-MCP-Rules-v2.22.md: dual-model block → single-model block
- Step 8 ✓ nexus_operations.md: dual-model description reverted (3 lines)
- Step 9 ✓ script-inventory.md: 2 semantic script rows removed
- Step 10 ✓ VAULT.md: auto-tagged removed from all 3 locations (lines 92, 198-199, 243)
- Step 11 ✓ MASTER_LOG.md: LCSH row restored to 2026-03-26; session entry removed; modified reverted to 2026-03-29
- Step 12 ✓ lcsh-tag-infer.js: all 7 --semantic additions removed; Windows path fix preserved
- Step 13 ✓ 02-Projects/LCSH → 04-Archive/LCSH (git mv); Vault_map.md updated
- Steps 14,15 ✓ No action confirmed (CLAUDE.md/nexus-chat-system-prompt.md version refs kept; data.json handled by plan-11)
- COMMIT ✓ 870dc27 — "revert: remove LCSH semantic pipeline and Nomic embedding additions"
