/**
 * Location: src/settings/tabs/EmbeddingsTab.ts
 * Purpose: Embeddings settings tab — all embedding-related controls in one place.
 *
 * Single canonical home for:
 * - Model selection
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
import { EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL_ID } from '../../services/embeddings/EmbeddingModelCatalog';

export interface EmbeddingsTabConfig {
  embeddingManager: EmbeddingManager | null;
}

export class EmbeddingsTab {
  private container: HTMLElement;
  private router: SettingsRouter;
  private config: EmbeddingsTabConfig;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement, router: SettingsRouter, config: EmbeddingsTabConfig) {
    this.container = container;
    this.router = router;
    this.config = config;
    this.render();
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

    await this.renderStatusSection();
    this.renderModelSection();
    this.renderBlockIndexingSection();
    this.renderMaintenanceSection();
    this.renderDiagnosticsSection();
  }

  // ---------------------------------------------------------------------------
  // Status section
  // ---------------------------------------------------------------------------

  private async renderStatusSection(): Promise<void> {
    const section = this.container.createDiv('nexus-settings-section');
    section.createEl('h4', { text: 'Index Status' });

    const manager = this.config.embeddingManager;
    if (!manager) {
      section.createEl('p', {
        text: 'Embedding system not initialized yet. Try again after startup completes.',
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
      text: 'Changing the model requires a full index rebuild. Existing embeddings from a different model are incompatible.',
      cls: 'nexus-settings-desc'
    });

    const noteService = this.config.embeddingManager?.getService()?.getNoteEmbeddingService();

    for (const model of EMBEDDING_MODELS) {
      new Setting(section)
        .setName(model.displayName)
        .setDesc(`${model.description} (${model.quantizedSize}, ${model.dimensions}-dim)`)
        .addButton(button => {
          button.setButtonText('Select');
          button.onClick(async () => {
            if (!noteService) {
              new Notice('Embedding service not ready.');
              return;
            }
            try {
              await noteService.setConfigValue('activeModel', model.id);
              await noteService.setConfigValue('activeDimension', String(model.dimensions));
              new Notice(`Model set to ${model.displayName}. Rebuild the index to apply.`);
            } catch {
              new Notice('Failed to update model setting.');
            }
          });
        });
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
      .setDesc('Index note sections and paragraphs for higher-precision retrieval. Increases index size and build time.')
      .addToggle(toggle => {
        toggle.onChange(async (enabled) => {
          if (!noteService) return;
          await noteService.setConfigValue('blockIndexingEnabled', enabled ? 'true' : 'false');
          await noteService.setConfigValue('blockIndexStale', 'true');
          new Notice(enabled
            ? 'Block indexing enabled. Refresh or rebuild the index to index blocks.'
            : 'Block indexing disabled. Refresh or rebuild to remove existing block rows.'
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

    new Setting(section)
      .setName('Refresh index')
      .setDesc('Re-embed all notes. Skips unchanged notes (uses content hash).')
      .addButton(button => {
        button.setButtonText('Refresh');
        button.onClick(async () => {
          if (!coordinator) { new Notice('Embedding system not ready.'); return; }
          button.setButtonText('Refreshing…').setDisabled(true);
          try {
            await coordinator.refreshAll();
            new Notice('Index refresh complete.');
          } catch { new Notice('Refresh failed. Check console for details.'); }
          finally { button.setButtonText('Refresh').setDisabled(false); }
        });
      });

    new Setting(section)
      .setName('Rebuild index')
      .setDesc('Clear all embeddings and re-embed from scratch. Use after changing the model.')
      .addButton(button => {
        button.setButtonText('Rebuild').setCta();
        button.onClick(async () => {
          if (!coordinator) { new Notice('Embedding system not ready.'); return; }
          button.setButtonText('Rebuilding…').setDisabled(true);
          try {
            await coordinator.rebuildAll();
            if (noteService) {
              await noteService.setConfigValue('lastRebuildAt', String(Date.now()));
              await noteService.setConfigValue('blockIndexStale', 'false');
            }
            new Notice('Index rebuild complete.');
          } catch { new Notice('Rebuild failed. Check console for details.'); }
          finally { button.setButtonText('Rebuild').setDisabled(false); }
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
          } catch { new Notice('Clean failed.'); }
          finally { button.setButtonText('Clean').setDisabled(false); }
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
          } catch { new Notice('Clear failed.'); }
          finally { button.setButtonText('Clear').setDisabled(false); }
        });
      });
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
  }
}
