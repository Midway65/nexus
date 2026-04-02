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
  /** Specific note paths that MUST appear in results (picked via file picker). */
  include_paths: string[];
  /** Specific note paths that are hidden from results (picked via file picker). */
  exclude_paths: string[];
  /** Newline-separated path fragments that MUST appear in a result path. Empty = no restriction. */
  include_filter: string;
  /** Newline-separated path fragments that remove a result. Exclude wins over include. */
  exclude_filter: string;
  /** Array of `key` or `key:value` frontmatter matchers. Result kept only if at least one matches. */
  frontmatter_include_rules: string[];
  /** Array of `key` or `key:value` matchers. Result removed if any matches. Exclude wins. */
  frontmatter_exclude_rules: string[];
  /** Remove results that already link TO the current note (inlinks / backlinks). */
  exclude_inlinks: boolean;
  /** Remove results that the current note already links TO (outlinks). */
  exclude_outlinks: boolean;
  /** Hide block results whose chunk is the frontmatter block. Default true. */
  exclude_frontmatter_blocks: boolean;
  /** Boost results sharing frontmatter keys (tags, type, status) with active note. */
  frontmatter_scoring: boolean;
  /** Per-match boost amount for frontmatter scoring (0–0.20). Default 0.03. */
  frontmatter_scoring_weight: number;
  /** Boost results that share outlinks with the active note. */
  co_citation_scoring: boolean;
  /** Flat boost amount for co-citation scoring (0–0.20). Default 0.02. */
  co_citation_scoring_weight: number;
  /** Boost results in the same folder as the active note. */
  path_proximity_scoring: boolean;
  /** Flat boost amount for path proximity scoring (0–0.20). Default 0.01. */
  path_proximity_scoring_weight: number;
  /**
   * Adjust scores based on how other notes have pinned/hidden results across the vault.
   * Pins from other source notes boost a result; hides penalise it.
   */
  feedback_scoring: boolean;
  /** Score boost applied per pin from another source note (0–0.10). Default 0.03. */
  feedback_pin_weight: number;
  /** Score penalty applied per hide from another source note (0–0.10). Default 0.03. */
  feedback_hide_weight: number;
}

export const DEFAULT_CONNECTIONS_SETTINGS: ConnectionsSettings = {
  results_limit: 20,
  connections_view_location: 'right',
  include_paths: [],
  exclude_paths: [],
  include_filter: '',
  exclude_filter: '',
  frontmatter_include_rules: [],
  frontmatter_exclude_rules: [],
  exclude_inlinks: false,
  exclude_outlinks: false,
  exclude_frontmatter_blocks: true,
  frontmatter_scoring: true,
  frontmatter_scoring_weight: 0.03,
  co_citation_scoring: true,
  co_citation_scoring_weight: 0.02,
  path_proximity_scoring: true,
  path_proximity_scoring_weight: 0.01,
  feedback_scoring: true,
  feedback_pin_weight: 0.03,
  feedback_hide_weight: 0.03,
};
