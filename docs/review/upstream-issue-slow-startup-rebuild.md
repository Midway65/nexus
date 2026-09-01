# Slow startup: full cache rebuild re-serializes the entire DB once per file (O(N²)), blocking the chat view 10–15 s

**Version:** v5.10.0 · **Platform:** Obsidian desktop (Electron), Windows 11 · **Cache backend:** IndexedDB

> [!NOTE]
> **RESOLVED UPSTREAM — do not file (added 2026-09-01).** This report was drafted for submission
> to `ProfSynapse/nexus` but never sent. Upstream fixed it independently in `a5fb820d`
> "Fix cold cache rebuild persistence" (2026-06-04), which removes all three per-file
> `save()` calls and saves once at the end — the same fix this report proposes, and slightly
> stronger. It also stops a failed rebuild from persisting sync state. The fork picked the fix up
> via the v5.11.x merge train; `SyncCoordinator.ts` in this tree no longer saves per file.
> Kept as a record of the diagnosis. Remaining unaddressed items from the "Proposed fix →
> Secondary" section are tracked as Tier B in
> [`docs/plans/chat-db-load-slow-rebuild-plan.md`](../plans/chat-db-load-slow-rebuild-plan.md).

## Summary

When the SQLite cache is empty at startup, `SyncCoordinator.fullRebuild()` replays the JSONL event store into SQLite and calls `save()` **after every file**. `save()` is not incremental — it serializes the **entire** in-memory database and rewrites the **entire** IndexedDB blob each time. So a rebuild performs one full-database export per JSONL file, over a database that grows as it goes: total work scales as *file count × database size*. On a large vault this blocks the chat view behind the *"Updating local chat index…"* overlay for **10–15 s**.

The incremental sync path in the same class already does this correctly — it saves **once** at the end — which is the fix template.

## Reproduction (deterministic)

1. Use a vault with substantial history (tens of MB of conversation/workspace JSONL).
2. Run **`Nexus: Rebuild cache`** (or otherwise start with an empty cache).
3. Restart Obsidian and open the chat view.

**Expected:** rebuild completes in a couple of seconds.
**Actual:** the *"Updating local chat index…"* overlay blocks the chat view ~10–15 s.

## Root cause

The chat view only *waits* on global hydration (`ChatView.waitForDatabaseReady` → `waitForStartupHydration`). Hydration is marked *blocking* when the cache is empty for a verified vault-root install (`shouldBlockStartupHydrationForVerifiedCutover`: JSONL present, cached conversations = 0 and messages = 0), which triggers `HybridStorageAdapter.runStartupFullRebuild` → `SyncCoordinator.fullRebuild()`.

Each of the three rebuild loops saves the whole DB after every file — `src/database/sync/SyncCoordinator.ts`:

- `rebuildWorkspaces()` — line **476**
- `rebuildConversations()` — line **525**
- `rebuildTasks()` — line **625**

```ts
// Save after each file to prevent memory accumulation (OOM prevention)
await this.sqliteCache.save();
```

`save()` exports and rewrites the whole database every call — `src/database/storage/SQLitePersistenceService.ts`, `saveDatabase()` (line **51**):

```ts
buffer = this.bridge.exportDatabase(sqlite3, db);   // serialize the WHOLE db
await this.blobStore.write(buffer);                 // rewrite the WHOLE blob
```

…and the blob is a single IndexedDB record holding the entire database — `src/database/storage/IndexedDBCacheBlobStore.ts`, `write()` (line **62**):

```ts
tx.objectStore(STORE_NAME).put(value, this.idbKey); // value.blob = entire DB
```

For *N* files this is *N* full-DB exports over a monotonically growing DB → quadratic in history size.

### The incremental path is already correct

`SyncCoordinator.sync()` applies all changed files and then saves **once** — `src/database/sync/SyncCoordinator.ts` lines **207** and **245**. Only `fullRebuild()` saves per file.

### The per-file comment doesn't hold

The `// ...prevent memory accumulation (OOM prevention)` rationale is inaccurate: `save()` does not free the in-memory database, so saving per file does not reduce peak memory — the export buffer is the same size whether the DB is saved once or N times. Per-file saving only multiplies I/O. `sync()` (save-once) demonstrates this is safe.

## Evidence

SQLite WASM heap growth logged during an affected startup:

```
Heap resize 16 MB → 133 MB     // database deserialized into memory
Heap resize 133 MB → 160 MB
Heap resize 160 MB → 283 MB    // ≈ 2× DB: live DB + a full export buffer alongside it
```

A warm startup only *deserializes* the cache (one growth to roughly the DB size); it never exports. The additional growth to ~2× the DB size during startup indicates an `exportDatabase()` is running — i.e. the rebuild path. Example vault: ~132 MB of JSONL across ~100 shard files (workspaces dominate; largest single shard 10.7 MB), so the rebuild runs on the order of 100 full-DB exports.

## When does the rebuild fire (and why it can recur)

A rebuild runs whenever the cache is empty at boot. This is guaranteed after the cache-backend migration and after `Nexus: Rebuild cache`, but it has also been observed to recur intermittently across ordinary restarts. The likely contributing factor is that the cache is a **single ~130 MB IndexedDB record** (`IndexedDBCacheBlobStore.write`, one `put` under one key):

- Such a large record is evictable under storage pressure unless persistent storage is granted; `requestPersistOnce()` (line **128**) is best-effort and `navigator.storage.persisted()` may be `false`.
- During a rebuild the blob is rewritten once per file with the authoritative save last; if the app closes before that final large write flushes, the next boot sees an empty cache and rebuilds again.
- Startup often overlaps other heavy indexing work, concentrating memory/storage pressure on the 130 MB load/write window.

(Not fully proven; offered as the most plausible mechanism for the intermittent recurrence. The O(N²) cost above is independent of this and reproducible on demand.)

## Proposed fix

**Primary — batch the rebuild saves (O(N²) → O(N)).** In `fullRebuild()`'s three loops, drop the per-file `save()` (`SyncCoordinator.ts:476`, `:525`, `:625`) and flush periodically instead, relying on the existing single final save after the FTS rebuild (`:290–292`):

```ts
const SAVE_EVERY = 16;
// inside each rebuild loop, after files.push(file):
if ((i + 1) % SAVE_EVERY === 0) {
  await this.sqliteCache.save();
}
// final save remains once in fullRebuild(), after rebuildFTSIndexes()
```

This turns *N* exports into ~⌈N/16⌉ + 1 with no change to peak memory — expected to cut the overlay from 10–15 s to ~2–4 s on a large vault. A pure save-once-at-end (matching `sync()`) would also work; periodic flushing just bounds lost progress if the rebuild throws midway.

**Secondary (optional, separate).**
- Verify the authoritative save landed (read the record back, confirm expected size) so a silently-failed large IndexedDB write doesn't present as success and force a rebuild next boot.
- Surface `navigator.storage.persisted()` — if `false`, the cache is evictable.
- Consider chunking very large blobs across multiple records to reduce single-record write fragility.

---

Line numbers are against v5.10.0. Happy to open a PR for the primary fix.
