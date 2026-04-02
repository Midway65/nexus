/**
 * Location: src/services/embeddings/EmbeddingManager.ts
 * Purpose: High-level manager for embedding system initialization and coordination
 *
 * Features:
 * - Desktop-only (disabled on mobile)
 * - Lazy initialization (3-second delay on startup)
 * - Coordinates EmbeddingEngine, EmbeddingService, EmbeddingIndexCoordinator,
 *   ConversationEmbeddingWatcher, IndexingQueue, and StatusBar
 * - Graceful shutdown with cleanup
 *
 * Relationships:
 * - Called by PluginLifecycleManager for initialization
 * - Manages all embedding system components
 */

import { App, Plugin, Platform } from 'obsidian';
import { EmbeddingEngine } from './EmbeddingEngine';
import { EmbeddingRuntime, DEFAULT_EMBEDDING_MODEL_ID } from './EmbeddingRuntime';
import { EmbeddingIndexCoordinator } from './EmbeddingIndexCoordinator';
import { EmbeddingExclusionService } from './EmbeddingExclusionService';
import { EmbeddingService } from './EmbeddingService';
import { ConversationEmbeddingWatcher } from './ConversationEmbeddingWatcher';
import { IndexingQueue } from './IndexingQueue';
import { EmbeddingStatusBar } from './EmbeddingStatusBar';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';
import type { MessageRepository } from '../../database/repositories/MessageRepository';

/**
 * Embedding system manager
 *
 * Desktop-only - automatically disabled on mobile platforms
 */
export class EmbeddingManager {
  private app: App;
  private plugin: Plugin;
  private db: SQLiteCacheManager;
  private messageRepository: MessageRepository | null;

  private engine: EmbeddingEngine | null = null;
  private runtime: EmbeddingRuntime | null = null;
  private coordinator: EmbeddingIndexCoordinator | null = null;
  private service: EmbeddingService | null = null;
  private conversationWatcher: ConversationEmbeddingWatcher | null = null;
  private queue: IndexingQueue | null = null;
  private statusBar: EmbeddingStatusBar | null = null;

  private isEnabled: boolean;
  private isInitialized: boolean = false;
  private hfToken: string | null = null;
  private getExclusionPatterns: () => string[];

  constructor(
    app: App,
    plugin: Plugin,
    db: SQLiteCacheManager,
    enableEmbeddings: boolean = true,
    messageRepository?: MessageRepository,
    huggingFaceToken?: string,
    getExclusionPatterns?: () => string[]
  ) {
    this.app = app;
    this.plugin = plugin;
    this.db = db;
    this.messageRepository = messageRepository ?? null;
    this.hfToken = huggingFaceToken ?? null;
    this.getExclusionPatterns = getExclusionPatterns ?? (() => []);

    // Disable on mobile or if user disabled embeddings
    this.isEnabled = !Platform.isMobile && enableEmbeddings;
  }

  setHuggingFaceToken(token: string | undefined): void {
    this.hfToken = token ?? null;
    // Propagate to the live runtime so the next download attempt uses the new token
    this.runtime?.setHuggingFaceToken(this.hfToken);
  }

  /**
   * Initialize the embedding system
   * Should be called after a delay from plugin startup (e.g., 3 seconds)
   */
  async initialize(): Promise<void> {
    if (!this.isEnabled || this.isInitialized) {
      return;
    }

    try {
      // Read the persisted activeModel from DB before constructing the runtime.
      // Falls back to DEFAULT_EMBEDDING_MODEL_ID when no config row exists yet.
      const savedModelId = await this.readActiveModelFromDb();

      // Create components
      this.engine = new EmbeddingEngine();
      this.runtime = new EmbeddingRuntime(savedModelId, this.app, this.hfToken);
      this.wireProgressCallback();
      this.service = new EmbeddingService(this.app, this.db, this.engine, this.runtime);

      // Create coordinator for startup reconciliation and vault event handling
      const exclusions = new EmbeddingExclusionService(
        this.app,
        this.getExclusionPatterns
      );
      this.coordinator = new EmbeddingIndexCoordinator(
        this.app,
        this.service.getNoteEmbeddingService(),
        exclusions,
      );
      this.plugin.addChild(this.coordinator);

      this.queue = new IndexingQueue(this.app, this.service, this.db);
      this.statusBar = new EmbeddingStatusBar(this.plugin, this.queue);

      // Initialize status bar (desktop only)
      this.statusBar.init();

      // Start watching conversation events (assistant message completions)
      if (this.messageRepository) {
        this.conversationWatcher = new ConversationEmbeddingWatcher(
          this.service,
          this.messageRepository,
          this.db
        );
        this.conversationWatcher.start();
      }

      // Start background indexing after a brief delay
      // This ensures the plugin is fully loaded before we start heavy processing
      setTimeout(async () => {
        // Warm up the runtime so the WebGPU/WASM backend is detected even
        // when no notes need re-indexing (fully up-to-date vault).
        // Model files are already cached so this is just iframe startup.
        if (this.runtime) {
          this.runtime.initialize().catch(err => {
            console.error('[EmbeddingManager] Runtime warm-up failed:', err);
          });
        }

        if (this.coordinator) {
          try {
            // Phase 1: Startup reconciliation via EmbeddingIndexCoordinator
            await this.coordinator.start();
          } catch (error) {
            console.error('[EmbeddingManager] Coordinator start failed:', error);
          }
        }

        if (this.queue) {
          try {
            // Phase 2: Backfill existing traces (from migration)
            await this.queue.startTraceIndex();

            // Phase 3: Backfill existing conversations
            await this.queue.startConversationIndex();
          } catch (error) {
            console.error('[EmbeddingManager] Background indexing failed:', error);
          }
        }
      }, 3000); // 3-second delay

      this.isInitialized = true;

    } catch (error) {
      console.error('[EmbeddingManager] Initialization failed:', error);
      // Don't throw - embeddings are optional functionality
    }
  }

  /**
   * Read persisted activeModel from embedding_config table.
   * Returns DEFAULT_EMBEDDING_MODEL_ID when the table is empty or not yet created.
   */
  private async readActiveModelFromDb(): Promise<string> {
    try {
      const row = await this.db.queryOne<{ value: string }>(
        "SELECT value FROM embedding_config WHERE key = 'activeModel'"
      );
      if (row?.value) return row.value;
    } catch {
      // Table may not exist yet on first run — fall through to default
    }
    return DEFAULT_EMBEDDING_MODEL_ID;
  }

  /** Optional callback — fired with 0–100 while the note model downloads. */
  onDownloadProgress: ((percent: number) => void) | null = null;

  /** Optional callback — fired once when the runtime becomes ready. */
  onRuntimeReady: (() => void) | null = null;

  private wireProgressCallback(): void {
    if (this.runtime) {
      this.runtime.onProgress = (percent) => {
        this.onDownloadProgress?.(percent);
      };
      this.runtime.onReady = () => {
        this.onRuntimeReady?.();
      };
    }
  }

  /**
   * Switch to a different embedding model at runtime.
   * 1. Writes new model to DB config.
   * 2. Disposes old runtime, creates new one.
   * 3. Hot-swaps runtime into the service layer.
   * 4. Marks block index as stale (different model = incompatible blocks).
   *
   * The caller (EmbeddingsTab) should trigger a rebuild after switching.
   */
  async switchModel(modelId: string, dimensions: number): Promise<void> {
    if (!this.isEnabled || !this.service) return;

    const noteService = this.service.getNoteEmbeddingService();

    // If dimensions changed, drop and recreate the vec0 tables (sqlite-vec float[N]
    // columns cannot be altered — dimension mismatch causes immediate insert failure).
    const currentState = await noteService.getIndexState();
    if (currentState.activeDimension !== null && currentState.activeDimension !== dimensions) {
      await noteService.recreateEmbeddingTables(dimensions);
    }

    // Persist new model selection
    await noteService.setConfigValue('activeModel', modelId);
    await noteService.setConfigValue('activeDimension', String(dimensions));
    await noteService.setConfigValue('blockIndexStale', 'true');

    // Dispose old runtime
    if (this.runtime) {
      await this.runtime.dispose();
    }

    // Create and wire new runtime
    this.runtime = new EmbeddingRuntime(modelId, this.app, this.hfToken);
    this.wireProgressCallback();
    this.service.switchRuntime(this.runtime);

    // Initialize the new runtime (starts model download if not cached)
    await this.runtime.initialize();
  }

  /**
   * Shutdown the embedding system
   * Called during plugin unload
   */
  async shutdown(): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    try {
      // Cancel indexing and remove all listeners
      if (this.queue) {
        this.queue.destroy();
      }

      // Stop watching conversation events
      if (this.conversationWatcher) {
        this.conversationWatcher.stop();
      }

      // Clean up status bar (removes progress listener)
      if (this.statusBar) {
        this.statusBar.destroy();
      }

      // Dispose of embedding engines (revokes blob URL, removes iframes)
      if (this.engine) {
        await this.engine.dispose();
      }
      if (this.runtime) {
        await this.runtime.dispose();
      }

      this.isInitialized = false;

    } catch (error) {
      console.error('[EmbeddingManager] Shutdown failed:', error);
    }
  }

  /**
   * Get the embedding service (for external use)
   */
  getService(): EmbeddingService | null {
    return this.service;
  }

  getDb(): SQLiteCacheManager {
    return this.db;
  }

  /**
   * Get the indexing queue (for external use)
   */
  getQueue(): IndexingQueue | null {
    return this.queue;
  }

  /**
   * Get the index coordinator (for maintenance actions and event listening)
   */
  getCoordinator(): EmbeddingIndexCoordinator | null {
    return this.coordinator;
  }

  /**
   * Check if embedding system is enabled
   */
  isEmbeddingEnabled(): boolean {
    return this.isEnabled && this.isInitialized;
  }

  /**
   * Get statistics about the embedding system
   */
  async getStats(): Promise<{
    enabled: boolean;
    initialized: boolean;
    noteCount: number;
    traceCount: number;
    conversationChunkCount: number;
    indexingInProgress: boolean;
  }> {
    if (!this.isEnabled || !this.service) {
      return {
        enabled: false,
        initialized: false,
        noteCount: 0,
        traceCount: 0,
        conversationChunkCount: 0,
        indexingInProgress: false
      };
    }

    const stats = await this.service.getStats();

    return {
      enabled: this.isEnabled,
      initialized: this.isInitialized,
      noteCount: stats.noteCount,
      traceCount: stats.traceCount,
      conversationChunkCount: stats.conversationChunkCount,
      indexingInProgress: this.queue?.isIndexing() ?? false
    };
  }
}
