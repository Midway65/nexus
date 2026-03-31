/**
 * Location: src/services/embeddings/EmbeddingRuntime.ts
 * Purpose: Iframe sandbox lifecycle, model loading, and inference transport.
 *
 * EmbeddingRuntime owns:
 * - The hidden iframe that runs transformers.js in a clean browser context
 * - Model loading/unloading via postMessage
 * - Model download progress reporting
 * - Runtime health state: uninitialized | loading | ready | error | unavailable
 *
 * EmbeddingRuntime delegates to EmbeddingPreprocessor for:
 * - Model-specific text preparation (role prefixes) before sending to iframe
 * - Post-inference output processing (L2 normalization) after receiving results
 *
 * Desktop-only: on mobile, runtime is permanently 'unavailable' and no iframe
 * is created. All callers must handle the unavailable state without throwing.
 *
 * Electron CSP note: The iframe approach works within Obsidian's Electron
 * renderer CSP and is used in production by Smart Connections. If a future
 * Obsidian update tightens the CSP and breaks iframe postMessage, the fallback
 * is to run Transformers.js inference synchronously on the main thread until a
 * better isolation mechanism is available.
 */

import { Platform } from 'obsidian';
import { EmbeddingPreprocessor } from './EmbeddingPreprocessor';
import { getModelEntry, DEFAULT_EMBEDDING_MODEL_ID, type EmbeddingModelEntry } from './EmbeddingModelCatalog';

// Re-export so callers can do: import { EmbeddingRuntime, DEFAULT_EMBEDDING_MODEL_ID } from './EmbeddingRuntime'
export { DEFAULT_EMBEDDING_MODEL_ID };

export type RuntimeHealth = 'uninitialized' | 'loading' | 'ready' | 'error' | 'unavailable';

interface EmbeddingRequest {
  id: number;
  method: 'init' | 'embed' | 'embed_batch' | 'dispose';
  text?: string;
  texts?: string[];
}

interface EmbeddingResponse {
  id: number;
  success: boolean;
  embedding?: number[];
  embeddings?: number[][];
  error?: string;
  ready?: boolean;
  progress?: number;
}

export class EmbeddingRuntime {
  private health: RuntimeHealth = 'uninitialized';
  private errorMessage: string | null = null;
  private modelId: string;
  private modelEntry: EmbeddingModelEntry;

  private iframe: HTMLIFrameElement | null = null;
  private blobUrl: string | null = null;
  private isReady = false;
  private initPromise: Promise<void> | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private pendingRequests = new Map<number, {
    resolve: (value: EmbeddingResponse | void) => void;
    reject: (error: Error) => void;
  }>();
  private requestId = 0;

  /** Called whenever a model download progress event arrives (0–100). */
  onProgress: ((percent: number) => void) | null = null;

  constructor(modelId: string = DEFAULT_EMBEDDING_MODEL_ID) {
    if (!Platform.isDesktop) {
      this.health = 'unavailable';
      this.errorMessage = 'Local embedding models require the desktop app.';
    }
    this.modelId = modelId;
    this.modelEntry = getModelEntry(modelId) ?? getModelEntry(DEFAULT_EMBEDDING_MODEL_ID)!;
  }

  get currentHealth(): RuntimeHealth {
    return this.health;
  }

  get currentModelId(): string {
    return this.modelId;
  }

  get dimensions(): number {
    return this.modelEntry.dimensions;
  }

  get unavailableReason(): string | null {
    return this.errorMessage;
  }

  isRuntimeReady(): boolean {
    return this.health === 'ready';
  }

  /**
   * Initialize the iframe and load the model.
   * Safe to call multiple times — subsequent calls are no-ops if already ready.
   */
  async initialize(): Promise<void> {
    if (this.health === 'unavailable') return;
    if (this.health === 'ready') return;
    if (this.initPromise) return this.initPromise;

    this.health = 'loading';
    this.initPromise = this.doInitialize();

    try {
      await this.initPromise;
      this.health = 'ready';
    } catch (error) {
      this.health = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    const iframeHtml = this.buildIframeHtml();
    const blob = new Blob([iframeHtml], { type: 'text/html' });
    this.blobUrl = URL.createObjectURL(blob);

    this.iframe = document.createElement('iframe');
    this.iframe.className = 'nexus-embedding-iframe-hidden';
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');

    this.messageHandler = (event: MessageEvent) => {
      if (event.source !== this.iframe?.contentWindow) return;
      this.handleMessage(event.data as EmbeddingResponse);
    };
    window.addEventListener('message', this.messageHandler);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('EmbeddingRuntime: initialization timeout (90s)'));
      }, 90000);

      this.pendingRequests.set(-1, {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (err: Error) => { clearTimeout(timeout); reject(err); },
      });

      this.iframe!.src = this.blobUrl!;
      document.body.appendChild(this.iframe!);
    });

    this.isReady = true;
  }

  private handleMessage(data: EmbeddingResponse): void {
    const { id, success, ready, error } = data;

    if (id === -1) {
      const pending = this.pendingRequests.get(-1);
      if (pending) {
        this.pendingRequests.delete(-1);
        if (ready && success) {
          pending.resolve(undefined);
        } else {
          pending.reject(new Error(error ?? 'EmbeddingRuntime: iframe init failed'));
        }
      }
      return;
    }

    // Download progress event
    if (data.progress !== undefined && this.onProgress) {
      this.onProgress(data.progress);
    }

    const pending = this.pendingRequests.get(id);
    if (pending) {
      this.pendingRequests.delete(id);
      if (success) {
        pending.resolve(data);
      } else {
        pending.reject(new Error(error ?? 'EmbeddingRuntime: inference failed'));
      }
    }
  }

  private async sendRequest(request: Omit<EmbeddingRequest, 'id'>): Promise<EmbeddingResponse> {
    if (!this.iframe?.contentWindow) {
      throw new Error('EmbeddingRuntime: iframe not initialized');
    }

    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('EmbeddingRuntime: request timeout'));
        }
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (value) => { clearTimeout(timeoutId); resolve(value as EmbeddingResponse); },
        reject: (err) => { clearTimeout(timeoutId); reject(err); },
      });

      this.iframe!.contentWindow!.postMessage({ id, ...request }, '*');
    });
  }

  /**
   * Embed text for document indexing.
   * Applies model-specific document prefix before sending to iframe.
   * Returns L2-normalized Float32Array.
   */
  async embedDocument(text: string): Promise<Float32Array> {
    await this.ensureReady();
    const prepared = EmbeddingPreprocessor.prepareDocumentText(text, this.modelId);
    const response = await this.sendRequest({ method: 'embed', text: prepared });
    return EmbeddingPreprocessor.postProcess(response.embedding!, this.modelId);
  }

  /**
   * Embed a query string for semantic search.
   * Applies model-specific query prefix before sending to iframe.
   * Returns L2-normalized Float32Array.
   */
  async embedQuery(text: string): Promise<Float32Array> {
    await this.ensureReady();
    const prepared = EmbeddingPreprocessor.prepareQueryText(text, this.modelId);
    const response = await this.sendRequest({ method: 'embed', text: prepared });
    return EmbeddingPreprocessor.postProcess(response.embedding!, this.modelId);
  }

  /**
   * Embed multiple document texts in a batch.
   */
  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    await this.ensureReady();
    const prepared = texts.map(t => EmbeddingPreprocessor.prepareDocumentText(t, this.modelId));
    const response = await this.sendRequest({ method: 'embed_batch', texts: prepared });
    return response.embeddings!.map(e => EmbeddingPreprocessor.postProcess(e, this.modelId));
  }

  private async ensureReady(): Promise<void> {
    if (this.health === 'unavailable') {
      throw new Error(this.errorMessage ?? 'EmbeddingRuntime: unavailable');
    }
    if (this.health !== 'ready') {
      await this.initialize();
    }
  }

  /**
   * Dispose of the iframe and free memory.
   */
  async dispose(): Promise<void> {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }

    if (this.iframe) {
      try {
        await this.sendRequest({ method: 'dispose' });
      } catch {
        // Ignore errors during disposal
      }
      this.iframe.remove();
      this.iframe = null;
    }

    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }

    this.isReady = false;
    this.health = 'uninitialized';
    this.pendingRequests.clear();
  }

  private buildIframeHtml(): string {
    const modelId = this.modelId;
    const normalizeFlag = this.modelEntry.normalizeInPipeline;
    const requiresMeanPool = this.modelEntry.requiresMeanPool;

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script type="module">
    import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

    env.useBrowserCache = true;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.backends.onnx.wasm.numThreads = 1;

    const MODEL_ID = '${modelId}';
    const NORMALIZE = ${normalizeFlag};
    const MEAN_POOL = ${requiresMeanPool};

    let extractor = null;

    async function initModel() {
      extractor = await pipeline('feature-extraction', MODEL_ID, { quantized: true });
    }

    async function embed(text) {
      if (!extractor) throw new Error('Model not initialized');
      const truncated = text.length > 4000 ? text.slice(0, 4000) : text;
      const output = await extractor(truncated, {
        pooling: MEAN_POOL ? 'mean' : 'cls',
        normalize: NORMALIZE
      });
      return Array.from(output.data);
    }

    async function embedBatch(texts) {
      const results = [];
      for (const text of texts) {
        results.push(await embed(text));
      }
      return results;
    }

    window.addEventListener('message', async (event) => {
      const { id, method, text, texts } = event.data;
      try {
        let result;
        switch (method) {
          case 'init':
            await initModel();
            result = { success: true };
            break;
          case 'embed':
            result = { success: true, embedding: await embed(text) };
            break;
          case 'embed_batch':
            result = { success: true, embeddings: await embedBatch(texts) };
            break;
          case 'dispose':
            extractor = null;
            result = { success: true };
            break;
          default:
            result = { success: false, error: 'Unknown method: ' + method };
        }
        parent.postMessage({ id, ...result }, '*');
      } catch (error) {
        parent.postMessage({ id, success: false, error: error.message }, '*');
      }
    });

    initModel()
      .then(() => parent.postMessage({ id: -1, ready: true, success: true }, '*'))
      .catch(err => parent.postMessage({ id: -1, ready: false, success: false, error: err.message }, '*'));
  </script>
</head>
<body></body>
</html>`;
  }
}
