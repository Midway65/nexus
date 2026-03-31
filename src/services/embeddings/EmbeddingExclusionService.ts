/**
 * Location: src/services/embeddings/EmbeddingExclusionService.ts
 * Purpose: Centralized exclusion logic for the semantic index.
 *
 * shouldIndex(notePath) is the single authoritative gate. All indexing paths
 * (reconciliation, live events, manual refresh) must call this.
 *
 * Exclusion sources (checked in order):
 * 1. Non-markdown files (implicit — only .md files are indexed).
 * 2. Hidden paths starting with "." (e.g., .nexus/, .trash/).
 * 3. Obsidian's built-in excluded files list (app.vault.config or equivalent).
 * 4. User-defined glob patterns from Nexus settings.
 *
 * Exclusion changes take effect immediately on the next shouldIndex() call.
 * The coordinator is responsible for re-evaluating affected paths and removing
 * stale rows when exclusion settings change.
 */

import { App } from 'obsidian';

export class EmbeddingExclusionService {
  constructor(
    private app: App,
    private getExclusionPatterns: () => string[],
  ) {}

  /**
   * Return true if the note at `notePath` should be included in the index.
   * Returns false for any reason the note should be excluded.
   */
  shouldIndex(notePath: string): boolean {
    // Only markdown files
    if (!notePath.endsWith('.md')) return false;

    // Skip hidden paths (e.g., .nexus/, .trash/, .obsidian/)
    if (this.isHiddenPath(notePath)) return false;

    // Check Obsidian's excluded files list
    if (this.isObsidianExcluded(notePath)) return false;

    // Check user-defined exclusion patterns from settings
    const patterns = this.getExclusionPatterns();
    if (patterns.length > 0 && this.matchesAnyPattern(notePath, patterns)) return false;

    return true;
  }

  private isHiddenPath(notePath: string): boolean {
    const parts = notePath.split('/');
    return parts.some(part => part.startsWith('.'));
  }

  private isObsidianExcluded(notePath: string): boolean {
    // Obsidian stores excluded folders in the vault config.
    // The API-safe way to check is via app.metadataCache — files in excluded
    // folders have no cache entry, but we can't rely on that at index time.
    // Use the userIgnoreFilters from the vault config if accessible.
    try {
      const config = (this.app.vault as unknown as { config?: { userIgnoreFilters?: string[] } }).config;
      const filters = config?.userIgnoreFilters;
      if (!filters || filters.length === 0) return false;

      for (const filter of filters) {
        const trimmed = filter.trim();
        if (!trimmed) continue;
        if (notePath.startsWith(trimmed) || notePath.includes('/' + trimmed)) {
          return true;
        }
      }
    } catch {
      // If config is inaccessible, skip this check
    }
    return false;
  }

  private matchesAnyPattern(notePath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      const trimmed = pattern.trim();
      if (!trimmed) continue;

      try {
        // Treat patterns as simple prefix/substring/glob patterns:
        // - If it ends with /, treat as folder prefix
        // - If it contains *, convert to simple glob regex
        // - Otherwise, treat as substring match
        if (trimmed.endsWith('/')) {
          if (notePath.startsWith(trimmed) || notePath.includes('/' + trimmed)) {
            return true;
          }
        } else if (trimmed.includes('*')) {
          const regex = new RegExp(
            '^' + trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
          );
          if (regex.test(notePath)) return true;
        } else {
          if (notePath.includes(trimmed)) return true;
        }
      } catch {
        // Invalid pattern — skip
      }
    }
    return false;
  }
}
