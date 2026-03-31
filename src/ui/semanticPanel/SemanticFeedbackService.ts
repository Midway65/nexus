/**
 * Location: src/ui/semanticPanel/SemanticFeedbackService.ts
 * Purpose: CRUD operations for pin/hide feedback stored in semantic_feedback table.
 *
 * Feedback is note-level only in v1: pinning or hiding a block result affects the parent note.
 * Schema v13 must be applied before this service is used.
 */

import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';

export type FeedbackState = 'pinned' | 'hidden';

export interface SemanticFeedbackEntry {
  sourceNotePath: string;
  targetNotePath: string;
  state: FeedbackState;
  createdAt: number;
}

export class SemanticFeedbackService {
  constructor(private db: SQLiteCacheManager) {}

  async setFeedback(
    sourceNotePath: string,
    targetNotePath: string,
    state: FeedbackState,
  ): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO semantic_feedback(sourceNotePath, targetNotePath, state, createdAt)
       VALUES (?, ?, ?, ?)`,
      [sourceNotePath, targetNotePath, state, Date.now()]
    );
  }

  async removeFeedback(
    sourceNotePath: string,
    targetNotePath: string,
    state?: FeedbackState,
  ): Promise<void> {
    if (state) {
      await this.db.run(
        'DELETE FROM semantic_feedback WHERE sourceNotePath = ? AND targetNotePath = ? AND state = ?',
        [sourceNotePath, targetNotePath, state]
      );
    } else {
      // Remove all feedback for this pair (both pinned and hidden)
      await this.db.run(
        'DELETE FROM semantic_feedback WHERE sourceNotePath = ? AND targetNotePath = ?',
        [sourceNotePath, targetNotePath]
      );
    }
  }

  async getFeedback(sourceNotePath: string): Promise<SemanticFeedbackEntry[]> {
    return this.db.query<SemanticFeedbackEntry>(
      'SELECT * FROM semantic_feedback WHERE sourceNotePath = ?',
      [sourceNotePath]
    );
  }

  async getPinned(sourceNotePath: string): Promise<Set<string>> {
    const rows = await this.db.query<{ targetNotePath: string }>(
      "SELECT targetNotePath FROM semantic_feedback WHERE sourceNotePath = ? AND state = 'pinned'",
      [sourceNotePath]
    );
    return new Set(rows.map(r => r.targetNotePath));
  }

  async getHidden(sourceNotePath: string): Promise<Set<string>> {
    const rows = await this.db.query<{ targetNotePath: string }>(
      "SELECT targetNotePath FROM semantic_feedback WHERE sourceNotePath = ? AND state = 'hidden'",
      [sourceNotePath]
    );
    return new Set(rows.map(r => r.targetNotePath));
  }

  async resetAllFeedback(sourceNotePath?: string): Promise<void> {
    if (sourceNotePath) {
      await this.db.run(
        'DELETE FROM semantic_feedback WHERE sourceNotePath = ?',
        [sourceNotePath]
      );
    } else {
      await this.db.run('DELETE FROM semantic_feedback');
    }
  }

  async getState(sourceNotePath: string, targetNotePath: string): Promise<FeedbackState | null> {
    const row = await this.db.queryOne<{ state: FeedbackState }>(
      'SELECT state FROM semantic_feedback WHERE sourceNotePath = ? AND targetNotePath = ? LIMIT 1',
      [sourceNotePath, targetNotePath]
    );
    return row?.state ?? null;
  }
}
