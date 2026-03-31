/**
 * Location: src/services/embeddings/EmbeddingPreprocessor.ts
 * Purpose: Model-specific text preparation and embedding post-processing.
 *
 * Stateless — takes a model ID + text/vector and returns the prepared form.
 * Called by EmbeddingRuntime only; never called directly by other services.
 *
 * Responsibilities:
 * - Apply role prefixes per model family (search_document:, passage:, etc.)
 * - L2 normalize output vectors when normalizeInPipeline is false
 * - Provide separate prepare paths for document vs. query embedding
 */

import { getModelEntry, DEFAULT_EMBEDDING_MODEL_ID } from './EmbeddingModelCatalog';

export class EmbeddingPreprocessor {
  /**
   * Prepare text for document (index-time) embedding.
   * Applies the model-specific document role prefix.
   */
  static prepareDocumentText(text: string, modelId: string): string {
    const entry = getModelEntry(modelId) ?? getModelEntry(DEFAULT_EMBEDDING_MODEL_ID)!;
    if (entry.documentPrefix) {
      return entry.documentPrefix + text;
    }
    return text;
  }

  /**
   * Prepare text for query (search-time) embedding.
   * Applies the model-specific query role prefix.
   */
  static prepareQueryText(text: string, modelId: string): string {
    const entry = getModelEntry(modelId) ?? getModelEntry(DEFAULT_EMBEDDING_MODEL_ID)!;
    if (entry.queryPrefix) {
      return entry.queryPrefix + text;
    }
    return text;
  }

  /**
   * Post-process a raw embedding: L2 normalize if the pipeline does not do so.
   * In practice, all catalog models use normalizeInPipeline: true so this is
   * a safety net for future models that do not.
   *
   * @param raw - Raw embedding as a number array from the iframe
   * @param modelId - Active model ID
   * @returns L2-normalized Float32Array
   */
  static postProcess(raw: number[], modelId: string): Float32Array {
    const entry = getModelEntry(modelId) ?? getModelEntry(DEFAULT_EMBEDDING_MODEL_ID)!;
    const vec = new Float32Array(raw);

    if (entry.normalizeInPipeline) {
      // Pipeline already normalized — just wrap
      return vec;
    }

    return EmbeddingPreprocessor.l2Normalize(vec);
  }

  /**
   * L2-normalize a Float32Array in-place and return it.
   */
  static l2Normalize(vec: Float32Array): Float32Array {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);

    if (norm === 0) return vec;

    for (let i = 0; i < vec.length; i++) {
      vec[i] = vec[i] / norm;
    }
    return vec;
  }

  /**
   * Compute cosine similarity between two L2-normalized vectors.
   * Both vectors must be pre-normalized for this to equal the dot product.
   * Returns a value in [−1, 1].
   */
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }
}
