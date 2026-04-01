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

import { Platform, App, requestUrl } from 'obsidian';
import { EmbeddingPreprocessor } from './EmbeddingPreprocessor';
import { getModelEntry, DEFAULT_EMBEDDING_MODEL_ID, type EmbeddingModelEntry } from './EmbeddingModelCatalog';

/**
 * Files required from HuggingFace for a quantized feature-extraction pipeline.
 * These are downloaded via requestUrl (bypasses Electron CSP) and cached in
 * .nexus/models/{modelId}/ so the iframe never needs to fetch from huggingface.co.
 */
const EMBEDDING_MODEL_FILES = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_quantized.onnx',
];

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
  private app: App | null = null;
  private hfToken: string | null = null;

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

  constructor(modelId: string = DEFAULT_EMBEDDING_MODEL_ID, app: App | null = null, hfToken: string | null = null) {
    if (!Platform.isDesktop) {
      this.health = 'unavailable';
      this.errorMessage = 'Local embedding models require the desktop app.';
    }
    this.modelId = modelId;
    this.modelEntry = getModelEntry(modelId) ?? getModelEntry(DEFAULT_EMBEDDING_MODEL_ID)!;
    this.app = app;
    this.hfToken = hfToken;
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
    if (this.health === 'error') {
      // Reset so the caller can retry (e.g. user clicks Refresh after a failed startup).
      this.health = 'uninitialized';
      this.errorMessage = null;
    }
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
    // Download model files via requestUrl (bypasses Electron iframe CSP restrictions).
    // Files are cached in .nexus/models/ so subsequent loads are instant.
    if (this.app) {
      await this.ensureModelDownloaded();
    }

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
    // Handle model file fetch requests from the iframe's fetch proxy
    const msg = data as unknown as Record<string, unknown>;
    if (msg['method'] === 'fetchModelFile') {
      this.serveModelFile(msg['reqId'] as number, msg['url'] as string);
      return;
    }

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

  // ============================================================
  // Model file download (via requestUrl) + iframe fetch proxy
  // ============================================================

  /**
   * Download all model files using Obsidian's requestUrl API, which runs in
   * the Electron main process and is not subject to renderer CSP restrictions.
   * Files are cached in .nexus/models/{modelId}/ — already-present files are skipped.
   */
  private async ensureModelDownloaded(): Promise<void> {
    const adapter = this.app!.vault.adapter;
    const baseDir = '.nexus/models';
    const modelDir = `${baseDir}/${this.modelId}`;

    await this.ensureDir(baseDir);
    await this.ensureDir(modelDir);
    await this.ensureDir(`${modelDir}/onnx`);

    for (let i = 0; i < EMBEDDING_MODEL_FILES.length; i++) {
      const file = EMBEDDING_MODEL_FILES[i];
      const localPath = `${modelDir}/${file}`;

      if (!(await adapter.exists(localPath))) {
        const url = `https://huggingface.co/${this.modelId}/resolve/main/${file}`;
        const headers: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/octet-stream, application/json, */*',
        };
        if (this.hfToken) {
          headers['Authorization'] = `Bearer ${this.hfToken}`;
        }
        const response = await requestUrl({ url, method: 'GET', throw: false, headers });
        if (response.status === 401) {
          throw new Error(
            `HuggingFace token invalid or expired for ${this.modelId}. ` +
            `Create a new read token at huggingface.co/settings/tokens and paste it in Embeddings settings.`
          );
        }
        if (response.status === 403 || response.status === 404) {
          const licenseUrl = this.modelEntry.licenseUrl ?? `https://huggingface.co/${this.modelId}`;
          throw new Error(
            `Cannot download ${this.modelId} (HTTP ${response.status}). ` +
            `Step 1: Accept the license at ${licenseUrl} while logged in to HuggingFace. ` +
            `Step 2: Create a read token at huggingface.co/settings/tokens. ` +
            `Step 3: Paste the token in Embeddings settings and retry. ` +
            `Or switch to MiniLM-L6-v2 which has no restrictions.`
          );
        }
        if (response.status !== 200) {
          let detail = '';
          try { detail = ` — ${response.text.slice(0, 200)}`; } catch { /* ignore */ }
          throw new Error(`Failed to download ${file}: HTTP ${response.status}${detail}`);
        }
        await adapter.writeBinary(localPath, response.arrayBuffer);
      }

      if (this.onProgress) {
        this.onProgress(Math.round(((i + 1) / EMBEDDING_MODEL_FILES.length) * 100));
      }
    }
  }

  private async ensureDir(path: string): Promise<void> {
    if (!(await this.app!.vault.adapter.exists(path))) {
      await this.app!.vault.adapter.mkdir(path);
    }
  }

  /**
   * Called when the iframe's fetch proxy sends a 'fetchModelFile' message.
   * Reads the locally-cached file and sends it back as a transferable ArrayBuffer.
   */
  private serveModelFile(reqId: number, url: string): void {
    const send = (msg: Record<string, unknown>, transfer?: Transferable[]) => {
      this.iframe?.contentWindow?.postMessage(msg, '*', transfer);
    };

    // Strip query string before path matching (transformers.js may append ?download=true etc.)
    const urlWithoutQuery = url.split('?')[0];

    // Map https://huggingface.co/{owner}/{repo}/resolve/main/{path}
    // → .nexus/models/{owner}/{repo}/{path}
    const match = urlWithoutQuery.match(/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\/(.+)/);
    if (!match || !this.app) {
      send({ method: 'modelFileResponse', reqId, status: 404, contentType: 'text/plain', error: `Cannot serve: ${url}` });
      return;
    }

    const localPath = `.nexus/models/${match[1]}/${match[2]}`;
    const contentType = url.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream';

    this.app.vault.adapter.readBinary(localPath).then(buffer => {
      send({ method: 'modelFileResponse', reqId, status: 200, contentType, data: buffer }, [buffer]);
    }).catch(() => {
      send({ method: 'modelFileResponse', reqId, status: 404, contentType: 'text/plain', error: `Not found: ${localPath}` });
    });
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
    // When app is present, model files are pre-downloaded and served via postMessage.
    const useLocalProxy = this.app !== null;

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script>
    // Force pure browser mode so transformers.js uses fetch() not fs.readFile().
    try {
      if (typeof process !== 'undefined' && process.versions) {
        process.versions = Object.assign({}, process.versions, { node: undefined });
      }
    } catch (e) {}
  <\/script>${useLocalProxy ? `
  <script>
    // Fetch proxy: intercept huggingface.co requests and serve pre-downloaded
    // files from the parent via postMessage (avoids Electron iframe CSP block).
    (function() {
      var _origFetch = window.fetch;
      var _reqId = 0;
      var _pending = {};

      window.addEventListener('message', function(event) {
        var d = event.data;
        if (!d || d.method !== 'modelFileResponse') return;
        var p = _pending[d.reqId];
        if (!p) return;
        delete _pending[d.reqId];
        if (d.status >= 400) {
          p.resolve(new Response(d.error || '', { status: d.status }));
        } else {
          p.resolve(new Response(d.data, {
            status: 200,
            headers: { 'Content-Type': d.contentType || 'application/octet-stream' }
          }));
        }
      });

      window.fetch = function(input, init) {
        var url = typeof input === 'string' ? input
                : (input instanceof URL ? input.href : (input && input.url));
        if (url && url.indexOf('huggingface.co') !== -1) {
          var reqId = ++_reqId;
          return new Promise(function(resolve) {
            _pending[reqId] = { resolve: resolve };
            parent.postMessage({ method: 'fetchModelFile', reqId: reqId, url: url }, '*');
          });
        }
        return _origFetch(input, init);
      };
    })();
  <\/script>` : ''}
  <script type="module">
    import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

    env.useBrowserCache = false;
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
      if (method === 'modelFileResponse') return;
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
