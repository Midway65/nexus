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
      text: 'When enabled, Nexus searches your vault for notes related to each message and shares them with the AI before it replies. The result filters below also apply.',
      cls: 'nexus-settings-desc'
    });

    const s = this.config.settings.settings;

    new Setting(section)
      .setName('Auto-inject related notes')
      .setDesc('Find vault notes related to your message and include them as context for the AI.')
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
      .setDesc('Number of related notes to include per message. Higher values give richer context but increase prompt length.')
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
    section.createEl('h4', { text: 'Indexing exclusions' });

    const tipEl = section.createEl('p', { cls: 'nexus-settings-desc' });
    tipEl.textContent =
      'Notes in excluded folders or matching excluded patterns will not be embedded. ' +
      'Enter one pattern per line — folder paths end with / (e.g. Templates/), ' +
      'wildcards use * (e.g. Daily/2024/**). ' +
      'Hidden folders such as .nexus/ and .obsidian/ are always excluded. ' +
      'After changing patterns, click Apply below to update the index.';

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
      .setDesc('Removes newly-excluded notes from the index and adds any notes that now qualify.')
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
    section.createEl('h4', { text: 'Result filters' });

    const tipEl = section.createEl('p', { cls: 'nexus-settings-desc' });
    tipEl.textContent =
      'These filters hide results in the Semantic Panel without removing notes from the index. ' +
      'Changes take effect on the next panel refresh. ' +
      'When a path appears in both include and exclude, exclude always wins.';

    const s = this.config.settings.settings;
    const cs = () => (s.connections ?? {});
    const saveConnections = async (patch: Partial<typeof DEFAULT_CONNECTIONS_SETTINGS>) => {
      s.connections = { ...DEFAULT_CONNECTIONS_SETTINGS, ...cs(), ...patch };
      await this.config.settings.saveSettings();
    };

    // Path-fragment filters
    new Setting(section)
      .setName('Include filter')
      .setDesc('Only show results whose file path contains one of these fragments (comma-separated). Leave blank to show all. Example: Projects/ shows only notes inside a Projects folder.')
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
      .setDesc('Hide results whose file path contains any of these fragments (comma-separated). Example: Daily/, Templates/ hides daily notes and templates.')
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
      .setDesc('Only show results whose frontmatter matches at least one entry. One per line — use key to match any value (e.g. type) or key:value to match exactly (e.g. type:article). Leave blank to show all.')
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
      .setDesc('Hide results whose frontmatter matches any entry. One per line — use key or key:value. Example: draft:true hides all notes where draft is set to true.')
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
      .setDesc('Hide notes that already have a link pointing to the current note.')
      .addToggle(toggle => {
        toggle
          .setValue(cs().exclude_inlinks ?? DEFAULT_CONNECTIONS_SETTINGS.exclude_inlinks)
          .onChange(async (value) => {
            await saveConnections({ exclude_inlinks: value });
          });
      });

    new Setting(section)
      .setName('Exclude outlinks')
      .setDesc('Hide notes that the current note already links to.')
      .addToggle(toggle => {
        toggle
          .setValue(cs().exclude_outlinks ?? DEFAULT_CONNECTIONS_SETTINGS.exclude_outlinks)
          .onChange(async (value) => {
            await saveConnections({ exclude_outlinks: value });
          });
      });

    new Setting(section)
      .setName('Hide frontmatter blocks')
      .setDesc('In block mode, skip results where the only matching content is the note\'s frontmatter (properties, tags, title).')
      .addToggle(toggle => {
        toggle
          .setValue(cs().exclude_frontmatter_blocks ?? DEFAULT_CONNECTIONS_SETTINGS.exclude_frontmatter_blocks)
          .onChange(async (value) => {
            await saveConnections({ exclude_frontmatter_blocks: value });
          });
      });

    // Scoring signals
    section.createEl('h5', { text: 'Scoring signals' });
    section.createEl('p', {
      text: 'These signals adjust result scores based on context. Changes take effect on the next panel refresh.',
      cls: 'nexus-settings-desc'
    });

    new Setting(section)
      .setName('Frontmatter-aware scoring')
      .setDesc('Boost results that share frontmatter values (tags, type, status) with the current note. +0.03 per match, up to +0.09.')
      .addToggle(toggle => {
        toggle
          .setValue(cs().frontmatter_scoring ?? DEFAULT_CONNECTIONS_SETTINGS.frontmatter_scoring)
          .onChange(async (value) => {
            await saveConnections({ frontmatter_scoring: value });
          });
      });

    new Setting(section)
      .setName('Co-citation scoring')
      .setDesc('Boost results that link to the same notes as the current note. +0.02 per shared outlink.')
      .addToggle(toggle => {
        toggle
          .setValue(cs().co_citation_scoring ?? DEFAULT_CONNECTIONS_SETTINGS.co_citation_scoring)
          .onChange(async (value) => {
            await saveConnections({ co_citation_scoring: value });
          });
      });

    new Setting(section)
      .setName('Path proximity scoring')
      .setDesc('Boost results in the same folder as the current note. +0.01.')
      .addToggle(toggle => {
        toggle
          .setValue(cs().path_proximity_scoring ?? DEFAULT_CONNECTIONS_SETTINGS.path_proximity_scoring)
          .onChange(async (value) => {
            await saveConnections({ path_proximity_scoring: value });
          });
      });
  }

  destroy(): void {
    // Nothing to clean up — no intervals or external callbacks
  }
}
