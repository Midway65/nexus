# Plan: Fix 10–15 s chat-window database load (full-rebuild O(N²) + cache fragility)

**Status:** ⚠️ **SUPERSEDED (2026-09-01)** — Tier A was fixed upstream and is already in this fork. Do not implement Tier A. Tier B and Tier C remain open; see the status block below.
**Authored:** 2026-06-03 (fork `my-custom-branch`, at v5.10.0)
**Owner area:** `src/database/sync/SyncCoordinator.ts`, `src/database/storage/*`, `src/database/adapters/HybridStorageAdapter.ts`
**Upstream status:** NOT addressed upstream as of `e2db3ed7` (v5.10.0). Save-per-file predates the LF normalization (`c3cb0e37`); the most recent storage work (`3cf6d3f5 fix: recover stalled startup hydration`) only *recovers* from a stalled rebuild rather than removing its cost. → A fix is a new fork change and a clean upstream-PR candidate.

---

## 0. Supersede notice (added 2026-09-01, fork at v5.16.4)

**Tier A is done — upstream fixed it, and the fork already carries the fix.**

Upstream commit `a5fb820d` "Fix cold cache rebuild persistence" (2026-06-04, one day after this
plan was authored) removed all three per-file `sqliteCache.save()` calls from `fullRebuild()`'s
loops, going further than this plan proposed: it saves **once** at the end rather than flushing
every K files. It also removed the `catch` block that persisted sync state after a *failed*
rebuild — which had been masking failures as success and is a second contributor to §2.5's
intermittency.

Verified in the current tree: [`SyncCoordinator.ts`](../../src/database/sync/SyncCoordinator.ts)
has exactly three `sqliteCache.save()` calls (lines 207, 245, 320) — all end-of-pass, none inside
`rebuildWorkspaces` / `rebuildConversations` / `rebuildTasks`. The O(N²) behaviour this plan
diagnoses no longer exists in the fork. §4's "new fork divergence → offer as upstream PR"
sequencing is therefore moot; convergence happened without a fork change.

Two upstream follow-ups in the unmerged v5.17–5.18 range harden the same area further:
`83a128bf` (arm the startup rebuild watchdog on the background branch too, #158) and
`f34e96f9` (index conversations first, and re-derive them after a cache rebuild, #361).

**What is still open:**

| Tier | Status | Note |
|------|--------|------|
| **A** — batch the rebuild saves | ✅ **Superseded by upstream** | Already in the fork. Nothing to do. |
| **B** — stop the rebuild re-firing | ❌ **Open** | No verify-after-write in `SQLitePersistenceService.saveDatabase`, and `navigator.storage.persisted()` is still only consulted inside `IndexedDBCacheBlobStore.requestPersistOnce()` (best-effort, never surfaced). Re-measure before acting — Tier A's landing may have removed the practical trigger. |
| **C** — workspace-log bloat (132 MB) | ❌ **Open** | Untouched upstream. Still a standalone investigation. |

Re-measure the actual overlay duration on this vault before spending effort on B or C.

---

## 1. Symptom

The chat window shows the *"Updating local chat index…"* overlay for **up to 10–15 s** before conversations appear. Reported as **intermittent**: always after a plugin upgrade/deploy, and sporadically on plain Obsidian restarts.

## 2. Diagnosis (evidence-backed)

### 2.1 The chat window blocks on global SQLite hydration
- [`ChatView.onOpen()`](../../src/ui/chat/ChatView.ts#L195) → `performFullInitialization()` → [`waitForDatabaseReady()`](../../src/ui/chat/ChatView.ts#L215) → [`waitForStartupHydration()`](../../src/ui/chat/ChatView.ts#L269).
- The hydration loop ([ChatView.ts:291-317](../../src/ui/chat/ChatView.ts#L291)) polls at **500 ms** granularity and only blocks while the adapter reports `isStartupHydrationBlocking()` true.
- The chat code is *not* the cause — it waits for a global startup operation.

### 2.2 The overlay only appears when the SQLite cache is EMPTY at boot
- [`HybridStorageAdapter.performInitialization()`](../../src/database/adapters/HybridStorageAdapter.ts#L285) sets blocking + full-rebuild when [`shouldBlockStartupHydration`](../../src/database/adapters/HybridStorageAdapter.ts#L530) is true.
- That predicate ([`shouldBlockStartupHydrationForVerifiedCutover`](../../src/database/adapters/lifecycle/StartupHydrationController.ts#L14)) is true iff: migration `verified` + source `vault-root` + JSONL files exist + **cached conversations = 0 AND cached messages = 0**.
- So "slow" ⇔ "the cache blob was empty/missing at startup" ⇒ a **full rebuild** runs ([`runStartupFullRebuild`](../../src/database/adapters/HybridStorageAdapter.ts#L354) → [`SyncCoordinator.fullRebuild`](../../src/database/sync/SyncCoordinator.ts#L261)).

### 2.3 The full rebuild is O(N²): it re-serializes the whole DB once per file
- [`rebuildWorkspaces`](../../src/database/sync/SyncCoordinator.ts#L421), [`rebuildConversations`](../../src/database/sync/SyncCoordinator.ts#L485), [`rebuildTasks`](../../src/database/sync/SyncCoordinator.ts#L584) each call `await this.sqliteCache.save()` **after every file** ([:476](../../src/database/sync/SyncCoordinator.ts#L476), [:525](../../src/database/sync/SyncCoordinator.ts#L525), [:625](../../src/database/sync/SyncCoordinator.ts#L625)).
- [`save()` → `saveToFile()` → `SQLitePersistenceService.saveDatabase()`](../../src/database/storage/SQLitePersistenceService.ts#L51) does a **full** `exportDatabase()` (serialize the entire in-memory DB to an ArrayBuffer) then writes the whole blob to IndexedDB ([`IndexedDBCacheBlobStore.write`](../../src/database/storage/IndexedDBCacheBlobStore.ts#L62), a single `put` of the whole blob). No incremental write, no debounce.
- **Contrast — the incremental `sync()` path does it correctly:** apply all changed files, then save **once** at the end ([:207](../../src/database/sync/SyncCoordinator.ts#L207), [:245](../../src/database/sync/SyncCoordinator.ts#L245)).

### 2.4 This vault hits the pathological case
- Data folder `00-System/Nexus/data` = **132 MB** of JSONL across **70 workspace shards + 27 conversation shards ≈ 97 files**; individual shards up to **10.7 MB** (`ws_Final Portfolio`), several 4 MB (`ws_default` ×7).
- Full rebuild ⇒ **~97 full-DB serializations** of a monotonically growing ~130 MB DB ⇒ O(N²) ≈ `97 × avg(DB size)` of serialize + IndexedDB write.
- **Console confirmation (user, 2026-06-03):** SQLite WASM heap resized `16 MB → 133 MB → 160 MB → 283 MB`. The 133 MB step is the DB in memory; the 283 MB step (~2× DB) is the export buffer alongside the live DB — i.e. an export/rebuild was in progress. Also visible: omnisearch indexing 9,234 files for **45 s** concurrently → heavy memory/storage pressure at the same window.

### 2.5 Why it is INTERMITTENT
The overlay only fires on an empty cache, so intermittency = the ~130 MB cache blob intermittently does not survive to the next boot:
1. **Single 130 MB IndexedDB record** ([write:62-76](../../src/database/storage/IndexedDBCacheBlobStore.ts#L62)) is near the edge of comfortable persistence; evictable under storage pressure unless [`requestPersistOnce()`](../../src/database/storage/IndexedDBCacheBlobStore.ts#L128) was granted (heuristic, not guaranteed).
2. **Write may not flush before shutdown** — the blob is rewritten ~97× during rebuild and a final authoritative save at the end; if Obsidian is closed/killed first (the deploy script `Stop-Process`es it), the blob is left empty/stale.
3. **Concurrent startup contention** (omnisearch 45 s + embeddings init + readwise) is exactly when SQLite tries to load/write 130 MB.
→ "Always after upgrade" (deploy kills Obsidian + cache-backend migration ⇒ empty cache ⇒ guaranteed rebuild); "sometimes on restart" (eviction or unflushed prior save).

### 2.6 Root amplifier
132 MB / ~130 MB DB is abnormal and is almost entirely **workspace event logs** (activity/trace), not chat. A smaller DB makes both the rebuild cost and the persistence fragility largely disappear.

### 2.7 Note on the existing comment
`// Save after each file to prevent memory accumulation (OOM prevention)` is misleading: `save()` serializes + writes but does **not** free the in-memory DB (heap keeps climbing — see 2.4). Per-file saving prevents nothing memory-wise; it only multiplies the cost. Peak export-buffer size is identical whether you save once or 97×. The incremental `sync()` path proves once-at-end is safe.

---

## 3. Fix — tiered

### Tier A — Batch the rebuild saves (the O(N²) killer)
**Surface:** `src/database/sync/SyncCoordinator.ts` only. ~15 lines. Low risk.

**Change:** remove the per-file `await this.sqliteCache.save()` in `rebuildWorkspaces` ([:476](../../src/database/sync/SyncCoordinator.ts#L476)), `rebuildConversations` ([:525](../../src/database/sync/SyncCoordinator.ts#L525)), `rebuildTasks` ([:625](../../src/database/sync/SyncCoordinator.ts#L625)). Replace with a **periodic flush every K files** (proposed `K = 16`) as a durability hedge, plus the already-present final save at [`fullRebuild`:290-292](../../src/database/sync/SyncCoordinator.ts#L290).

Sketch (per rebuild method):
```ts
// at top: const SAVE_EVERY = 16;
files.push(file);
options.onProgress?.('Processing conversations', i + 1, conversationFiles.length);
if ((i + 1) % SAVE_EVERY === 0) {
  await this.sqliteCache.save();   // periodic durability flush, NOT per-file
}
// (final save still happens once in fullRebuild() after all categories + FTS)
```

**Effect:** ~97 serializations → ~⌈70/16⌉+⌈27/16⌉+0 + final ≈ **5–7** total. Expected to cut the overlay from 10–15 s to ~2–4 s. Peak memory unchanged.

**Why K-batching rather than literally once:** if the rebuild throws midway, the last completed batch is already durable; with K=16 we keep nearly all the speed-up while bounding lost-progress to ≤16 files. (A pure save-once-at-end is also acceptable and matches `sync()`; K-batching is the conservative choice.)

**Tests** (`tests/unit/` — mirror existing SyncCoordinator coverage):
- Assert `sqliteCache.save` call-count during a `fullRebuild` over N stub files is `~N/K + 1`, not `N`.
- Assert all events still applied (no data loss) and final state saved exactly once after FTS.
- Assert a throw in the middle still leaves the prior batch persisted.

**Acceptance:** `tsc --noEmit` clean, `eslint .` clean, new tests + existing SyncCoordinator tests green. Manual: deploy, force a rebuild (DevTools `Nexus: Rebuild cache`), confirm overlay duration drops and console no longer shows ~97 export cycles.

### Tier B — Stop the rebuild re-firing (the intermittency)
**Surface:** `SQLitePersistenceService.saveDatabase` / `IndexedDBCacheBlobStore` / `HybridStorageAdapter`. Medium.

- **Verify-after-write** on the authoritative final save: after `blobStore.write(buffer)`, read back `getMetadata().size` and assert it equals `buffer.byteLength`; if mismatch, log loudly and surface (don't silently declare success → empty cache next boot).
- **Persisted-storage check:** confirm `navigator.storage.persisted()`; if false, the cache is evictable — log it and consider a one-time user nudge. (Pairs with the manual `navigator.storage.estimate()` / `.persisted()` console checks.)
- Optional: small startup log line stating `rebuild ran (reason: empty cache | no syncState | migrated)` so future "is it re-running every boot?" questions are answerable from the console.

### Tier C — Attack the 132 MB root cause (workspace-log bloat)
**Surface:** workspace event appliers / trace writers. Larger, separate investigation.
- Determine why workspace shards reach 10 MB (which event types dominate — likely activity/trace).
- Evaluate compaction/pruning or retention for trace/activity events. A smaller DB makes A and B largely moot and improves general responsiveness.
- This is an investigation task, not a quick patch — scope separately.

---

## 4. Sequencing & fork considerations
1. **Tier A first** — biggest, safest, self-contained win. Implement on a branch off `my-custom-branch`; this is a new fork divergence in `SyncCoordinator.ts` (Tier 1/2 in `docs/fork_divergence.md`) **until** contributed upstream.
2. **Offer Tier A as an upstream PR** to `ProfSynapse/nexus` — clean perf fix, benefits everyone, retires the fork divergence on merge (aligns with the fork's full-congruence goal).
3. **Tier B** after A is validated in the user's vault (measure first).
4. **Tier C** as a separate investigation if the data stays large.

## 5. Risks / watch-items
- `markEventApplied` + `applied_events` dedupe must still hold with batched saves (they live in the same DB, persisted together — no change to ordering).
- Confirm `BatchOperations.executeBatch` (`delayBetweenBatches: 10` for workspaces/tasks) is unaffected — we only change *save* cadence, not event-apply batching.
- Do NOT change the incremental `sync()` path — it is already correct.
- Keep the final save + `rebuildFTSIndexes` + `updateSyncState` exactly once at the end of `fullRebuild`.
- LF line endings only (`.gitattributes`); avoid CRLF churn in `SyncCoordinator.ts`.

## 6. Quick confirmation steps for the user (no code)
In DevTools console during/after a slow restart:
```js
await navigator.storage.estimate()   // usage vs quota — near the cap?
await navigator.storage.persisted()  // false ⇒ cache is evictable (explains intermittency)
```
Watch console for `[SyncCoordinator] Full rebuild` and any `Failed to save to blob store` / IDB abort errors. Distinguishes eviction (persisted=false, near quota) from failed-write-on-shutdown (save errors).
