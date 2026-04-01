/**
 * Location: src/services/embeddings/EmbeddingModelCatalog.ts
 * Purpose: Curated catalog of supported local embedding models.
 *
 * Each model entry defines the Hugging Face model ID, display name, vector
 * dimension, expected quantized download size, role prefixes, and pooling
 * strategy. EmbeddingRuntime consults this catalog to configure inference
 * and EmbeddingPreprocessor for text preparation.
 */

export interface EmbeddingModelEntry {
  /** Hugging Face model ID, e.g. "Xenova/nomic-embed-text-v1.5" */
  id: string;
  /** Human-readable name shown in Embeddings tab */
  displayName: string;
  /** Vector output dimension */
  dimensions: number;
  /** Approximate quantized download size string, e.g. "140 MB" */
  quantizedSize: string;
  /** Short description for the settings UI */
  description: string;
  /** Role prefix to prepend for document indexing (null = no prefix) */
  documentPrefix: string | null;
  /** Role prefix to prepend for query embedding (null = no prefix) */
  queryPrefix: string | null;
  /** Whether this model requires mean pooling (vs. CLS token pooling) */
  requiresMeanPool: boolean;
  /** Whether the iframe should apply normalize: true in the pipeline options */
  normalizeInPipeline: boolean;
  /**
   * URL where the user must accept the model's license before downloading.
   * For models hosted by Xenova/onnx-community this is often the original
   * upstream author's repo page, not the Xenova mirror.
   * Omit for fully open models that require no license acceptance.
   */
  licenseUrl?: string;
}

/** All supported local embedding models (order matters — first is default). */
export const EMBEDDING_MODELS: EmbeddingModelEntry[] = [
  {
    id: 'Xenova/all-MiniLM-L6-v2',
    displayName: 'MiniLM-L6-v2 (Fast)',
    dimensions: 384,
    quantizedSize: '~23 MB',
    description: 'Fast 384-dim model. Good quality, small download. No HuggingFace account needed.',
    documentPrefix: null,
    queryPrefix: null,
    requiresMeanPool: true,
    normalizeInPipeline: true,
  },
  {
    id: 'Xenova/bge-small-en-v1.5',
    displayName: 'BGE Small EN v1.5',
    dimensions: 384,
    quantizedSize: '~25 MB',
    description: 'Fast 384-dim model from BAAI. Good quality for English text. No HuggingFace account needed.',
    documentPrefix: null,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    requiresMeanPool: true,
    normalizeInPipeline: true,
  },
  {
    id: 'Xenova/nomic-embed-text-v1.5',
    displayName: 'Nomic Embed Text v1.5',
    dimensions: 768,
    quantizedSize: '~140 MB',
    description: 'High-quality 768-dim model. Best semantic quality. Requires HuggingFace account, license acceptance, and an access token.',
    documentPrefix: 'search_document: ',
    queryPrefix: 'search_query: ',
    requiresMeanPool: true,
    normalizeInPipeline: true,
    licenseUrl: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5',
  },
];

/** The default model ID used when no model is configured. */
export const DEFAULT_EMBEDDING_MODEL_ID = EMBEDDING_MODELS[0].id;

/**
 * Look up a model entry by its ID.
 * Returns null if not found (unknown / unsupported model).
 */
export function getModelEntry(modelId: string): EmbeddingModelEntry | null {
  return EMBEDDING_MODELS.find(m => m.id === modelId) ?? null;
}

/**
 * Get the dimensions for a model ID, falling back to the default model's
 * dimensions if the model is not in the catalog.
 */
export function getModelDimensions(modelId: string): number {
  return getModelEntry(modelId)?.dimensions ?? EMBEDDING_MODELS[0].dimensions;
}
