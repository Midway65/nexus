/**
 * Location: src/settings/tabs/ConnectionsTab.ts
 * Purpose: Connections settings tab — Tier 1 ingestion exclusions and Tier 2 result filters.
 *
 * Group A (Tier 1) — Indexing exclusions: paths/patterns and minimum content length
 *   excluded from the semantic index. Changes call coordinator.reconcileIndex() to
 *   purge/add notes without a full rebuild.
 *
 * Group B (Tier 2) — Result filters: applied inside SemanticPanelView after retrieval.
 *   No re-indexing required — changes take effect on the next panel refresh.
 *
 * Group C — Panel UX: sidebar location and results limit.
 */

import { App, Setting, Notice, Platform } from 'obsidian';
import type { SettingsRouter } from '../SettingsRouter';
import type { EmbeddingManager } from '../../services/embeddings/EmbeddingManager';
import type { Settings } from '../../settings';
import { DEFAULT_CONNECTIONS_SETTINGS } from '../../ui/semanticPanel/ConnectionsSettings';

export interface ConnectionsTabConfig {
  app: App;
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

    this.renderPanelSection();
    await this.renderTier1Section();
    this.renderTier2Section();

    if (!Platform.isDesktop) {
      const warn = this.container.createEl('p', { cls: 'nexus-settings-desc' });
      warn.textContent = 'Semantic indexing and the connections panel are only available on the desktop app.';
    }
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

  private async renderTier1Section(): Promise<void> {
    const section = this.container.createDiv('nexus-settings-section');
    section.createEl('h4', { text: 'Indexing exclusions' });
    section.createEl('p', {
      text: 'Hidden folders (.nexus/, .obsidian/) and Obsidian\'s own excluded files are always skipped. Everything else is indexed by default — use the controls below to exclude what you don\'t want. Click Reconcile after making changes.',
      cls: 'nexus-settings-desc'
    });

    const s = this.config.settings.settings;
    const noteService = this.config.embeddingManager?.getService?.()?.getNoteEmbeddingService?.();
    const currentMinLength = noteService ? await noteService.getMinIndexLength() : 50;

    // ---- Minimum content length ----
    new Setting(section)
      .setName('Minimum content length')
      .setDesc('Skip notes shorter than this many characters (after stripping frontmatter). Excludes stubs and empty templates. Requires Reconcile to apply to already-indexed notes.')
      .addText(text => {
        text
          .setValue(String(currentMinLength))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0 && noteService) {
              await noteService.setConfigValue('minIndexLength', String(parsed));
            }
          });
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.style.width = '80px';
      });

    // ---- Excluded notes (file picker) ----
    const notesHeader = section.createDiv('csr-notes-header');
    notesHeader.createEl('span', { text: 'Excluded notes' });
    const addBtn = notesHeader.createEl('button', { cls: 'csr-add-btn', text: '+ Add' });
    addBtn.setAttribute('aria-label', 'Add note to exclusion list');

    section.createEl('p', {
      text: 'Specific notes to exclude. Use folder & pattern rules below for bulk exclusions.',
      cls: 'nexus-settings-desc'
    });

    const listEl = section.createDiv('csr-notes-list');

    const renderExcludedList = () => {
      listEl.empty();
      const paths = s.indexingExcludedPaths ?? [];
      if (paths.length === 0) {
        listEl.createDiv({ cls: 'csr-notes-empty', text: 'No notes excluded' });
        return;
      }
      paths.forEach((path, i) => {
        const item = listEl.createDiv('csr-note-item');
        item.createSpan({ cls: 'csr-note-path', text: path });
        const removeBtn = item.createEl('button', { cls: 'csr-note-remove', text: '×' });
        removeBtn.setAttribute('aria-label', `Remove ${path} from exclusions`);
        removeBtn.addEventListener('click', async () => {
          s.indexingExcludedPaths = (s.indexingExcludedPaths ?? []).filter((_, idx) => idx !== i);
          await this.config.settings.saveSettings();
          renderExcludedList();
        });
      });
    };
    renderExcludedList();

    addBtn.addEventListener('click', async () => {
      const { FilePickerRenderer } = await import('../../components/workspace/FilePickerRenderer');
      const selected = await FilePickerRenderer.openModal(this.config.app, {
        title: 'Exclude notes from index',
        excludePaths: s.indexingExcludedPaths ?? []
      });
      if (selected.length > 0) {
        s.indexingExcludedPaths = [...(s.indexingExcludedPaths ?? []), ...selected];
        await this.config.settings.saveSettings();
        renderExcludedList();
      }
    });

    // ---- Folder & pattern rules ----
    new Setting(section)
      .setName('Folder & pattern rules')
      .setDesc('One rule per line. Folder paths end with / · Wildcards use * · Plain text matches any path containing it. Examples: Templates/  ·  Daily/2024/**  ·  .excalidraw')
      .addTextArea(area => {
        area
          .setPlaceholder('Templates/\nDaily/\nArchive/2024/**')
          .setValue((s.indexingExcludedPatterns ?? []).join('\n'))
          .onChange(async (value) => {
            const patterns = value.split('\n').map(l => l.trim()).filter(Boolean);
            s.indexingExcludedPatterns = patterns.length > 0 ? patterns : undefined;
            await this.config.settings.saveSettings();
          });
        area.inputEl.rows = 4;
        area.inputEl.cols = 40;
        area.inputEl.style.fontFamily = 'var(--font-monospace)';
      });

    // ---- Reconcile ----
    new Setting(section)
      .setName('Apply changes')
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
    section.createEl('p', {
      text: 'These filters hide results in the panel without removing notes from the index. Changes take effect on the next panel refresh. Exclude always wins over include.',
      cls: 'nexus-settings-desc'
    });

    const s = this.config.settings.settings;
    const cs = () => (s.connections ?? {});
    const saveConnections = async (patch: Partial<typeof DEFAULT_CONNECTIONS_SETTINGS>) => {
      s.connections = { ...DEFAULT_CONNECTIONS_SETTINGS, ...cs(), ...patch };
      await this.config.settings.saveSettings();
    };

    // ---- Include paths (file picker + pattern rules) ----
    const includeHeader = section.createDiv('csr-notes-header');
    includeHeader.createEl('span', { text: 'Show only — notes' });
    const includeAddBtn = includeHeader.createEl('button', { cls: 'csr-add-btn', text: '+ Add' });
    includeAddBtn.setAttribute('aria-label', 'Add note to include filter');

    section.createEl('p', {
      text: 'Only these specific notes will appear in results. Leave empty to show all.',
      cls: 'nexus-settings-desc'
    });

    const includeListEl = section.createDiv('csr-notes-list');

    const renderIncludeList = () => {
      includeListEl.empty();
      const paths = cs().include_paths ?? [];
      if (paths.length === 0) {
        includeListEl.createDiv({ cls: 'csr-notes-empty', text: 'No notes added' });
        return;
      }
      paths.forEach((path, i) => {
        const item = includeListEl.createDiv('csr-note-item');
        item.createSpan({ cls: 'csr-note-path', text: path });
        const removeBtn = item.createEl('button', { cls: 'csr-note-remove', text: '×' });
        removeBtn.setAttribute('aria-label', `Remove ${path} from include filter`);
        removeBtn.addEventListener('click', async () => {
          const updated = (cs().include_paths ?? []).filter((_, idx) => idx !== i);
          await saveConnections({ include_paths: updated });
          renderIncludeList();
        });
      });
    };
    renderIncludeList();

    includeAddBtn.addEventListener('click', async () => {
      const { FilePickerRenderer } = await import('../../components/workspace/FilePickerRenderer');
      const selected = await FilePickerRenderer.openModal(this.config.app, {
        title: 'Include notes in results',
        excludePaths: cs().include_paths ?? []
      });
      if (selected.length > 0) {
        await saveConnections({ include_paths: [...(cs().include_paths ?? []), ...selected] });
        renderIncludeList();
      }
    });

    new Setting(section)
      .setName('Show only — folder & pattern rules')
      .setDesc('One rule per line. Only results whose path matches at least one rule are shown. Folder paths end with / · Plain text is a substring match. Leave blank to show all.')
      .addTextArea(area => {
        area
          .setPlaceholder('Projects/\nResearch/')
          .setValue(cs().include_filter ?? DEFAULT_CONNECTIONS_SETTINGS.include_filter)
          .onChange(async (value) => {
            await saveConnections({ include_filter: value });
          });
        area.inputEl.rows = 3;
        area.inputEl.cols = 40;
        area.inputEl.style.fontFamily = 'var(--font-monospace)';
      });

    // ---- Exclude paths (file picker + pattern rules) ----
    const excludeHeader = section.createDiv('csr-notes-header');
    excludeHeader.createEl('span', { text: 'Hide — notes' });
    const excludeAddBtn = excludeHeader.createEl('button', { cls: 'csr-add-btn', text: '+ Add' });
    excludeAddBtn.setAttribute('aria-label', 'Add note to exclude filter');

    section.createEl('p', {
      text: 'These specific notes will never appear in results.',
      cls: 'nexus-settings-desc'
    });

    const excludeListEl = section.createDiv('csr-notes-list');

    const renderExcludeList = () => {
      excludeListEl.empty();
      const paths = cs().exclude_paths ?? [];
      if (paths.length === 0) {
        excludeListEl.createDiv({ cls: 'csr-notes-empty', text: 'No notes added' });
        return;
      }
      paths.forEach((path, i) => {
        const item = excludeListEl.createDiv('csr-note-item');
        item.createSpan({ cls: 'csr-note-path', text: path });
        const removeBtn = item.createEl('button', { cls: 'csr-note-remove', text: '×' });
        removeBtn.setAttribute('aria-label', `Remove ${path} from exclude filter`);
        removeBtn.addEventListener('click', async () => {
          const updated = (cs().exclude_paths ?? []).filter((_, idx) => idx !== i);
          await saveConnections({ exclude_paths: updated });
          renderExcludeList();
        });
      });
    };
    renderExcludeList();

    excludeAddBtn.addEventListener('click', async () => {
      const { FilePickerRenderer } = await import('../../components/workspace/FilePickerRenderer');
      const selected = await FilePickerRenderer.openModal(this.config.app, {
        title: 'Hide notes from results',
        excludePaths: cs().exclude_paths ?? []
      });
      if (selected.length > 0) {
        await saveConnections({ exclude_paths: [...(cs().exclude_paths ?? []), ...selected] });
        renderExcludeList();
      }
    });

    new Setting(section)
      .setName('Hide — folder & pattern rules')
      .setDesc('One rule per line. Results whose path matches any rule are hidden. Folder paths end with / · Plain text is a substring match. Overrides the include list.')
      .addTextArea(area => {
        area
          .setPlaceholder('Daily/\nTemplates/')
          .setValue(cs().exclude_filter ?? DEFAULT_CONNECTIONS_SETTINGS.exclude_filter)
          .onChange(async (value) => {
            await saveConnections({ exclude_filter: value });
          });
        area.inputEl.rows = 3;
        area.inputEl.cols = 40;
        area.inputEl.style.fontFamily = 'var(--font-monospace)';
      });

    // Frontmatter filters — chip UI backed by vault-enumerated keys/values
    const vaultProps = this.collectVaultProperties();

    this.renderFrontmatterChipSection(section, {
      label: 'Show only — properties',
      hint: 'Only show results that have at least one matching property. Leave empty to show all.',
      rules: cs().frontmatter_include_rules ?? [],
      formId: 'fm-include',
      vaultProps,
      onSave: async (rules) => { await saveConnections({ frontmatter_include_rules: rules }); },
    });

    this.renderFrontmatterChipSection(section, {
      label: 'Hide — properties',
      hint: 'Hide results that have any matching property.',
      rules: cs().frontmatter_exclude_rules ?? [],
      formId: 'fm-exclude',
      vaultProps,
      onSave: async (rules) => { await saveConnections({ frontmatter_exclude_rules: rules }); },
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

  // ---------------------------------------------------------------------------
  // Vault property enumeration (public Obsidian API only)
  // ---------------------------------------------------------------------------

  /**
   * Enumerate all frontmatter keys and their known values across the vault
   * using metadataCache.getFileCache() — reads from the already-in-memory cache,
   * no disk I/O. Called once at settings-tab render time.
   */
  private collectVaultProperties(): Map<string, Set<string>> {
    const props = new Map<string, Set<string>>();
    try {
      for (const file of this.config.app.vault.getMarkdownFiles()) {
        const fm = this.config.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm) continue;
        for (const [key, val] of Object.entries(fm)) {
          if (key === 'position') continue; // Obsidian internal field
          if (!props.has(key)) props.set(key, new Set());
          const values = Array.isArray(val) ? val : [val];
          for (const v of values) {
            if (v != null && v !== '') props.get(key)!.add(String(v));
          }
        }
      }
    } catch { /* metadataCache not ready — return empty map */ }
    return props;
  }

  // ---------------------------------------------------------------------------
  // Frontmatter chip section renderer
  // ---------------------------------------------------------------------------

  private renderFrontmatterChipSection(
    parent: HTMLElement,
    opts: {
      label: string;
      hint: string;
      rules: string[];
      formId: string;
      vaultProps: Map<string, Set<string>>;
      onSave: (rules: string[]) => Promise<void>;
    },
  ): void {
    // Mutable working copy so the form can read current state without re-reading settings
    let current = [...opts.rules];

    // Header row
    const header = parent.createDiv('csr-notes-header');
    header.createEl('span', { text: opts.label });
    const addBtn = header.createEl('button', { cls: 'csr-add-btn', text: '+ Add' });
    addBtn.setAttribute('aria-label', `Add property rule to ${opts.label}`);

    parent.createEl('p', { text: opts.hint, cls: 'nexus-settings-desc' });

    // Chip list
    const listEl = parent.createDiv('csr-notes-list');

    const renderChips = () => {
      listEl.empty();
      if (current.length === 0) {
        listEl.createDiv({ cls: 'csr-notes-empty', text: 'No rules added' });
        return;
      }
      current.forEach((rule, i) => {
        const item = listEl.createDiv('csr-note-item');
        item.createSpan({ cls: 'csr-note-path nexus-fm-chip-label', text: rule });
        const removeBtn = item.createEl('button', { cls: 'csr-note-remove', text: '×' });
        removeBtn.setAttribute('aria-label', `Remove rule ${rule}`);
        removeBtn.addEventListener('click', async () => {
          current = current.filter((_, idx) => idx !== i);
          await opts.onSave(current);
          renderChips();
        });
      });
    };
    renderChips();

    // Inline add form (hidden until + Add is clicked)
    const form = parent.createDiv({ cls: 'nexus-fm-add-form' });
    form.style.display = 'none';

    const keyListId = `${opts.formId}-keys`;
    const valListId = `${opts.formId}-vals`;

    const keyInput = form.createEl('input', { cls: 'nexus-fm-key-input' });
    keyInput.type = 'text';
    keyInput.placeholder = 'property key';
    keyInput.setAttribute('list', keyListId);

    const keyDatalist = form.createEl('datalist');
    keyDatalist.id = keyListId;
    for (const key of Array.from(opts.vaultProps.keys()).sort()) {
      keyDatalist.createEl('option', { attr: { value: key } });
    }

    form.createEl('span', { cls: 'nexus-fm-sep', text: ':' });

    const valInput = form.createEl('input', { cls: 'nexus-fm-val-input' });
    valInput.type = 'text';
    valInput.placeholder = 'value (optional)';
    valInput.setAttribute('list', valListId);

    const valDatalist = form.createEl('datalist');
    valDatalist.id = valListId;

    // Repopulate value datalist when the key changes
    keyInput.addEventListener('input', () => {
      valDatalist.empty();
      const known = opts.vaultProps.get(keyInput.value);
      if (known) {
        for (const v of Array.from(known).sort()) {
          valDatalist.createEl('option', { attr: { value: v } });
        }
      }
      valInput.value = '';
    });

    const confirmBtn = form.createEl('button', { cls: 'nexus-fm-confirm-btn', text: 'Add' });
    const cancelBtn = form.createEl('button', { cls: 'nexus-fm-cancel-btn', text: 'Cancel' });

    const closeForm = () => {
      form.style.display = 'none';
      keyInput.value = '';
      valInput.value = '';
      valDatalist.empty();
    };

    confirmBtn.addEventListener('click', async () => {
      const key = keyInput.value.trim();
      if (!key) return;
      const val = valInput.value.trim();
      const rule = val ? `${key}:${val}` : key;
      if (!current.includes(rule)) {
        current = [...current, rule];
        await opts.onSave(current);
        renderChips();
      }
      closeForm();
    });

    cancelBtn.addEventListener('click', () => closeForm());

    // Enter in key input advances to value; Escape cancels
    keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); valInput.focus(); }
      if (e.key === 'Escape') closeForm();
    });
    valInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') confirmBtn.click();
      if (e.key === 'Escape') closeForm();
    });

    addBtn.addEventListener('click', () => {
      form.style.display = form.style.display === 'none' ? 'flex' : 'none';
      if (form.style.display === 'flex') keyInput.focus();
    });
  }

  destroy(): void {
    // Nothing to clean up — no intervals or external callbacks
  }
}
