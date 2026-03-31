/**
 * Location: src/ui/semanticPanel/ConnectionsService.ts
 * Purpose: Thin wrapper over NoteEmbeddingService that applies Tier 2 result filters
 * sourced from ConnectionsSettings in MCPSettings.
 *
 * This is the only net-new service class needed for SC-style filtering — it does not
 * replicate SC's SmartEnv infrastructure. All heavy lifting (embedding, KNN) is done
 * by NoteEmbeddingService; this class only filters the returned results.
 *
 * Filter precedence: exclude wins over include for both path-fragment and frontmatter.
 */

import type { App } from 'obsidian';
import type { NoteEmbeddingService, SimilarNote, SimilarBlock } from '../../services/embeddings/NoteEmbeddingService';
import { DEFAULT_CONNECTIONS_SETTINGS } from './ConnectionsSettings';
import type { ConnectionsSettings } from './ConnectionsSettings';

export interface ConnectionsOptions {
  limit?: number;
  minScore?: number;
}

export class ConnectionsService {
  constructor(
    private app: App,
    private noteEmbeddingService: NoteEmbeddingService,
    private getSettings: () => Partial<ConnectionsSettings>,
  ) {}

  private resolvedSettings(): ConnectionsSettings {
    return { ...DEFAULT_CONNECTIONS_SETTINGS, ...this.getSettings() };
  }

  /**
   * Get filtered note connections for the active file.
   * Fetches 2× the limit to absorb filter losses, then trims to limit.
   */
  async getConnectionsForFile(
    notePath: string,
    opts: ConnectionsOptions = {},
  ): Promise<SimilarNote[]> {
    const settings = this.resolvedSettings();
    const limit = opts.limit ?? settings.results_limit;
    const raw = await this.noteEmbeddingService.findSimilarNotes(notePath, limit * 2, opts.minScore ?? 0);
    return this.applyTier2Filters(raw, notePath, settings).slice(0, limit);
  }

  /**
   * Get filtered block connections for the active file.
   */
  async getBlockConnectionsForFile(
    notePath: string,
    opts: ConnectionsOptions = {},
  ): Promise<SimilarBlock[]> {
    const settings = this.resolvedSettings();
    const limit = opts.limit ?? settings.results_limit;
    const raw = await this.noteEmbeddingService.findSimilarBlocks(notePath, limit * 2, opts.minScore ?? 0);
    return this.applyTier2FiltersOnBlocks(raw, notePath, settings).slice(0, limit);
  }

  /**
   * Free-text semantic search with Tier 2 filters applied.
   * No active-note path available, so inlink/outlink filters are skipped.
   */
  async semanticSearch(
    query: string,
    opts: ConnectionsOptions = {},
  ): Promise<SimilarNote[]> {
    const settings = this.resolvedSettings();
    const limit = opts.limit ?? settings.results_limit;
    const raw = await this.noteEmbeddingService.semanticSearchNotes(query, limit * 2, opts.minScore ?? 0);
    return this.applyTier2Filters(raw, null, settings).slice(0, limit);
  }

  /**
   * Free-text semantic block search with Tier 2 filters applied.
   */
  async semanticSearchBlocks(
    query: string,
    opts: ConnectionsOptions = {},
  ): Promise<SimilarBlock[]> {
    const settings = this.resolvedSettings();
    const limit = opts.limit ?? settings.results_limit;
    const raw = await this.noteEmbeddingService.semanticSearchBlocks(query, limit * 2, opts.minScore ?? 0);
    return this.applyTier2FiltersOnBlocks(raw, null, settings).slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Tier 2 filter engine
  // ---------------------------------------------------------------------------

  private applyTier2Filters(
    results: SimilarNote[],
    activeNotePath: string | null,
    settings: ConnectionsSettings,
  ): SimilarNote[] {
    let filtered = results;

    // Path-fragment filters: exclude wins over include
    const excludeFragments = parseCommaSeparated(settings.exclude_filter);
    const includeFragments = parseCommaSeparated(settings.include_filter);

    if (excludeFragments.length > 0) {
      filtered = filtered.filter(r => !excludeFragments.some(f => r.notePath.includes(f)));
    }
    if (includeFragments.length > 0) {
      filtered = filtered.filter(r => includeFragments.some(f => r.notePath.includes(f)));
    }

    // Inlink / outlink exclusion using Obsidian metadata cache
    if (activeNotePath && (settings.exclude_inlinks || settings.exclude_outlinks)) {
      const { TFile } = require('obsidian') as typeof import('obsidian');
      const activeFile = this.app.vault.getAbstractFileByPath(activeNotePath);
      if (activeFile instanceof TFile) {
        if (settings.exclude_inlinks) {
          const cache = this.app.metadataCache as unknown as {
            getBacklinksForFile(file: import('obsidian').TFile): { data: Record<string, unknown> } | undefined;
          };
          const backlinkData = cache.getBacklinksForFile(activeFile);
          const backlinkSet = new Set(Object.keys(backlinkData?.data ?? {}));
          filtered = filtered.filter(r => !backlinkSet.has(r.notePath));
        }
        if (settings.exclude_outlinks) {
          const fileCache = this.app.metadataCache.getFileCache(activeFile);
          const outlinks = new Set(
            (fileCache?.links ?? []).map(l => l.link)
          );
          filtered = filtered.filter(r => !outlinks.has(r.notePath.replace(/\.md$/, '')));
        }
      }
    }

    // Frontmatter filters
    if (settings.frontmatter_filter_include || settings.frontmatter_filter_exclude) {
      const { TFile } = require('obsidian') as typeof import('obsidian');
      const includeMatchers = parseFrontmatterFilterLines(settings.frontmatter_filter_include);
      const excludeMatchers = parseFrontmatterFilterLines(settings.frontmatter_filter_exclude);
      filtered = filtered.filter(r => {
        const file = this.app.vault.getAbstractFileByPath(r.notePath);
        if (!(file instanceof TFile)) return true;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
        if (excludeMatchers.length > 0 && matchesFrontmatterFilters(fm, excludeMatchers)) return false;
        if (includeMatchers.length > 0 && !matchesFrontmatterFilters(fm, includeMatchers)) return false;
        return true;
      });
    }

    return filtered;
  }

  private applyTier2FiltersOnBlocks(
    results: SimilarBlock[],
    activeNotePath: string | null,
    settings: ConnectionsSettings,
  ): SimilarBlock[] {
    // Project blocks to SimilarNote shape, apply note-level filters, then select kept paths
    const asNotes: SimilarNote[] = results.map(r => ({ notePath: r.notePath, score: r.score }));
    const filtered = this.applyTier2Filters(asNotes, activeNotePath, settings);
    const keptPaths = new Set(filtered.map(r => r.notePath));
    return results.filter(r => keptPaths.has(r.notePath));
  }
}

// ---------------------------------------------------------------------------
// Pure filter helpers — no external dependencies, easily unit-testable
// ---------------------------------------------------------------------------

/** Split comma-separated path fragments and trim whitespace. Empty/undefined → []. */
export function parseCommaSeparated(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Parse newline-delimited frontmatter filter lines.
 * Each line is `key` or `key:value`. Returns parsed matchers.
 * Vendored from smart-entities logic — ~20 lines, no external deps.
 */
export function parseFrontmatterFilterLines(
  lines: string | undefined,
): Array<{ key: string; value: string | null }> {
  if (!lines?.trim()) return [];
  return lines
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const idx = l.indexOf(':');
      if (idx === -1) return { key: l.toLowerCase(), value: null };
      return {
        key: l.slice(0, idx).trim().toLowerCase(),
        value: l.slice(idx + 1).trim().toLowerCase(),
      };
    });
}

/** Return true if frontmatter satisfies at least one matcher (key-only or key:value). */
export function matchesFrontmatterFilters(
  frontmatter: Record<string, unknown>,
  matchers: Array<{ key: string; value: string | null }>,
): boolean {
  for (const m of matchers) {
    const fmVal = frontmatter[m.key];
    if (fmVal === undefined) continue;
    if (m.value === null) return true; // key-only match
    if (String(fmVal).toLowerCase() === m.value) return true;
  }
  return false;
}
