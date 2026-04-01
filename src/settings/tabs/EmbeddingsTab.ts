/**
 * Location: src/settings/tabs/EmbeddingsTab.ts
 * Purpose: Embeddings settings tab — all embedding-related controls in one place.
 *
 * Single canonical home for:
 * - Enable/disable semantic indexing
 * - Model selection with download progress
 * - Semantic index status (note count, block count, active model)
 * - Block indexing toggle
 * - Maintenance utilities (refresh, clean, rebuild, clear)
 * - Diagnostics
 *
 * Intentionally does NOT contain:
 * - Panel display settings (those are in the semantic panel's own popover)
 * - Provider/model config for LLM (those are in Providers tab)
 */

import { Setting, Notice, Platform } from 'obsidian';
import type { SettingsRouter } from '../SettingsRouter';
import type { EmbeddingManager } from '../../services/embeddings/EmbeddingManager';
import type { EmbeddingIndexCoordinator } from '../../services/embeddings/EmbeddingIndexCoordinator';
import type { Settings } from '../../settings';
import { EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL_ID } from '../../services/embeddings/EmbeddingModelCatalog';

export interface EmbeddingsTabConfig {
  embeddingManager: EmbeddingManager | null;
  settings: Settings;
}

export class EmbeddingsTab {
  private container: HTMLElement;
  private router: SettingsRouter;
  private config: EmbeddingsTabConfig;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  // Download progress state
  private downloadProgressEl: HTMLElement | null = null;
  private downloadProgressBar: HTMLElement | null = null;
  private downloadProgressText: HTMLElement | null = null;

  // Index maintenance progress state
  private indexProgressEl: HTMLElement | null = null;
  private indexProgressBar: HTMLElement | null = null;
  private indexProgressText: HTMLElement | null = null;

  // Persistent coordinator listener — survives tab re-renders
  private coordinatorProgressListener: ((data: unknown) => void) | null = null;
  private boundCoordinator: EmbeddingIndexCoordinator | null = null;

  constructor(container: HTMLElement, router: SettingsRouter, config: EmbeddingsTabConfig) {
    this.container = container;
    this.router = router;
    this.config = config;
    this.wireProgressCallback();
    void this.render();
  }

  private wireProgressCallback(): void {
    const manager = this.config.embeddingManager;
    if (!manager) return;
    manager.onDownloadProgress = (percent) => {
      this.updateDownloadProgress(percent);
    };
  }

  private async render(): Promise<void> {
    this.container.empty();
    this.container.addClass('nexus-settings-tab-content');

    if (!Platform.isDesktop) {
      this.container.createEl('p', {
        text: 'Local semantic embeddings are only available on the desktop app.',
        cls: 'nexus-settings-desc'
      });
      return;
    }

    this.container.createEl('h3', { text: 'Embeddings' });
    this.container.createEl('p', {
      text: 'Configure local embedding models and manage the semantic index.',
      cls: 'nexus-settings-desc'
    });

    this.renderEnableSection();
    await this.renderStatusSection();
    this.renderModelSection();
    this.renderBlockIndexingSection();
    this.renderMaintenanceSection();
    this.renderDiagnosticsSection();
  }

  // ---------------------------------------------------------------------------
  // Enable / disable
  // ---------------------------------------------------------------------------

  private renderEnableSection(): void {
    const section = this.container.createDiv('nexus-settings-section');

    new Setting(section)
      .setName('Enable semantic indexing')
      .setDesc('Indexes your notes locally for semantic search and the Semantic Panel. Requires restart to take effect after toggling.')
      .addToggle(toggle => {
        toggle
          .setValue(this.config.settings.settings.enableEmbeddings ?? true)
          .onChange(async (value) => {
            this.config.settings.settings.enableEmbeddings = value;
            await this.config.settings.saveSettings();
            new Notice(`Semantic indexing ${value ? 'enabled' : 'disabled'}. Restart Obsidian to apply.`);
          });
      });

    new Setting(section)
      .setName('HuggingFace access token')
      .setDesc('Required for gated models like Nomic Embed Text v1.5. Create a read token at huggingface.co/settings/tokens.')
      .addText(text => {
        text
          .setPlaceholder('hf_...')
          .setValue(this.config.settings.settings.huggingFaceToken ?? '')
          .onChange(async (value) => {
            const token = value.trim() || undefined;
            this.config.settings.settings.huggingFaceToken = token;
            await this.config.settings.saveSettings();
            this.config.embeddingManager?.setHuggingFaceToken(token);
          });
        text.inputEl.type = 'password';
      });
  }

  // ---------------------------------------------------------------------------
  // Status section
  // ---------------------------------------------------------------------------

  private async renderStatusSection(): Promise<void> {
    const section = this.container.createDiv('nexus-settings-section');
    section.createEl('h4', { text: 'Index status' });

    const manager = this.config.embeddingManager;
    if (!manager) {
      section.createEl('p', {
        text: 'Embedding system not initialized yet. It starts automatically a few seconds after Obsidian loads.',
        cls: 'nexus-settings-desc'
      });
      return;
    }

    const stats = await manager.getStats();
    const noteService = manager.getService()?.getNoteEmbeddingService();
    const indexState = noteService ? await noteService.getIndexState() : null;

    const statusGrid = section.createDiv('nexus-embed-status-grid');

    this.addStatusRow(statusGrid, 'Notes indexed', String(stats.noteCount));
    this.addStatusRow(statusGrid, 'Blocks indexed', String(indexState?.blockCount ?? 0));
    this.addStatusRow(statusGrid, 'Active model', indexState?.activeModel ?? DEFAULT_EMBEDDING_MODEL_ID);
    this.addStatusRow(statusGrid, 'Dimension', String(indexState?.activeDimension ?? '—'));
    this.addStatusRow(statusGrid, 'Block indexing', indexState?.blockIndexingEnabled ? 'Enabled' : 'Disabled');
    if (indexState?.lastRebuildAt) {
      this.addStatusRow(statusGrid, 'Last rebuild', new Date(indexState.lastRebuildAt).toLocaleDateString());
    }
  }

  private addStatusRow(container: HTMLElement, label: string, value: string): void {
    const row = container.createDiv('nexus-embed-status-row');
    row.createEl('span', { text: label, cls: 'nexus-embed-status-label' });
    row.createEl('span', { text: value, cls: 'nexus-embed-status-value' });
  }

  // ---------------------------------------------------------------------------
  // Model selection
  // ---------------------------------------------------------------------------

  private renderModelSection(): void {
    const section = this.container.createDiv('nexus-settings-section');
    section.createEl('h4', { text: 'Embedding model' });
    section.createEl('p', {
      text: 'Models are downloaded on first use and cached locally. Switching models requires a full index rebuild.',
      cls: 'nexus-settings-desc'
    });

    // Download progress bar (hidden until a download starts)
    const progressWrapper = section.createDiv('nexus-embed-download-progress');
    progressWrapper.addClass('is-hidden');
    const progressHeader = progressWrapper.createDiv('nexus-embed-download-header');
    this.downloadProgressText = progressHeader.createEl('span', {
      text: 'Downloading model…',
      cls: 'nexus-embed-download-label'
    });
    this.downloadProgressBar = progressWrapper.createDiv('nexus-embed-download-bar-track')
      .createDiv('nexus-embed-download-bar-fill');
    this.downloadProgressEl = progressWrapper;

    const manager = this.config.embeddingManager;

    for (const model of EMBEDDING_MODELS) {
      const setting = new Setting(section)
        .setName(model.displayName)
        .setDesc(`${model.description} Download size: ${model.quantizedSize} · ${model.dimensions} dimensions`);

      setting.addButton(button => {
        button.setButtonText('Select & download');
        button.onClick(async () => {
          if (!manager) {
            new Notice('Embedding system not ready yet.');
            return;
          }
          button.setButtonText('Switching…').setDisabled(true);
          this.showDownloadProgress(`Downloading ${model.displayName}…`);
          try {
            await manager.switchModel(model.id, model.dimensions);
            this.hideDownloadProgress();
            new Notice(`Switched to ${model.displayName}. Rebuild the index to apply.`, 5000);
          } catch (err) {
            this.hideDownloadProgress();
            new Notice(`Failed to switch model: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            button.setButtonText('Select & download').setDisabled(false);
          }
        });
      });
    }
  }

  private showDownloadProgress(label: string): void {
    if (!this.downloadProgressEl || !this.downloadProgressText) return;
    this.downloadProgressText.textContent = label;
    this.downloadProgressEl.removeClass('is-hidden');
    this.setDownloadBarPercent(0);
  }

  private hideDownloadProgress(): void {
    if (!this.downloadProgressEl) return;
    this.downloadProgressEl.addClass('is-hidden');
  }

  private setDownloadBarPercent(percent: number): void {
    if (this.downloadProgressBar) {
      this.downloadProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
    if (this.downloadProgressText && percent > 0) {
      const base = this.downloadProgressText.textContent?.replace(/ \d+%$/, '') ?? 'Downloading…';
      this.downloadProgressText.textContent = `${base} ${Math.round(percent)}%`;
    }
  }

  private updateDownloadProgress(percent: number): void {
    // Show progress bar if it's hidden (model loading at startup)
    if (this.downloadProgressEl?.hasClass('is-hidden')) {
      this.showDownloadProgress('Downloading model…');
    }
    this.setDownloadBarPercent(percent);
    if (percent >= 100) {
      setTimeout(() => this.hideDownloadProgress(), 1500);
    }
  }

  // ---------------------------------------------------------------------------
  // Block indexing toggle
  // ---------------------------------------------------------------------------

  private renderBlockIndexingSection(): void {
    const section = this.container.createDiv('nexus-settings-section');
    section.createEl('h4', { text: 'Block indexing' });

    const noteService = this.config.embeddingManager?.getService()?.getNoteEmbeddingService();

    new Setting(section)
      .setName('Enable block-level indexing')
      .setDesc('Index note sections and paragraphs for higher-precision retrieval in the Semantic Panel. Increases index size and build time.')
      .addToggle(toggle => {
        toggle.onChange(async (enabled) => {
          if (!noteService) return;
          await noteService.setConfigValue('blockIndexingEnabled', enabled ? 'true' : 'false');
          await noteService.setConfigValue('blockIndexStale', 'true');
          new Notice(enabled
            ? 'Block indexing enabled. Use Rebuild index to index blocks.'
            : 'Block indexing disabled. Use Rebuild index to remove existing block rows.'
          );
        });
      });
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  private renderMaintenanceSection(): void {
    const section = this.container.createDiv('nexus-settings-section');
    section.createEl('h4', { text: 'Maintenance' });

    const coordinator = this.config.embeddingManager?.getCoordinator();
    const noteService = this.config.embeddingManager?.getService()?.getNoteEmbeddingService();

    // Progress bar for refresh / rebuild operations
    const indexProgress = section.createDiv('nexus-embed-index-progress');
    indexProgress.addClass('is-hidden');
    const indexProgressHeader = indexProgress.createDiv('nexus-embed-index-header');
    this.indexProgressText = indexProgressHeader.createEl('span', {
      cls: 'nexus-embed-index-label',
      text: 'Processing…'
    });
    this.indexProgressBar = indexProgress.createDiv('nexus-embed-download-bar-track')
      .createDiv('nexus-embed-download-bar-fill');
    this.indexProgressEl = indexProgress;

    // Re-connect if a rebuild/refresh was already running when this tab was re-rendered
    if (coordinator?.isOperationRunning()) {
      this.showIndexProgress(coordinator.getOperationLabel() ?? 'Processing…');
      const last = coordinator.getLastProgress();
      if (last) {
        this.setIndexProgress(
          `${last.current} / ${last.total} notes`,
          last.total > 0 ? last.current / last.total : 0
        );
      }
      this.attachCoordinatorListener(coordinator);
    }

    new Setting(section)
      .setName('Refresh index')
      .setDesc('Re-embed all notes. Skips unchanged notes (uses content hash).')
      .addButton(button => {
        button.setButtonText('Refresh');
        button.onClick(async () => {
          if (!coordinator) { new Notice('Embedding system not ready.'); return; }
          button.setButtonText('Refreshing…').setDisabled(true);
          this.showIndexProgress('Refreshing…');
          this.attachCoordinatorListener(coordinator);
          try {
            await coordinator.refreshAll();
            new Notice('Index refresh complete.');
          } catch (err) {
            new Notice(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            this.detachCoordinatorListener();
            this.hideIndexProgress();
            button.setButtonText('Refresh').setDisabled(false);
          }
        });
      });

    new Setting(section)
      .setName('Rebuild index')
      .setDesc('Clear all embeddings and re-embed from scratch. Required after switching models.')
      .addButton(button => {
        button.setButtonText('Rebuild').setCta();
        button.onClick(async () => {
          if (!coordinator) { new Notice('Embedding system not ready.'); return; }
          button.setButtonText('Rebuilding…').setDisabled(true);
          this.showIndexProgress('Rebuilding…');
          this.attachCoordinatorListener(coordinator);
          try {
            await coordinator.rebuildAll();
            if (noteService) {
              await noteService.setConfigValue('lastRebuildAt', String(Date.now()));
              await noteService.setConfigValue('blockIndexStale', 'false');
            }
            new Notice('Index rebuild complete.');
          } catch (err) {
            new Notice(`Rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            this.detachCoordinatorListener();
            this.hideIndexProgress();
            button.setButtonText('Rebuild').setDisabled(false);
          }
        });
      });

    new Setting(section)
      .setName('Clean index')
      .setDesc('Remove orphaned block rows and inconsistent entries.')
      .addButton(button => {
        button.setButtonText('Clean');
        button.onClick(async () => {
          if (!noteService) { new Notice('Embedding service not ready.'); return; }
          button.setButtonText('Cleaning…').setDisabled(true);
          try {
            await noteService.cleanIndex();
            new Notice('Index cleaned.');
          } catch (err) {
            new Notice(`Clean failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally { button.setButtonText('Clean').setDisabled(false); }
        });
      });

    new Setting(section)
      .setName('Clear all embeddings')
      .setDesc('Delete all note and block embeddings. The index will be empty until a rebuild is triggered.')
      .addButton(button => {
        button.setButtonText('Clear').setWarning();
        button.onClick(async () => {
          if (!noteService) { new Notice('Embedding service not ready.'); return; }
          button.setButtonText('Clearing…').setDisabled(true);
          try {
            await noteService.clearAllEmbeddings();
            new Notice('All embeddings cleared.');
          } catch (err) {
            new Notice(`Clear failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally { button.setButtonText('Clear').setDisabled(false); }
        });
      });
  }

  private showIndexProgress(label: string): void {
    if (!this.indexProgressEl || !this.indexProgressText) return;
    this.indexProgressText.textContent = label;
    this.indexProgressEl.removeClass('is-hidden');
    if (this.indexProgressBar) this.indexProgressBar.style.width = '0%';
  }

  private hideIndexProgress(): void {
    this.indexProgressEl?.addClass('is-hidden');
  }

  private setIndexProgress(label: string, fraction: number): void {
    if (this.indexProgressText) this.indexProgressText.textContent = label;
    if (this.indexProgressBar) {
      this.indexProgressBar.style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
    }
  }

  /**
   * Subscribe to coordinator progress events, pointing at the current DOM elements.
   * Safe to call multiple times — detaches the old listener first.
   */
  private attachCoordinatorListener(coordinator: EmbeddingIndexCoordinator): void {
    this.detachCoordinatorListener();
    this.boundCoordinator = coordinator;
    this.coordinatorProgressListener = (data: unknown) => {
      const { current, total } = data as { current: number; total: number };
      this.setIndexProgress(`${current} / ${total} notes`, total > 0 ? current / total : 0);
    };
    coordinator.on('embedding:reconcile-progress', this.coordinatorProgressListener);
  }

  /** Remove the active coordinator progress listener. */
  private detachCoordinatorListener(): void {
    if (this.boundCoordinator && this.coordinatorProgressListener) {
      this.boundCoordinator.off('embedding:reconcile-progress', this.coordinatorProgressListener);
    }
    this.coordinatorProgressListener = null;
    this.boundCoordinator = null;
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  private renderDiagnosticsSection(): void {
    const section = this.container.createDiv('nexus-settings-section');
    section.createEl('h4', { text: 'Diagnostics' });

    const runtime = this.config.embeddingManager?.getService()?.getRuntime();

    const diagGrid = section.createDiv('nexus-embed-status-grid');
    this.addStatusRow(diagGrid, 'Runtime health', runtime?.currentHealth ?? 'unavailable');
    this.addStatusRow(diagGrid, 'Desktop', Platform.isDesktop ? 'Yes' : 'No');
  }

  destroy(): void {
    if (this.refreshInterval !== null) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    // Detach progress callback so a stale tab can't update a destroyed DOM
    if (this.config.embeddingManager) {
      this.config.embeddingManager.onDownloadProgress = null;
    }
    // Detach coordinator listener so the next tab instance can subscribe cleanly
    this.detachCoordinatorListener();
  }
}
