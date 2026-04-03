/**
 * Location: src/ui/semanticPanel/SemanticResultLoader.ts
 * Purpose: Pure data-loading functions for the semantic panel.
 * Delegates to ConnectionsService when available, falls back to NoteEmbeddingService directly.
 *
 * Used by: SemanticPanelView (called from refresh() / loadBrowseResults / loadSearchResults)
 * Dependencies: NoteEmbeddingService, ConnectionsService
 */

import type { NoteEmbeddingService, SimilarNote, SimilarBlock } from '../../services/embeddings/NoteEmbeddingService';
import type { ConnectionsService } from './ConnectionsService';
import type { RowResult } from './SemanticResultRow';
import type { ResultMode } from './SemanticPanelTypes';

// ---- result mappers ----

export function noteToRow(n: SimilarNote): RowResult {
  const basename = n.notePath.split('/').pop()?.replace(/\.md$/, '') ?? n.notePath;
  return {
    kind: 'note',
    notePath: n.notePath,
    title: basename,
    score: n.score,
  };
}

export function blockToRow(b: SimilarBlock): RowResult {
  const basename = b.notePath.split('/').pop()?.replace(/\.md$/, '') ?? b.notePath;
  return {
    kind: 'block',
    notePath: b.notePath,
    title: basename,
    score: b.score,
    heading: b.heading,
    chunkIndex: b.chunkIndex,
    contentPreview: b.contentPreview,
  };
}

// ---- loaders ----

export async function loadBrowseResults(
  notePath: string,
  service: NoteEmbeddingService,
  connectionsService: ConnectionsService | null,
  opts: { limit: number; minScore: number },
  resultMode: ResultMode,
): Promise<RowResult[]> {
  if (resultMode === 'blocks') {
    const raw = connectionsService
      ? await connectionsService.getBlockConnectionsForFile(notePath, opts)
      : await service.findSimilarBlocks(notePath, opts.limit, opts.minScore);
    return raw.map(blockToRow);
  } else {
    const raw = connectionsService
      ? await connectionsService.getConnectionsForFile(notePath, opts)
      : await service.findSimilarNotes(notePath, opts.limit, opts.minScore);
    return raw.map(noteToRow);
  }
}

export async function loadSearchResults(
  query: string,
  service: NoteEmbeddingService,
  connectionsService: ConnectionsService | null,
  opts: { limit: number; minScore: number },
  resultMode: ResultMode,
): Promise<RowResult[]> {
  if (resultMode === 'blocks') {
    const raw = connectionsService
      ? await connectionsService.semanticSearchBlocks(query, opts)
      : await service.semanticSearchBlocks(query, opts.limit, opts.minScore);
    return raw.map(blockToRow);
  } else {
    const raw = connectionsService
      ? await connectionsService.semanticSearch(query, opts)
      : await service.semanticSearchNotes(query, opts.limit, opts.minScore);
    return raw.map(noteToRow);
  }
}
