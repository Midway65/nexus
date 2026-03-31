/**
 * Location: src/ui/semanticPanel/ConnectionsSettings.ts
 * Purpose: Settings interface and defaults for the Connections panel (Tier 2 result filters).
 *
 * These settings control which results are shown in the SemanticPanelView AFTER
 * embeddings have been retrieved — no re-indexing required when they change.
 *
 * Tier 1 (ingestion exclusions) lives in MCPSettings.indexingExcludedPatterns and is
 * enforced by EmbeddingExclusionService before notes enter the index.
 */

export interface ConnectionsSettings {
  /** Number of results shown in panel. Default 20. */
  results_limit: number;
  /** Which sidebar the panel opens in. Default 'right'. */
  connections_view_location: 'left' | 'right';
  /** Comma-separated path fragments that MUST appear in a result path. Empty = no restriction. */
  include_filter: string;
  /** Comma-separated path fragments that remove a result. Exclude wins over include. */
  exclude_filter: string;
  /** Newline-delimited `key` or `key:value` frontmatter matchers. Result kept only if matched. */
  frontmatter_filter_include: string;
  /** Newline-delimited matchers. Result removed if matched. Exclude wins. */
  frontmatter_filter_exclude: string;
  /** Remove results that already link TO the current note (inlinks / backlinks). */
  exclude_inlinks: boolean;
  /** Remove results that the current note already links TO (outlinks). */
  exclude_outlinks: boolean;
  /** Hide block results whose chunk is the frontmatter block. Default true. */
  exclude_frontmatter_blocks: boolean;
}

export const DEFAULT_CONNECTIONS_SETTINGS: ConnectionsSettings = {
  results_limit: 20,
  connections_view_location: 'right',
  include_filter: '',
  exclude_filter: '',
  frontmatter_filter_include: '',
  frontmatter_filter_exclude: '',
  exclude_inlinks: false,
  exclude_outlinks: false,
  exclude_frontmatter_blocks: true,
};
