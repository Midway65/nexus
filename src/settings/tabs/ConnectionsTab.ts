/**
 * Location: src/settings/tabs/ConnectionsTab.ts
 * Purpose: Connections settings tab — Tier 1 ingestion exclusions and Tier 2 result filters.
 *
 * Group A (Tier 1) — Indexing exclusions: paths/patterns excluded from the semantic index.
 *   Changes call coordinator.reconcileIndex() to purge/add notes without a full rebuild.
 *
 * Group B (Tier 2) — Result filters: applied inside SemanticPanelView after retrieval.
 *   No re-indexing required — changes take effect on the next panel refresh.
 *
 * Group C — Panel UX: sidebar location and results limit.
 */

import { Setting, Notice, Platform } from 'obsidian';
import type { SettingsRouter } from '../SettingsRouter';
import type { EmbeddingManager } from '../../services/embeddings/EmbeddingManager';
import type { Settings } from '../../settings';
import { DEFAULT_CONNECTIONS_SETTINGS } from '../../ui/semanticPanel/ConnectionsSettings';

export interface ConnectionsTabConfig {
  embeddingManager: EmbeddingManager | null;
  settings: Settings;
}

export class ConnectionsTab {
  private container: HTMLElement;
  private config: ConnectionsTabConfig;

  constructor(container: HTMLElement, _router: SettingsRouter, config: ConnectionsTabConfig) {
    this.container = container;
    this.config = config;
    void this.render();
  }

  private async render(): Promise<void> {
    this.container.empty();
    this.container.addClass('nexus-settings-tab-content');

    this.container.createEl('h3', { text: 'Connections' });
    this.container.createEl('p', {
      text: 'Configure semantic connections — which notes enter the index and how results are filtered in the panel.',
      cls: 'nexus-settings-desc'
    });

    this.renderAutoInjectSection();
    this.renderPanelSection();
    this.renderTier1Section();
    this.renderTier2Section();

    if (!Platform.isDesktop) {
      const warn = this.container.createEl('p', { cls: 'nexus-settings-desc' });
      warn.textContent = 'Semantic indexing and the connections panel are only available on the desktop app.';
    }
  }

  // ---------------------------------------------------------------------------
  // Group D — Auto-inject vault context into chat system prompt
  // ---------------------------------------------------------------------------

  private renderAutoInjectSection(): void {
    const section = this.container.createDiv('nexus-settings-section');
    section.createEl('h4', { text: 'Chat context injection' });
    section.createEl('p', {
      text: 'When enabled, Nexus automatically finds vault notes related to your message and injects them into the system prompt before each reply. Result filters from the panel (Tier 2) are also applied.',
      cls: 'nexus-settings-desc'
    });

    const s = this.config.settings.settings;

    new Setting(section)
      .setName('Auto-inject related notes')
      .setDesc('Semantically search the vault for each message and add the top results to the system prompt.')
      .addToggle(toggle => {
        toggle
          .setValue(s.connectionsAutoInjectContext ?? false)
          .onChange(async (value) => {
            s.connectionsAutoInjectContext = value;
            await this.config.settings.saveSettings();
          });
      });

    new Setting(section)
      .setName('Notes to inject')
      .setDesc('How many related notes to include per message. More notes = richer context but longer prompts.')
      .addText(text => {
        text
          .setValue(String(s.connectionsContextLimit ?? 5))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              s.connectionsContextLimit = parsed;
              await this.config.settings.saveSettings();
            }
          });
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.max = '20';
        text.inputEl.style.width = '80px';
      });
  }

  // ---------------------------------------------------------------------------
  // Group C — Panel UX
  // ---------------------------------------------------------------------------

  private renderPanelSection(): void {
    const section = this.container.createDiv('nexus-settings-section');
    section.createEl('h4', { text: 'Panel' });

    const s = this.config.settings.settings;
    const cs = () => (s.connections ?? {});
    const saveConnections = async (patch: Partial<typeof DEFAULT_CONNECTIONS_SETTINGS>) => {
      s.connections = { ...DEFAULT_CONNECTIONS_SETTINGS, ...cs(), ...patch };
      await this.config.settings.saveSettings();
    };

    new Setting(section)
      .setName('Results limit')
      .setDesc('Maximum number of related notes shown in the panel.')
      .addText(text => {
        text
          .setValue(String(cs().results_limit ?? DEFAULT_CONNECTIONS_SETTINGS.results_limit))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              await saveConnections({ results_limit: parsed });
            }
          });
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.max = '200';
        text.inputEl.style.width = '80px';
      });

    new Setting(section)
      .setName('Sidebar location')
      .setDesc('Which sidebar opens when the Semantic Panel command is triggered.')
      .addDropdown(drop => {
        drop
          .addOption('right', 'Right')
          .addOption('left', 'Left')
          .setValue(cs().connections_view_location ?? DEFAULT_CONNECTIONS_SETTINGS.connections_view_location)
          .onChange(async (value) => {
            await saveConnections({ connections_view_location: value as 'left' | 'right' });
          });
      });
  }

  // ---------------------------------------------------------------------------
  // Group A — Tier 1: ingestion exclusions
  // ---------------------------------------------------------------------------

  private renderTier1Section(): void {
    const section = this.container.createDiv('nexus-settings-section');
    section.createEl('h4', { text: 'Indexing exclusions (Tier 1)' });

    const tipEl = section.createEl('p', { cls: 'nexus-settings-desc' });
    tipEl.textContent =
      'Enter folder paths (end with /) or glob patterns (use *), one per line. ' +
      'Example: Templates/ or Daily/202[0-2]/**. ' +
      'Hidden folders (.nexus/, .obsidian/) are always excluded. ' +
      'Changing these calls reconcileIndex() to purge removed paths and re-queue new ones.';

    const s = this.config.settings.settings;

    new Setting(section)
      .setName('Excluded patterns')
      .setDesc('Notes matching these patterns will not be embedded.')
      .addTextArea(area => {
        area
          .setValue((s.indexingExcludedPatterns ?? []).join('\n'))
          .onChange(async (value) => {
            const patterns = value
              .split('\n')
              .map(l => l.trim())
              .filter(Boolean);
            s.indexingExcludedPatterns = patterns.length > 0 ? patterns : undefined;
            await this.config.settings.saveSettings();
          });
        area.inputEl.rows = 6;
        area.inputEl.cols = 40;
        area.inputEl.style.fontFamily = 'var(--font-monospace)';
      });

    new Setting(section)
      .setName('Re-index vault')
      .setDesc('Apply changed exclusion patterns: purges newly-excluded notes and queues newly-eligible ones.')
      .addButton(btn => {
        btn
          .setButtonText('Reconcile index')
          .onClick(async () => {
            const coordinator = this.config.embeddingManager?.getCoordinator?.();
            if (!coordinator) {
              new Notice('Embedding system not ready.');
              return;
            }
            btn.setDisabled(true);
            btn.setButtonText('Running…');
            try {
              await coordinator.reconcileIndex();
              new Notice('Index reconciled.');
            } catch {
              new Notice('Reconcile failed. Check console for details.');
            } finally {
              btn.setDisabled(false);
              btn.setButtonText('Reconcile index');
            }
          });
      });
  }

  // ---------------------------------------------------------------------------
  // Group B — Tier 2: result filters
  // ---------------------------------------------------------------------------

  private renderTier2Section(): void {
    const section = this.container.createDiv('nexus-settings-section');
    section.createEl('h4', { text: 'Result filters (Tier 2)' });

    const tipEl = section.createEl('p', { cls: 'nexus-settings-desc' });
    tipEl.textContent =
      'These filters hide results in the panel without changing which notes are indexed. ' +
      'Exclude entries always win when they conflict with include entries. ' +
      'Changes take effect on the next panel refresh.';

    const s = this.config.settings.settings;
    const cs = () => (s.connections ?? {});
    const saveConnections = async (patch: Partial<typeof DEFAULT_CONNECTIONS_SETTINGS>) => {
      s.connections = { ...DEFAULT_CONNECTIONS_SETTINGS, ...cs(), ...patch };
      await this.config.settings.saveSettings();
    };

    // Path-fragment filters
    new Setting(section)
      .setName('Include filter')
      .setDesc('Comma-separated path fragments. Only results whose path contains at least one fragment are shown. Empty = no restriction.')
      .addText(text => {
        text
          .setPlaceholder('Projects/Clients, Archive/')
          .setValue(cs().include_filter ?? DEFAULT_CONNECTIONS_SETTINGS.include_filter)
          .onChange(async (value) => {
            await saveConnections({ include_filter: value });
          });
        text.inputEl.style.width = '260px';
      });

    new Setting(section)
      .setName('Exclude filter')
      .setDesc('Comma-separated path fragments. Results whose path contains any fragment are hidden. Exclude wins over include.')
      .addText(text => {
        text
          .setPlaceholder('Daily/, Templates/')
          .setValue(cs().exclude_filter ?? DEFAULT_CONNECTIONS_SETTINGS.exclude_filter)
          .onChange(async (value) => {
            await saveConnections({ exclude_filter: value });
          });
        text.inputEl.style.width = '260px';
      });

    // Frontmatter filters
    new Setting(section)
      .setName('Frontmatter include filter')
      .setDesc('Newline-delimited key or key:value pairs. Results are kept only when their frontmatter matches at least one entry. Empty = no restriction.')
      .addTextArea(area => {
        area
          .setPlaceholder('type:article\nstatus:published')
          .setValue(cs().frontmatter_filter_include ?? DEFAULT_CONNECTIONS_SETTINGS.frontmatter_filter_include)
          .onChange(async (value) => {
            await saveConnections({ frontmatter_filter_include: value });
          });
        area.inputEl.rows = 4;
        area.inputEl.style.fontFamily = 'var(--font-monospace)';
      });

    new Setting(section)
      .setName('Frontmatter exclude filter')
      .setDesc('Newline-delimited key or key:value pairs. Results are hidden when their frontmatter matches any entry. Exclude wins.')
      .addTextArea(area => {
        area
          .setPlaceholder('draft:true\narchived')
          .setValue(cs().frontmatter_filter_exclude ?? DEFAULT_CONNECTIONS_SETTINGS.frontmatter_filter_exclude)
          .onChange(async (value) => {
            await saveConnections({ frontmatter_filter_exclude: value });
          });
        area.inputEl.rows = 4;
        area.inputEl.style.fontFamily = 'var(--font-monospace)';
      });

    // Link filters
    new Setting(section)
      .setName('Exclude backlinks')
      .setDesc('Hide results that already link to the current note (notes you are already discoverable from).')
      .addToggle(toggle => {
        toggle
          .setValue(cs().exclude_inlinks ?? DEFAULT_CONNECTIONS_SETTINGS.exclude_inlinks)
          .onChange(async (value) => {
            await saveConnections({ exclude_inlinks: value });
          });
      });

    new Setting(section)
      .setName('Exclude outlinks')
      .setDesc('Hide results that the current note already links to (notes you have already connected).')
      .addToggle(toggle => {
        toggle
          .setValue(cs().exclude_outlinks ?? DEFAULT_CONNECTIONS_SETTINGS.exclude_outlinks)
          .onChange(async (value) => {
            await saveConnections({ exclude_outlinks: value });
          });
      });

    new Setting(section)
      .setName('Hide frontmatter blocks')
      .setDesc('In block mode, hide results where the matching block is the frontmatter section.')
      .addToggle(toggle => {
        toggle
          .setValue(cs().exclude_frontmatter_blocks ?? DEFAULT_CONNECTIONS_SETTINGS.exclude_frontmatter_blocks)
          .onChange(async (value) => {
            await saveConnections({ exclude_frontmatter_blocks: value });
          });
      });
  }

  destroy(): void {
    // Nothing to clean up — no intervals or external callbacks
  }
}
