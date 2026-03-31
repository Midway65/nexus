/**
 * Location: src/agents/searchManager/tools/findRelated.ts
 * Purpose: MCP tool for semantic retrieval — notes or blocks similar to a given note or query.
 *
 * Aligned with Plan 04 Phase 16 retrieval contract and Plan 05 panel behavior.
 *
 * Input:
 *   notePath  — find notes/blocks similar to this vault-relative path (mutually exclusive with query)
 *   query     — semantic free-text search (mutually exclusive with notePath)
 *   mode      — 'notes' (default) | 'blocks'
 *   limit     — max results (default 10)
 *   minScore  — raw cosine threshold 0–1 (default 0)
 *
 * Output:
 *   { success, mode, total, results[] }
 */

import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { CommonParameters } from '../../../types/mcp/AgentTypes';
import type { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { NoteEmbeddingService } from '../../../services/embeddings/NoteEmbeddingService';
import { getNexusPlugin } from '../../../utils/pluginLocator';

interface FindRelatedParams extends CommonParameters {
  notePath?: string;
  query?: string;
  mode?: 'notes' | 'blocks';
  limit?: number;
  minScore?: number;
}

interface FindRelatedResultItem {
  path: string;
  title: string;
  score: number;
  preview?: string;
  heading?: string;
  chunkIndex?: number;
}

interface FindRelatedResult {
  success: boolean;
  mode: 'notes' | 'blocks';
  total: number;
  results: FindRelatedResultItem[];
  error?: string;
}

export class FindRelatedTool extends BaseTool<FindRelatedParams, FindRelatedResult> {
  constructor(private app: App) {
    super(
      'findRelated',
      'Find Related',
      'Find semantically related notes or blocks. Provide either notePath (to find what is related to a specific note) or query (free-text semantic search). Mutually exclusive. Mode "notes" always available; "blocks" requires block indexing to be enabled.',
      '1.0.0'
    );
  }

  async execute(params: FindRelatedParams): Promise<FindRelatedResult> {
    const { notePath, query, mode = 'notes', limit = 10, minScore = 0 } = params;

    if (!notePath && !query) {
      return { success: false, mode, total: 0, results: [], error: 'Provide either notePath or query.' };
    }
    if (notePath && query) {
      return { success: false, mode, total: 0, results: [], error: 'notePath and query are mutually exclusive — provide one, not both.' };
    }

    const service = this.getNoteEmbeddingService();
    if (!service) {
      return { success: false, mode, total: 0, results: [], error: 'Semantic index is not available.' };
    }

    // Validate block mode availability
    if (mode === 'blocks') {
      try {
        const state = await service.getIndexState();
        if (!state.blockIndexingEnabled) {
          return { success: false, mode, total: 0, results: [], error: 'Block indexing is disabled. Enable it in Embeddings settings.' };
        }
        if (state.blockIndexStale) {
          return { success: false, mode, total: 0, results: [], error: 'Block index is stale. Rebuild the index in Embeddings settings.' };
        }
      } catch {
        return { success: false, mode, total: 0, results: [], error: 'Could not read embedding index state.' };
      }
    }

    try {
      if (mode === 'blocks') {
        const raw = notePath
          ? await service.findSimilarBlocks(notePath, limit, minScore)
          : await service.semanticSearchBlocks(query!, limit, minScore);

        const results: FindRelatedResultItem[] = raw.map(b => ({
          path: b.notePath,
          title: b.notePath.split('/').pop()?.replace(/\.md$/, '') ?? b.notePath,
          score: b.score,
          preview: b.contentPreview,
          heading: b.heading ?? undefined,
          chunkIndex: b.chunkIndex,
        }));
        return { success: true, mode: 'blocks', total: results.length, results };
      } else {
        const raw = notePath
          ? await service.findSimilarNotes(notePath, limit, minScore)
          : await service.semanticSearchNotes(query!, limit, minScore);

        const results: FindRelatedResultItem[] = raw.map(n => ({
          path: n.notePath,
          title: n.notePath.split('/').pop()?.replace(/\.md$/, '') ?? n.notePath,
          score: n.score,
        }));
        return { success: true, mode: 'notes', total: results.length, results };
      }
    } catch (error) {
      return { success: false, mode, total: 0, results: [], error: String(error) };
    }
  }

  private getNoteEmbeddingService(): NoteEmbeddingService | null {
    try {
      const plugin = getNexusPlugin(this.app) as unknown as {
        embeddingManager?: { getNoteEmbeddingService?(): NoteEmbeddingService };
      };
      return plugin?.embeddingManager?.getNoteEmbeddingService?.() ?? null;
    } catch {
      return null;
    }
  }

  getParameterSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        notePath: {
          type: 'string',
          description: 'Vault-relative path of the source note (mutually exclusive with query).',
        },
        query: {
          type: 'string',
          description: 'Free-text semantic search query (mutually exclusive with notePath).',
        },
        mode: {
          type: 'string',
          enum: ['notes', 'blocks'],
          description: '"notes" (default) or "blocks". Block mode requires block indexing to be enabled.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10).',
        },
        minScore: {
          type: 'number',
          description: 'Minimum raw cosine similarity threshold 0–1 (default: 0). Results below this score are excluded.',
        },
      },
      anyOf: [
        { required: ['notePath'] },
        { required: ['query'] },
      ],
    };
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        mode: { type: 'string', enum: ['notes', 'blocks'] },
        total: { type: 'number' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              title: { type: 'string' },
              score: { type: 'number' },
              preview: { type: 'string' },
              heading: { type: 'string' },
              chunkIndex: { type: 'number' },
            },
            required: ['path', 'title', 'score'],
          },
        },
        error: { type: 'string' },
      },
      required: ['success', 'mode', 'total', 'results'],
    };
  }
}
