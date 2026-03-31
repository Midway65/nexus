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
  constructor(
    private app: App,
    private db: SQLiteCacheManager,
    private runtime: EmbeddingRuntime,
  ) {}

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

      const content = await this.app.vault.read(file);
      const processedContent = preprocessContent(content);
      if (!processedContent) return;

      const contentHash = hashContent(processedContent);

      const existing = await this.db.queryOne<{ rowid: number; contentHash: string }>(
        'SELECT rowid, contentHash FROM embedding_metadata WHERE notePath = ?',
        [notePath]
      );

      if (existing && existing.contentHash === contentHash) {
        // Note content unchanged — skip re-embedding
        // But still update blocks if block indexing is enabled (block count may change)
        const config = await this.loadConfig();
        if (config.blockIndexingEnabled && !config.blockIndexStale) {
          await this.embedNoteBlocks(notePath, content, file.basename);
        }
        return;
      }

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
          'UPDATE embedding_metadata SET contentHash = ?, updated = ?, model = ?, dimension = ? WHERE rowid = ?',
          [contentHash, now, modelInfo.id, modelInfo.dimensions, existing.rowid]
        );
      } else {
        await this.db.run(
          'INSERT INTO note_embeddings(embedding) VALUES (?)',
          [embeddingBuffer]
        );
        const result = await this.db.queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
        const rowid = result?.id ?? 0;
        await this.db.run(
          `INSERT INTO embedding_metadata(rowid, notePath, model, dimension, contentHash, created, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [rowid, notePath, modelInfo.id, modelInfo.dimensions, contentHash, now, now]
        );
      }

      // Optionally embed blocks
      const config = await this.loadConfig();
      if (config.blockIndexingEnabled && !config.blockIndexStale) {
        await this.embedNoteBlocks(notePath, content, file.basename);
      }
    } catch (error) {
      console.error(`[NoteEmbeddingService] Failed to embed note ${notePath}:`, error);
      throw error;
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

      for (const chunk of chunks) {
        const existing = await this.db.queryOne<{ rowid: number; contentHash: string }>(
          'SELECT rowid, contentHash FROM block_embedding_metadata WHERE notePath = ? AND chunkIndex = ?',
          [notePath, chunk.chunkIndex]
        );

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

      // Remove all block rows for this note
      const blockRows = await this.db.query<{ rowid: number }>(
        'SELECT rowid FROM block_embedding_metadata WHERE notePath = ?',
        [notePath]
      );
      for (const row of blockRows) {
        await this.db.run('DELETE FROM block_embeddings WHERE rowid = ?', [row.rowid]);
      }
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
      const sourceEmbed = await this.db.queryOne<{ embedding: Buffer }>(
        `SELECT ne.embedding FROM note_embeddings ne
         JOIN embedding_metadata em ON em.rowid = ne.rowid
         WHERE em.notePath = ?`,
        [notePath]
      );

      if (!sourceEmbed) return [];

      const results = await this.db.query<{ notePath: string; distance: number }>(`
        SELECT em.notePath, vec_distance_cosine(ne.embedding, ?) as distance
        FROM note_embeddings ne
        JOIN embedding_metadata em ON em.rowid = ne.rowid
        WHERE em.notePath != ?
        ORDER BY distance
        LIMIT ?
      `, [sourceEmbed.embedding, notePath, limit * 2]);

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
      const sourceEmbed = await this.db.queryOne<{ embedding: Buffer }>(
        `SELECT ne.embedding FROM note_embeddings ne
         JOIN embedding_metadata em ON em.rowid = ne.rowid
         WHERE em.notePath = ?`,
        [notePath]
      );

      if (!sourceEmbed) {
        return []; // Source note not indexed yet
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
        WHERE bm.notePath != ?
        ORDER BY distance
        LIMIT ?
      `, [sourceEmbed.embedding, notePath, fetchLimit]);

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
        ORDER BY distance
        LIMIT ?
      `, [queryBuffer, limit * 2]);

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
        ORDER BY distance
        LIMIT ?
      `, [queryBuffer, fetchLimit]);

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

  // ---------------------------------------------------------------------------
  // embedding_config helpers
  // ---------------------------------------------------------------------------

  private async loadConfig(): Promise<{
    activeModel: string | null;
    activeDimension: number | null;
    blockIndexingEnabled: boolean;
    blockIndexStale: boolean;
    lastRebuildAt: number | null;
  }> {
    try {
      const rows = await this.db.query<{ key: string; value: string }>(
        'SELECT key, value FROM embedding_config'
      );
      const map = new Map(rows.map(r => [r.key, r.value]));
      return {
        activeModel: map.get('activeModel') ?? null,
        activeDimension: map.has('activeDimension') ? Number(map.get('activeDimension')) : null,
        blockIndexingEnabled: map.get('blockIndexingEnabled') === 'true',
        blockIndexStale: map.get('blockIndexStale') === 'true',
        lastRebuildAt: map.has('lastRebuildAt') ? Number(map.get('lastRebuildAt')) : null,
      };
    } catch {
      return {
        activeModel: null,
        activeDimension: null,
        blockIndexingEnabled: false,
        blockIndexStale: false,
        lastRebuildAt: null,
      };
    }
  }

  async setConfigValue(key: string, value: string): Promise<void> {
    try {
      await this.db.run(
        'INSERT OR REPLACE INTO embedding_config(key, value) VALUES (?, ?)',
        [key, value]
      );
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
