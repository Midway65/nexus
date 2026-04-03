/**
 * Location: src/services/embeddings/NoteEmbeddingService.ts
 * Purpose: Persistence and query logic for note-level and block-level embeddings.
 *
 * Responsibilities (post-Plan-04 refactor):
 * - Note and block embedding upsert / remove / rename
 * - Cosine-based similarity search (vec_distance_cosine on L2-normalized vectors)
 * - Index stats and cleanup
 * - getIndexState() for panel / UI consumption
 *
 * NOT responsible for:
 * - Vault access or event handling (handled by EmbeddingIndexCoordinator)
 * - Text preprocessing or model inference (handled by EmbeddingRuntime / EmbeddingPreprocessor)
 * - Exclusion decisions (handled by EmbeddingExclusionService)
 *
 * Schema dependency: expects schema v12 tables:
 *   note_embeddings (vec0, float[N]), embedding_metadata,
 *   block_embeddings (vec0, float[N]), block_embedding_metadata, embedding_config
 */

import { App, TFile } from 'obsidian';
import type { EmbeddingRuntime } from './EmbeddingRuntime';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';
import { preprocessContent, hashContent } from './EmbeddingUtils';
import { chunkNote } from './NoteChunker';

export interface SimilarNote {
  notePath: string;
  score: number; // cosine similarity in [0, 1]; higher = more similar
}

export interface SimilarBlock {
  notePath: string;
  chunkIndex: number;
  heading: string | null;
  contentPreview: string;
  score: number;
}

export interface IndexState {
  noteCount: number;
  blockCount: number;
  activeModel: string | null;
  activeDimension: number | null;
  blockIndexingEnabled: boolean;
  blockIndexStale: boolean;
  lastRebuildAt: number | null;
}

export class NoteEmbeddingService {
  // Cached embedding_config rows — invalidated on every setConfigValue() write.
  // Eliminates ~1 full table scan per note during indexing (1000-note vault = 1000 reads → 1).
  private configCache: {
    activeModel: string | null;
    activeDimension: number | null;
    blockIndexingEnabled: boolean;
    blockIndexStale: boolean;
    lastRebuildAt: number | null;
    minIndexLength: number;
  } | null = null;

  constructor(
    private app: App,
    private db: SQLiteCacheManager,
    private runtime: EmbeddingRuntime,
  ) {}

  /**
   * Hot-swap the runtime (called after model selection change in EmbeddingsTab).
   * The old runtime must already be disposed by the caller.
   */
  switchRuntime(newRuntime: EmbeddingRuntime): void {
    this.runtime = newRuntime;
  }

  // ---------------------------------------------------------------------------
  // Index state
  // ---------------------------------------------------------------------------

  async getIndexState(): Promise<IndexState> {
    try {
      const noteCount = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM embedding_metadata'
      );
      const blockCount = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM block_embedding_metadata'
      );
      const config = await this.loadConfig();

      return {
        noteCount: noteCount?.count ?? 0,
        blockCount: blockCount?.count ?? 0,
        activeModel: config.activeModel,
        activeDimension: config.activeDimension,
        blockIndexingEnabled: config.blockIndexingEnabled,
        blockIndexStale: config.blockIndexStale,
        lastRebuildAt: config.lastRebuildAt,
      };
    } catch {
      return {
        noteCount: 0,
        blockCount: 0,
        activeModel: null,
        activeDimension: null,
        blockIndexingEnabled: false,
        blockIndexStale: false,
        lastRebuildAt: null,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Note embedding upsert
  // ---------------------------------------------------------------------------

  async embedNote(notePath: string): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (!file || !(file instanceof TFile) || file.extension !== 'md') {
        await this.removeNote(notePath);
        return;
      }

      const fileMtime = file.stat.mtime;

      // Load config once for this note (result is cached across all notes in a run)
      const config = await this.loadConfig();

      const existing = await this.db.queryOne<{ rowid: number; contentHash: string; mtime: number }>(
        'SELECT rowid, contentHash, mtime FROM embedding_metadata WHERE notePath = ?',
        [notePath]
      );

      // Fast path: mtime unchanged means the file hasn't been modified — skip everything.
      // This eliminates vault.read(), hash computation, and model inference for the vast
      // majority of notes during startup reconcile and refresh runs.
      if (existing && existing.mtime === fileMtime) {
        return;
      }

      const content = await this.app.vault.read(file);
      const processedContent = preprocessContent(content, this.runtime.maxChars);
      if (!processedContent) {
        // Content is empty or too short after processing — remove any stale index row.
        await this.removeNote(notePath);
        return;
      }

      if (processedContent.length < config.minIndexLength) {
        // Below the user-configured threshold — remove any stale index row so that
        // raising the threshold and reconciling produces a clean result.
        await this.removeNote(notePath);
        return;
      }

      const contentHash = hashContent(processedContent);

      if (existing && existing.contentHash === contentHash) {
        // mtime changed but content is the same (e.g. touch, metadata-only save).
        // Update mtime so the fast path fires next time; no re-embedding needed.
        const now = Date.now();
        await this.db.run(
          'UPDATE embedding_metadata SET mtime = ?, updated = ? WHERE rowid = ?',
          [fileMtime, now, existing.rowid]
        );
        if (config.blockIndexingEnabled && !config.blockIndexStale) {
          await this.embedNoteBlocks(notePath, content, file.basename);
        }
        return;
      }

      // Content changed — full re-embed
      const embedding = await this.runtime.embedDocument(processedContent);
      const embeddingBuffer = Buffer.from(embedding.buffer);
      const now = Date.now();
      const modelInfo = { id: this.runtime.currentModelId, dimensions: this.runtime.dimensions };

      if (existing) {
        await this.db.run(
          'UPDATE note_embeddings SET embedding = ? WHERE rowid = ?',
          [embeddingBuffer, existing.rowid]
        );
        await this.db.run(
          'UPDATE embedding_metadata SET contentHash = ?, mtime = ?, updated = ?, model = ?, dimension = ? WHERE rowid = ?',
          [contentHash, fileMtime, now, modelInfo.id, modelInfo.dimensions, existing.rowid]
        );
      } else {
        await this.db.run(
          'INSERT INTO note_embeddings(embedding) VALUES (?)',
          [embeddingBuffer]
        );
        const result = await this.db.queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
        const rowid = result?.id ?? 0;
        await this.db.run(
          `INSERT INTO embedding_metadata(rowid, notePath, model, dimension, contentHash, mtime, created, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [rowid, notePath, modelInfo.id, modelInfo.dimensions, contentHash, fileMtime, now, now]
        );
      }

      // Optionally embed blocks (reuse config loaded above)
      if (config.blockIndexingEnabled && !config.blockIndexStale) {
        await this.embedNoteBlocks(notePath, content, file.basename);
      }
    } catch (error) {
      console.error(`[NoteEmbeddingService] Failed to embed note ${notePath}:`, error);
      throw error;
    }
  }

  /**
   * Embed a batch of notes in one GPU forward pass.
   *
   * Phase 1 (sequential, fast): mtime check → read → preprocess → hash check.
   *   Notes that pass all checks are collected into a list.
   * Phase 2 (one call): runtime.embedDocuments() — all collected texts in one
   *   forward pass. On WebGPU this parallelises across the full batch.
   * Phase 3 (sequential, fast): store each result to DB.
   *
   * Notes that are unchanged, excluded by content rules, or fail phase 1 are
   * handled exactly as embedNote() would handle them. The coordinator supplies
   * paths that have already passed shouldIndex().
   */
  async embedNoteBatch(notePaths: string[]): Promise<void> {
    if (notePaths.length === 0) return;

    const config = await this.loadConfig();
    const modelInfo = { id: this.runtime.currentModelId, dimensions: this.runtime.dimensions };

    type PendingEmbed = {
      path: string;
      file: TFile;
      processedContent: string;
      contentHash: string;
      fileMtime: number;
      existing: { rowid: number; contentHash: string; mtime: number } | null;
      rawContent: string;
    };

    // Phase 1: determine which notes need re-embedding
    const toEmbed: PendingEmbed[] = [];

    for (const notePath of notePaths) {
      try {
        const file = this.app.vault.getAbstractFileByPath(notePath);
        if (!file || !(file instanceof TFile) || file.extension !== 'md') {
          await this.removeNote(notePath);
          continue;
        }

        const fileMtime = file.stat.mtime;
        const existing = await this.db.queryOne<{ rowid: number; contentHash: string; mtime: number }>(
          'SELECT rowid, contentHash, mtime FROM embedding_metadata WHERE notePath = ?',
          [notePath]
        );

        if (existing && existing.mtime === fileMtime) continue; // Fast path: unchanged

        const content = await this.app.vault.read(file);
        const processedContent = preprocessContent(content, this.runtime.maxChars);
        if (!processedContent || processedContent.length < config.minIndexLength) {
          await this.removeNote(notePath);
          continue;
        }

        const contentHash = hashContent(processedContent);
        if (existing && existing.contentHash === contentHash) {
          // mtime changed, content identical — update mtime only, no re-embed needed
          const now = Date.now();
          await this.db.run(
            'UPDATE embedding_metadata SET mtime = ?, updated = ? WHERE rowid = ?',
            [fileMtime, now, existing.rowid]
          );
          if (config.blockIndexingEnabled && !config.blockIndexStale) {
            await this.embedNoteBlocks(notePath, content, file.basename);
          }
          continue;
        }

        toEmbed.push({ path: notePath, file, processedContent, contentHash, fileMtime, existing, rawContent: content });
      } catch (error) {
        console.error(`[NoteEmbeddingService] Pre-check failed for ${notePath}:`, error);
      }
    }

    if (toEmbed.length === 0) return;

    // Phase 2: single batch inference call — throws on model errors, which the
    // coordinator catches and surfaces via isModelError().
    const embeddings = await this.runtime.embedDocuments(toEmbed.map(n => n.processedContent));

    // Phase 3: store results
    for (let i = 0; i < toEmbed.length; i++) {
      const { path: notePath, file, contentHash, fileMtime, existing, rawContent } = toEmbed[i];
      try {
        const embeddingBuffer = Buffer.from(embeddings[i].buffer);
        const now = Date.now();

        if (existing) {
          await this.db.run(
            'UPDATE note_embeddings SET embedding = ? WHERE rowid = ?',
            [embeddingBuffer, existing.rowid]
          );
          await this.db.run(
            'UPDATE embedding_metadata SET contentHash = ?, mtime = ?, updated = ?, model = ?, dimension = ? WHERE rowid = ?',
            [contentHash, fileMtime, now, modelInfo.id, modelInfo.dimensions, existing.rowid]
          );
        } else {
          await this.db.run('INSERT INTO note_embeddings(embedding) VALUES (?)', [embeddingBuffer]);
          const result = await this.db.queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
          const rowid = result?.id ?? 0;
          await this.db.run(
            `INSERT INTO embedding_metadata(rowid, notePath, model, dimension, contentHash, mtime, created, updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [rowid, notePath, modelInfo.id, modelInfo.dimensions, contentHash, fileMtime, now, now]
          );
        }

        if (config.blockIndexingEnabled && !config.blockIndexStale) {
          await this.embedNoteBlocks(notePath, rawContent, file.basename);
        }
      } catch (error) {
        console.error(`[NoteEmbeddingService] Failed to store embedding for ${notePath}:`, error);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Block embedding upsert
  // ---------------------------------------------------------------------------

  async embedNoteBlocks(notePath: string, content: string, _basename: string): Promise<void> {
    try {
      const chunks = chunkNote(notePath, content);
      const modelInfo = { id: this.runtime.currentModelId, dimensions: this.runtime.dimensions };
      const now = Date.now();

      // Batch-fetch all existing block rows for this note in a single query
      // instead of one queryOne() per chunk (N queries → 1).
      const existingRows = await this.db.query<{ rowid: number; chunkIndex: number; contentHash: string }>(
        'SELECT rowid, chunkIndex, contentHash FROM block_embedding_metadata WHERE notePath = ?',
        [notePath]
      );
      const existingByChunk = new Map(existingRows.map(r => [r.chunkIndex, r]));

      for (const chunk of chunks) {
        const existing = existingByChunk.get(chunk.chunkIndex);

        if (existing && existing.contentHash === chunk.contentHash) {
          continue; // Block content unchanged
        }

        const embedding = await this.runtime.embedDocument(chunk.enrichedText);
        const embeddingBuffer = Buffer.from(embedding.buffer);

        if (existing) {
          await this.db.run(
            'UPDATE block_embeddings SET embedding = ? WHERE rowid = ?',
            [embeddingBuffer, existing.rowid]
          );
          await this.db.run(
            `UPDATE block_embedding_metadata SET heading = ?, charOffset = ?, contentHash = ?,
             contentPreview = ?, model = ?, dimension = ?, updated = ? WHERE rowid = ?`,
            [chunk.heading, chunk.charOffset, chunk.contentHash,
             chunk.contentPreview, modelInfo.id, modelInfo.dimensions, now, existing.rowid]
          );
        } else {
          await this.db.run(
            'INSERT INTO block_embeddings(embedding) VALUES (?)',
            [embeddingBuffer]
          );
          const result = await this.db.queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
          const rowid = result?.id ?? 0;
          await this.db.run(
            `INSERT INTO block_embedding_metadata
             (rowid, notePath, chunkIndex, heading, charOffset, contentHash, contentPreview, model, dimension, created, updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [rowid, notePath, chunk.chunkIndex, chunk.heading, chunk.charOffset,
             chunk.contentHash, chunk.contentPreview, modelInfo.id, modelInfo.dimensions, now, now]
          );
        }
      }

      // Prune stale rows: any rows with chunkIndex >= newChunkCount are orphaned
      await this.db.run(
        `DELETE FROM block_embeddings WHERE rowid IN (
           SELECT rowid FROM block_embedding_metadata
           WHERE notePath = ? AND chunkIndex >= ?
         )`,
        [notePath, chunks.length]
      );
      await this.db.run(
        'DELETE FROM block_embedding_metadata WHERE notePath = ? AND chunkIndex >= ?',
        [notePath, chunks.length]
      );
    } catch (error) {
      console.error(`[NoteEmbeddingService] Failed to embed blocks for ${notePath}:`, error);
    }
  }

  // ---------------------------------------------------------------------------
  // Remove / rename
  // ---------------------------------------------------------------------------

  async removeNote(notePath: string): Promise<void> {
    try {
      const existing = await this.db.queryOne<{ rowid: number }>(
        'SELECT rowid FROM embedding_metadata WHERE notePath = ?',
        [notePath]
      );
      if (existing) {
        await this.db.run('DELETE FROM note_embeddings WHERE rowid = ?', [existing.rowid]);
        await this.db.run('DELETE FROM embedding_metadata WHERE rowid = ?', [existing.rowid]);
      }

      // Remove all block rows for this note in two statements (no N+1 loop)
      await this.db.run(
        `DELETE FROM block_embeddings WHERE rowid IN (
           SELECT rowid FROM block_embedding_metadata WHERE notePath = ?
         )`,
        [notePath]
      );
      await this.db.run('DELETE FROM block_embedding_metadata WHERE notePath = ?', [notePath]);
    } catch (error) {
      console.error(`[NoteEmbeddingService] Failed to remove note ${notePath}:`, error);
    }
  }

  async renameNote(oldPath: string, newPath: string): Promise<void> {
    try {
      await this.db.run(
        'UPDATE embedding_metadata SET notePath = ? WHERE notePath = ?',
        [newPath, oldPath]
      );
      await this.db.run(
        'UPDATE block_embedding_metadata SET notePath = ? WHERE notePath = ?',
        [newPath, oldPath]
      );
    } catch (error) {
      console.error(`[NoteEmbeddingService] Failed to rename ${oldPath} -> ${newPath}:`, error);
    }
  }

  // ---------------------------------------------------------------------------
  // Retrieval contract
  // ---------------------------------------------------------------------------

  /**
   * Find notes similar to the given note path.
   * Uses the stored note embedding as the query vector — does NOT re-embed.
   * Returns raw cosine similarity scores (higher = more similar).
   */
  async findSimilarNotes(notePath: string, limit = 10, minScore = 0): Promise<SimilarNote[]> {
    try {
      const activeModel = this.runtime.currentModelId;
      const sourceEmbed = await this.db.queryOne<{ embedding: Buffer }>(
        `SELECT ne.embedding FROM note_embeddings ne
         JOIN embedding_metadata em ON em.rowid = ne.rowid
         WHERE em.notePath = ? AND em.model = ?`,
        [notePath, activeModel]
      );

      if (!sourceEmbed) return [];

      const results = await this.db.query<{ notePath: string; distance: number }>(`
        SELECT em.notePath, vec_distance_cosine(ne.embedding, ?) as distance
        FROM note_embeddings ne
        JOIN embedding_metadata em ON em.rowid = ne.rowid
        WHERE em.notePath != ? AND em.model = ?
        ORDER BY distance
        LIMIT ?
      `, [sourceEmbed.embedding, notePath, activeModel, limit * 2]);

      return results
        .map(r => ({ notePath: r.notePath, score: 1 - r.distance }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      console.error('[NoteEmbeddingService] findSimilarNotes failed:', error);
      return [];
    }
  }

  /**
   * Find blocks similar to the given note path.
   * Uses the stored note embedding as the query vector against block_embeddings.
   * Available only when block indexing is enabled and not stale.
   */
  async findSimilarBlocks(notePath: string, limit = 10, minScore = 0): Promise<SimilarBlock[]> {
    try {
      const activeModel = this.runtime.currentModelId;
      const sourceEmbed = await this.db.queryOne<{ embedding: Buffer }>(
        `SELECT ne.embedding FROM note_embeddings ne
         JOIN embedding_metadata em ON em.rowid = ne.rowid
         WHERE em.notePath = ? AND em.model = ?`,
        [notePath, activeModel]
      );

      if (!sourceEmbed) {
        return []; // Source note not indexed yet (or indexed under a different model)
      }

      const fetchLimit = Math.min(limit * 3, 300);
      const candidates = await this.db.query<{
        notePath: string;
        chunkIndex: number;
        heading: string | null;
        contentPreview: string;
        distance: number;
      }>(`
        SELECT bm.notePath, bm.chunkIndex, bm.heading, bm.contentPreview,
               vec_distance_cosine(be.embedding, ?) as distance
        FROM block_embeddings be
        JOIN block_embedding_metadata bm ON bm.rowid = be.rowid
        WHERE bm.notePath != ? AND bm.model = ?
        ORDER BY distance
        LIMIT ?
      `, [sourceEmbed.embedding, notePath, activeModel, fetchLimit]);

      // Deduplication: keep best-scoring block per note
      const bestPerNote = new Map<string, typeof candidates[0]>();
      for (const row of candidates) {
        const existing = bestPerNote.get(row.notePath);
        if (!existing || row.distance < existing.distance) {
          bestPerNote.set(row.notePath, row);
        }
      }

      return Array.from(bestPerNote.values())
        .map(r => ({
          notePath: r.notePath,
          chunkIndex: r.chunkIndex,
          heading: r.heading,
          contentPreview: r.contentPreview,
          score: 1 - r.distance,
        }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      console.error('[NoteEmbeddingService] findSimilarBlocks failed:', error);
      return [];
    }
  }

  /**
   * Semantic search for notes by free-text query.
   * Embeds the query at call time using the query role prefix.
   */
  async semanticSearchNotes(query: string, limit = 10, minScore = 0): Promise<SimilarNote[]> {
    try {
      const queryEmbedding = await this.runtime.embedQuery(query);
      const queryBuffer = Buffer.from(queryEmbedding.buffer);

      const results = await this.db.query<{ notePath: string; distance: number }>(`
        SELECT em.notePath, vec_distance_cosine(ne.embedding, ?) as distance
        FROM note_embeddings ne
        JOIN embedding_metadata em ON em.rowid = ne.rowid
        WHERE em.model = ?
        ORDER BY distance
        LIMIT ?
      `, [queryBuffer, this.runtime.currentModelId, limit * 2]);

      return results
        .map(r => ({ notePath: r.notePath, score: 1 - r.distance }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      console.error('[NoteEmbeddingService] semanticSearchNotes failed:', error);
      return [];
    }
  }

  /**
   * Semantic search for blocks by free-text query.
   * Available only when block indexing is enabled and not stale.
   */
  async semanticSearchBlocks(query: string, limit = 10, minScore = 0): Promise<SimilarBlock[]> {
    try {
      const queryEmbedding = await this.runtime.embedQuery(query);
      const queryBuffer = Buffer.from(queryEmbedding.buffer);

      const fetchLimit = Math.min(limit * 3, 300);
      const candidates = await this.db.query<{
        notePath: string;
        chunkIndex: number;
        heading: string | null;
        contentPreview: string;
        distance: number;
      }>(`
        SELECT bm.notePath, bm.chunkIndex, bm.heading, bm.contentPreview,
               vec_distance_cosine(be.embedding, ?) as distance
        FROM block_embeddings be
        JOIN block_embedding_metadata bm ON bm.rowid = be.rowid
        WHERE bm.model = ?
        ORDER BY distance
        LIMIT ?
      `, [queryBuffer, this.runtime.currentModelId, fetchLimit]);

      const bestPerNote = new Map<string, typeof candidates[0]>();
      for (const row of candidates) {
        const existing = bestPerNote.get(row.notePath);
        if (!existing || row.distance < existing.distance) {
          bestPerNote.set(row.notePath, row);
        }
      }

      return Array.from(bestPerNote.values())
        .map(r => ({
          notePath: r.notePath,
          chunkIndex: r.chunkIndex,
          heading: r.heading,
          contentPreview: r.contentPreview,
          score: 1 - r.distance,
        }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      console.error('[NoteEmbeddingService] semanticSearchBlocks failed:', error);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  async isNoteIndexed(notePath: string): Promise<boolean> {
    try {
      const row = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM embedding_metadata WHERE notePath = ?',
        [notePath]
      );
      return (row?.count ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async getIndexedPaths(): Promise<string[]> {
    try {
      const rows = await this.db.query<{ notePath: string }>(
        'SELECT notePath FROM embedding_metadata'
      );
      return rows.map(r => r.notePath);
    } catch {
      return [];
    }
  }

  async getIndexStats(): Promise<{ noteCount: number; blockCount: number }> {
    try {
      const notes = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM embedding_metadata'
      );
      const blocks = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM block_embedding_metadata'
      );
      return {
        noteCount: notes?.count ?? 0,
        blockCount: blocks?.count ?? 0,
      };
    } catch {
      return { noteCount: 0, blockCount: 0 };
    }
  }

  async cleanIndex(): Promise<void> {
    try {
      // Remove block rows for notes that no longer have a note embedding
      await this.db.run(`
        DELETE FROM block_embeddings WHERE rowid IN (
          SELECT bm.rowid FROM block_embedding_metadata bm
          LEFT JOIN embedding_metadata em ON em.notePath = bm.notePath
          WHERE em.rowid IS NULL
        )
      `);
      await this.db.run(`
        DELETE FROM block_embedding_metadata WHERE notePath NOT IN (
          SELECT notePath FROM embedding_metadata
        )
      `);
    } catch (error) {
      console.error('[NoteEmbeddingService] cleanIndex failed:', error);
    }
  }

  async clearAllEmbeddings(): Promise<void> {
    try {
      await this.db.run('DELETE FROM note_embeddings');
      await this.db.run('DELETE FROM embedding_metadata');
      await this.db.run('DELETE FROM block_embeddings');
      await this.db.run('DELETE FROM block_embedding_metadata');
    } catch (error) {
      console.error('[NoteEmbeddingService] clearAllEmbeddings failed:', error);
    }
  }

  /**
   * Drop and recreate the vec0 embedding tables at a new dimension.
   * sqlite-vec float[N] columns cannot be changed via ALTER TABLE — this is the
   * only safe path when switching between models with different output dimensions.
   * All existing embeddings and metadata are wiped (rebuild required after).
   */
  async recreateEmbeddingTables(dimension: number): Promise<void> {
    try {
      await this.db.run('DROP TABLE IF EXISTS note_embeddings');
      await this.db.run(`CREATE VIRTUAL TABLE note_embeddings USING vec0(embedding float[${dimension}])`);
      await this.db.run('DROP TABLE IF EXISTS block_embeddings');
      await this.db.run(`CREATE VIRTUAL TABLE block_embeddings USING vec0(embedding float[${dimension}])`);
      await this.db.run('DELETE FROM embedding_metadata');
      await this.db.run('DELETE FROM block_embedding_metadata');
    } catch (error) {
      console.error('[NoteEmbeddingService] recreateEmbeddingTables failed:', error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // embedding_config helpers
  // ---------------------------------------------------------------------------

  private async loadConfig(): Promise<{
    activeModel: string | null;
    activeDimension: number | null;
    blockIndexingEnabled: boolean;
    blockIndexStale: boolean;
    lastRebuildAt: number | null;
    minIndexLength: number;
  }> {
    if (this.configCache) return this.configCache;
    try {
      const rows = await this.db.query<{ key: string; value: string }>(
        'SELECT key, value FROM embedding_config'
      );
      const map = new Map(rows.map(r => [r.key, r.value]));
      this.configCache = {
        activeModel: map.get('activeModel') ?? null,
        activeDimension: map.has('activeDimension') ? Number(map.get('activeDimension')) : null,
        blockIndexingEnabled: map.get('blockIndexingEnabled') === 'true',
        blockIndexStale: map.get('blockIndexStale') === 'true',
        lastRebuildAt: map.has('lastRebuildAt') ? Number(map.get('lastRebuildAt')) : null,
        minIndexLength: map.has('minIndexLength') ? Number(map.get('minIndexLength')) : 50,
      };
      return this.configCache;
    } catch {
      return {
        activeModel: null,
        activeDimension: null,
        blockIndexingEnabled: false,
        blockIndexStale: false,
        lastRebuildAt: null,
        minIndexLength: 50,
      };
    }
  }

  async getMinIndexLength(): Promise<number> {
    const config = await this.loadConfig();
    return config.minIndexLength;
  }

  async setConfigValue(key: string, value: string): Promise<void> {
    try {
      await this.db.run(
        'INSERT OR REPLACE INTO embedding_config(key, value) VALUES (?, ?)',
        [key, value]
      );
      this.configCache = null; // Invalidate cache so next read reflects the new value
    } catch (error) {
      console.error(`[NoteEmbeddingService] setConfigValue(${key}) failed:`, error);
    }
  }

  /**
   * Get conversations that reference a specific note path.
   * Used by Plan 05 Phase 10 conversation cross-reference.
   */
  async getConversationsReferencingNote(notePath: string): Promise<Array<{
    conversationId: string;
    sessionId: string | null;
    created: number;
  }>> {
    try {
      const rows = await this.db.query<{
        conversationId: string;
        sessionId: string | null;
        created: number;
      }>(`
        SELECT DISTINCT m.conversationId, m.sessionId, m.created
        FROM conversation_embedding_metadata m, json_each(m.referencedNotes)
        WHERE json_each.value = ?
          AND m.referencedNotes IS NOT NULL
        ORDER BY m.created DESC
        LIMIT 10
      `, [notePath]);
      return rows;
    } catch {
      return [];
    }
  }
}
