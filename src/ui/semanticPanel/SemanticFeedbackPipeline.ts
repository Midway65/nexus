/**
 * Location: src/ui/semanticPanel/SemanticFeedbackPipeline.ts
 * Purpose: Scoring/filtering pipeline for semantic panel results.
 * Applies pin/hide filtering, cross-note feedback reranking, and contextual score boosts.
 *
 * Used by: SemanticPanelView (called from refresh())
 * Dependencies: SemanticFeedbackService, ConnectionsSettings, Obsidian App (vault/metadataCache reads)
 */

import { App, TFile } from 'obsidian';
import type { SemanticFeedbackService } from './SemanticFeedbackService';
import type { ConnectionsSettings } from './ConnectionsSettings';
import type { RowResult } from './SemanticResultRow';
import type { PanelMode } from './SemanticPanelTypes';

export interface FeedbackPipelineResult {
  results: RowResult[];
  pinnedSet: Set<string>;
}

export class SemanticFeedbackPipeline {
  constructor(
    private app: App,
    private getFeedbackService: () => SemanticFeedbackService | null,
    private getConnectionsSettings: () => Partial<ConnectionsSettings>,
    private getActivePath: () => string | null,
  ) {}

  async apply(results: RowResult[], panelMode: PanelMode): Promise<FeedbackPipelineResult> {
    const feedbackService = this.getFeedbackService();
    const activeNotePath = this.getActivePath();

    if (!feedbackService || !activeNotePath || panelMode !== 'browse') {
      return { results, pinnedSet: new Set() };
    }

    try {
      const [pinned, hidden] = await Promise.all([
        feedbackService.getPinned(activeNotePath),
        feedbackService.getHidden(activeNotePath),
      ]);

      // 1. Filter hidden
      const visible = results.filter(r => !hidden.has(r.notePath));

      // 2. Normalize raw cosine scores before any boosts
      const normalized = this.normalizeScores(visible);

      // 3. Apply global feedback re-ranking (pins/hides from other source notes)
      const cs = this.getConnectionsSettings();
      const reranked = cs.feedback_scoring !== false
        ? await this.applyFeedbackReranking(normalized, activeNotePath, cs, feedbackService)
        : normalized;

      // 4. Apply contextual score boosts
      const boosted = this.applyScoreBoosts(reranked, pinned, activeNotePath);

      // 5. Sort by score desc; hard-partition pinned to top
      boosted.sort((a, b) => b.score - a.score);
      const pinnedResults = boosted.filter(r => pinned.has(r.notePath));
      const normalResults = boosted.filter(r => !pinned.has(r.notePath));

      return {
        results: [...pinnedResults, ...normalResults],
        pinnedSet: pinned,
      };
    } catch {
      return { results, pinnedSet: new Set() };
    }
  }

  private normalizeScores(results: RowResult[]): RowResult[] {
    if (results.length === 0) return results;
    const maxScore = Math.max(...results.map(r => r.score));
    if (maxScore > 0 && maxScore < 0.5) {
      const scale = 1 / maxScore;
      return results.map(r => ({ ...r, score: Math.min(r.score * scale, 1) }));
    }
    return results;
  }

  /**
   * Adjust scores using cross-note feedback signal.
   * For each result, counts how many OTHER source notes have pinned or hidden it.
   * Pins → small boost; hides → small penalty.
   */
  private async applyFeedbackReranking(
    results: RowResult[],
    activeNotePath: string,
    cs: Partial<ConnectionsSettings>,
    feedbackService: SemanticFeedbackService,
  ): Promise<RowResult[]> {
    if (results.length === 0) return results;
    try {
      const pinWeight = cs.feedback_pin_weight ?? 0.03;
      const hideWeight = cs.feedback_hide_weight ?? 0.03;
      const targetPaths = results.map(r => r.notePath);
      const counts = await feedbackService.getGlobalFeedbackCounts(targetPaths, activeNotePath);
      if (counts.size === 0) return results;

      return results.map(r => {
        const fb = counts.get(r.notePath);
        if (!fb) return r;
        const delta = (fb.pins * pinWeight) - (fb.hides * hideWeight);
        if (delta === 0) return r;
        return { ...r, score: Math.max(0, Math.min(1, r.score + delta)) };
      });
    } catch {
      return results;
    }
  }

  private applyScoreBoosts(
    results: RowResult[],
    pinned: Set<string>,
    activeNotePath: string,
  ): RowResult[] {
    const cs = this.getConnectionsSettings();
    const doFrontmatter = cs.frontmatter_scoring !== false;
    const doCoCitation = cs.co_citation_scoring !== false;
    const doPathProximity = cs.path_proximity_scoring !== false;

    if (!doFrontmatter && !doCoCitation && !doPathProximity) return results;

    const activeFrontmatter = doFrontmatter ? this.getActiveFrontmatter(activeNotePath) : {};
    const activeOutlinks = doCoCitation ? this.getActiveOutlinks(activeNotePath) : new Set<string>();
    const activeFolder = activeNotePath.includes('/')
      ? activeNotePath.slice(0, activeNotePath.lastIndexOf('/'))
      : '';

    const fmWeight = cs.frontmatter_scoring_weight ?? 0.03;
    const coCiteWeight = cs.co_citation_scoring_weight ?? 0.02;
    const pathWeight = cs.path_proximity_scoring_weight ?? 0.01;

    return results.map(r => {
      if (pinned.has(r.notePath)) return r; // pinned results hard-partitioned, no boost needed

      let boost = 0;

      if (doFrontmatter) {
        const file = this.app.vault.getFileByPath(r.notePath);
        if (file) {
          const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
          const keys = ['tags', 'type', 'status'] as const;
          let matches = 0;
          for (const key of keys) {
            if (activeFrontmatter[key] !== undefined && fm[key] !== undefined) {
              matches++;
            }
          }
          boost += Math.min(matches * fmWeight, fmWeight * 3);
        }
      }

      if (doCoCitation && activeOutlinks.size > 0) {
        const file = this.app.vault.getFileByPath(r.notePath);
        if (file) {
          const links = this.app.metadataCache.getFileCache(file)?.links ?? [];
          const hasShared = links.some(l => activeOutlinks.has(l.link));
          if (hasShared) boost += coCiteWeight;
        }
      }

      if (doPathProximity) {
        const resultFolder = r.notePath.includes('/')
          ? r.notePath.slice(0, r.notePath.lastIndexOf('/'))
          : '';
        if (activeFolder === resultFolder) boost += pathWeight;
      }

      if (boost === 0) return r;
      return { ...r, score: Math.min(r.score + boost, 1) };
    });
  }

  private getActiveFrontmatter(activeNotePath: string): Record<string, unknown> {
    const file = this.app.vault.getFileByPath(activeNotePath);
    if (!(file instanceof TFile)) return {};
    return this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  }

  private getActiveOutlinks(activeNotePath: string): Set<string> {
    const file = this.app.vault.getFileByPath(activeNotePath);
    if (!(file instanceof TFile)) return new Set();
    const links = this.app.metadataCache.getFileCache(file)?.links ?? [];
    return new Set(links.map(l => l.link));
  }
}
