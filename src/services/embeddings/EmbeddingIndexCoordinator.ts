/**
 * Location: src/services/embeddings/EmbeddingIndexCoordinator.ts
 * Purpose: Startup reconciliation, vault event listeners, and job queue.
 *
 * Responsibilities:
 * - Startup reconciliation: add missing, update changed, remove deleted/excluded
 * - Live vault events: create / modify / delete / rename
 * - Job coalescing queue
 * - Maintenance action orchestration: refresh, clean, rebuild, clear
 * - Progress and error event emission
 *
 * Lifecycle contract: extends Component so all vault event listeners registered
 * via this.registerEvent() are automatically torn down on plugin unload.
 * Registered with plugin.addChild(coordinator) by PluginLifecycleManager.
 */

import { Component, Notice, TFile, TAbstractFile } from 'obsidian';
import type { NoteEmbeddingService } from './NoteEmbeddingService';
import type { EmbeddingExclusionService } from './EmbeddingExclusionService';

type EmbeddingJob =
  | { type: 'upsert'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'rename'; oldPath: string; newPath: string };

export interface IndexProgressEvent {
  current: number;
  total: number;
  phase: 'reconcile' | 'refresh' | 'rebuild';
}

export type IndexEventType =
  | 'embedding:reconcile-progress'
  | 'embedding:reconcile-complete'
  | 'embedding:job-complete'
  | 'embedding:job-error'
  | 'embedding:rebuild-start'
  | 'embedding:rebuild-complete';

export class EmbeddingIndexCoordinator extends Component {
  private queue: EmbeddingJob[] = [];
  private isProcessing = false;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private eventListeners = new Map<IndexEventType, Array<(data: unknown) => void>>();
  private isShuttingDown = false;

  // Operation state — queried by EmbeddingsTab when it re-renders mid-operation
  private runningOperation: 'refresh' | 'rebuild' | null = null;
  private lastProgressData: IndexProgressEvent | null = null;

  // Pause / abort signals
  private isPaused = false;
  private abortRequested = false;
  private lastOperationAborted = false;

  constructor(
    private app: import('obsidian').App,
    private noteEmbeddingService: NoteEmbeddingService,
    private exclusions: EmbeddingExclusionService,
  ) {
    super();
  }

  /**
   * Start the coordinator: register vault events and run startup reconciliation.
   * Call after plugin layout is ready.
   */
  async start(): Promise<void> {
    this.registerEvent(this.app.vault.on('create', (file) => this.onFileCreate(file)));
    this.registerEvent(this.app.vault.on('modify', (file) => this.onFileModify(file)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onFileDelete(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onFileRename(file, oldPath)));

    // Run startup reconciliation in the background (non-blocking)
    this.reconcileIndex().catch(err => {
      console.error('[EmbeddingIndexCoordinator] Reconciliation failed:', err);
    });
  }

  // ---------------------------------------------------------------------------
  // Vault event handlers
  // ---------------------------------------------------------------------------

  private onFileCreate(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (!this.exclusions.shouldIndex(file.path)) return;
    this.enqueue({ type: 'upsert', path: file.path });
  }

  private onFileModify(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== 'md') return;

    // Debounce — collapse rapid saves to a single upsert
    const existing = this.debounceTimers.get(file.path);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(file.path);
      if (!this.exclusions.shouldIndex(file.path)) return;
      this.enqueue({ type: 'upsert', path: file.path });
    }, 1000);
    this.debounceTimers.set(file.path, timer);
  }

  private onFileDelete(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== 'md') return;

    // Cancel any pending debounced upsert for this path
    const timer = this.debounceTimers.get(file.path);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(file.path);
    }

    // Remove any pending upsert from queue
    const idx = this.queue.findIndex(j => j.type === 'upsert' && j.path === file.path);
    if (idx !== -1) this.queue.splice(idx, 1);

    this.enqueue({ type: 'delete', path: file.path });
  }

  private onFileRename(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    const newPath = file.path;

    if (!this.exclusions.shouldIndex(newPath)) {
      // New path is excluded — treat as deletion
      this.enqueue({ type: 'delete', path: oldPath });
    } else {
      this.enqueue({ type: 'rename', oldPath, newPath });
    }
  }

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------

  private enqueue(job: EmbeddingJob): void {
    if (this.isShuttingDown) return;

    // Coalesce: multiple upserts for the same path collapse to one
    if (job.type === 'upsert') {
      const existing = this.queue.findIndex(
        j => j.type === 'upsert' && j.path === job.path
      );
      if (existing !== -1) return; // Already queued
    }

    this.queue.push(job);
    if (!this.isProcessing) {
      void this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.isProcessing = true;

    while (this.queue.length > 0 && !this.isShuttingDown) {
      const job = this.queue.shift()!;

      try {
        await this.executeJob(job);
        this.emit('embedding:job-complete', job);
      } catch (err) {
        this.emit('embedding:job-error', { job, error: err });
        console.error('[EmbeddingIndexCoordinator] Job failed:', job, err);
      }

      // Yield to event loop between jobs
      await new Promise(r => setTimeout(r, 0));
    }

    this.isProcessing = false;
  }

  private async executeJob(job: EmbeddingJob): Promise<void> {
    switch (job.type) {
      case 'upsert':
        await this.noteEmbeddingService.embedNote(job.path);
        break;
      case 'delete':
        await this.noteEmbeddingService.removeNote(job.path);
        break;
      case 'rename':
        await this.noteEmbeddingService.renameNote(job.oldPath, job.newPath);
        // If content didn't change, no re-embed needed; embedNote handles hash check
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Startup reconciliation
  // ---------------------------------------------------------------------------

  async reconcileIndex(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const livePaths = new Set(files.map(f => f.path));

    for (let i = 0; i < files.length; i++) {
      if (this.isShuttingDown) return;
      const path = files[i].path;

      if (!this.exclusions.shouldIndex(path)) {
        await this.noteEmbeddingService.removeNote(path);
      } else {
        try {
          await this.noteEmbeddingService.embedNote(path);
        } catch (err) {
          if (this.isModelError(err)) {
            new Notice(this.modelErrorMessage(err), 10000);
            return; // Abort — all remaining notes would fail the same way
          }
          console.error(`[EmbeddingIndexCoordinator] Failed to embed ${path}:`, err);
        }
      }

      // Yield to event loop every 10 files
      if (i % 10 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }

      this.emit('embedding:reconcile-progress', {
        current: i + 1,
        total: files.length,
        phase: 'reconcile',
      });
    }

    // Remove stale rows: files deleted while Obsidian was closed, or newly excluded
    try {
      const indexedPaths = await this.noteEmbeddingService.getIndexedPaths();
      for (const indexedPath of indexedPaths) {
        if (!livePaths.has(indexedPath) || !this.exclusions.shouldIndex(indexedPath)) {
          await this.noteEmbeddingService.removeNote(indexedPath);
        }
      }
    } catch (err) {
      console.error('[EmbeddingIndexCoordinator] Stale path cleanup failed:', err);
    }

    this.emit('embedding:reconcile-complete', undefined);
  }

  // ---------------------------------------------------------------------------
  // Maintenance actions
  // ---------------------------------------------------------------------------

  /** Re-embed all indexed notes (respects hash — skips unchanged). */
  async refreshAll(): Promise<void> {
    this.runningOperation = 'refresh';
    this.abortRequested = false;
    this.lastOperationAborted = false;
    try {
      const files = this.app.vault.getMarkdownFiles();
      for (let i = 0; i < files.length; i++) {
        if (this.isShuttingDown || this.abortRequested) break;
        await this.waitWhilePaused();
        if (this.abortRequested) break;

        if (this.exclusions.shouldIndex(files[i].path)) {
          try {
            await this.noteEmbeddingService.embedNote(files[i].path);
          } catch (err) {
            if (this.isModelError(err)) throw err; // Let button handler surface it
            console.error(`[EmbeddingIndexCoordinator] Failed to embed ${files[i].path}:`, err);
          }
        }
        if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
        this.emit('embedding:reconcile-progress', {
          current: i + 1,
          total: files.length,
          phase: 'refresh',
        });
      }
      if (!this.abortRequested) this.emit('embedding:reconcile-complete', undefined);
    } finally {
      this.lastOperationAborted = this.abortRequested;
      this.isPaused = false;
      this.abortRequested = false;
      this.runningOperation = null;
      this.lastProgressData = null;
    }
  }

  /** Drop all embeddings and rebuild from scratch. */
  async rebuildAll(): Promise<void> {
    this.runningOperation = 'rebuild';
    this.abortRequested = false;
    this.lastOperationAborted = false;
    try {
      this.emit('embedding:rebuild-start', undefined);
      await this.noteEmbeddingService.clearAllEmbeddings();
      const files = this.app.vault.getMarkdownFiles();
      for (let i = 0; i < files.length; i++) {
        if (this.isShuttingDown || this.abortRequested) break;
        await this.waitWhilePaused();
        if (this.abortRequested) break;

        if (this.exclusions.shouldIndex(files[i].path)) {
          try {
            await this.noteEmbeddingService.embedNote(files[i].path);
          } catch (err) {
            if (this.isModelError(err)) throw err; // Let button handler surface it
            console.error(`[EmbeddingIndexCoordinator] Failed to embed ${files[i].path}:`, err);
          }
        }
        if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
        this.emit('embedding:reconcile-progress', {
          current: i + 1,
          total: files.length,
          phase: 'rebuild',
        });
      }
      if (!this.abortRequested) this.emit('embedding:rebuild-complete', undefined);
    } finally {
      this.lastOperationAborted = this.abortRequested;
      this.isPaused = false;
      this.abortRequested = false;
      this.runningOperation = null;
      this.lastProgressData = null;
    }
  }

  /** Whether a refresh or rebuild is currently running. */
  isOperationRunning(): boolean {
    return this.runningOperation !== null;
  }

  /** Human-readable label for the current running operation. */
  getOperationLabel(): string | null {
    if (this.runningOperation === 'refresh') return 'Refreshing…';
    if (this.runningOperation === 'rebuild') return 'Rebuilding…';
    return null;
  }

  /** Last emitted progress snapshot (null when no operation is running). */
  getLastProgress(): IndexProgressEvent | null {
    return this.lastProgressData;
  }

  /** Whether the current operation has been paused by the user. */
  isOperationPaused(): boolean {
    return this.isPaused;
  }

  /** Whether the last operation was stopped before it finished. */
  wasLastOperationAborted(): boolean {
    return this.lastOperationAborted;
  }

  /** Pause the running operation between notes. */
  pauseOperation(): void {
    if (this.runningOperation) this.isPaused = true;
  }

  /** Resume a paused operation. */
  resumeOperation(): void {
    this.isPaused = false;
  }

  /** Stop the running operation cleanly (between notes). */
  abortOperation(): void {
    this.abortRequested = true;
    this.isPaused = false; // Unblock waitWhilePaused so the abort is seen
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.isPaused && !this.abortRequested && !this.isShuttingDown) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // ---------------------------------------------------------------------------
  // Event bus
  // ---------------------------------------------------------------------------

  on(event: IndexEventType, listener: (data: unknown) => void): void {
    const existing = this.eventListeners.get(event) ?? [];
    existing.push(listener);
    this.eventListeners.set(event, existing);
  }

  off(event: IndexEventType, listener: (data: unknown) => void): void {
    const existing = this.eventListeners.get(event);
    if (!existing) return;
    this.eventListeners.set(event, existing.filter(l => l !== listener));
  }

  private emit(event: IndexEventType, data: unknown): void {
    // Keep a snapshot of reconcile-progress so a re-rendered tab can catch up
    if (event === 'embedding:reconcile-progress') {
      this.lastProgressData = data as IndexProgressEvent;
    }
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(data);
      } catch (err) {
        console.error('[EmbeddingIndexCoordinator] Event listener error:', err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Model error detection
  // ---------------------------------------------------------------------------

  /**
   * Returns true when an error is caused by a model download or auth failure
   * (i.e. all subsequent notes would fail identically — abort is the right call).
   */
  private isModelError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes('Cannot download') ||
      msg.includes('HuggingFace token') ||
      msg.includes('initialization previously failed') ||
      msg.includes('initialization timeout')
    );
  }

  /** Strip the technical detail from a model error for display in a Notice. */
  private modelErrorMessage(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    // The error already contains user-friendly steps — return it directly.
    return `Embedding model error: ${msg}`;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  onunload(): void {
    this.isShuttingDown = true;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.queue = [];
    this.eventListeners.clear();
  }
}
