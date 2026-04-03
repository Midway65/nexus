/**
 * Location: src/ui/semanticPanel/SemanticPanelTypes.ts
 * Purpose: Shared types and defaults for the semantic panel.
 *
 * Used by: SemanticPanelView, SemanticFeedbackPipeline, SemanticResultLoader
 */

export type SemanticContextPayload =
  | {
      kind: 'semantic-note';
      path: string;
      title: string;
      /** Title of the source note being analyzed in the panel (for new chat naming). */
      sourceTitle?: string;
      score: number;
      content: string;
    }
  | {
      kind: 'semantic-block';
      path: string;
      title: string;
      /** Title of the source note being analyzed in the panel (for new chat naming). */
      sourceTitle?: string;
      heading?: string;
      chunkIndex: number;
      score: number;
      excerpt: string;
    };

export type PanelMode = 'browse' | 'search';
export type ResultMode = 'notes' | 'blocks';

export interface PanelSettings {
  resultCount: number;
  minScore: number;
  resultMode: ResultMode;
  autoRefresh: boolean;
  showScore: boolean;
  showFullPath: boolean;
}

export const DEFAULT_SETTINGS: PanelSettings = {
  resultCount: 10,
  minScore: 0.70,
  resultMode: 'notes',
  autoRefresh: true,
  showScore: true,
  showFullPath: false,
};
