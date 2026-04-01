/**
 * Location: src/core/ui/SemanticPanelUIManager.ts
 * Purpose: View and command registration for the Nexus semantic panel.
 *
 * Follows the TaskBoardUIManager pattern:
 * - registerViewEarly() — called at startup to ensure the view type is registered
 *   before any leaf restoration occurs.
 * - registerSemanticPanelUI() — idempotent; registers the command.
 * - openSemanticPanel() — opens or focuses the panel leaf.
 *
 * The onSendToChat callback is provided by ChatView.addSemanticContext and is
 * forwarded into each SemanticPanelView instance when it is created.
 */

import type { App, Plugin } from 'obsidian';
import type NexusPlugin from '../../main';
import { SEMANTIC_PANEL_VIEW_TYPE } from '../../constants/branding';
import { openSemanticPanelView } from '../../ui/semanticPanel/SemanticPanelNavigation';
import type { SemanticContextPayload } from '../../ui/semanticPanel/SemanticPanelView';

export interface SemanticPanelUIManagerConfig {
  plugin: Plugin;
  app: App;
}

export class SemanticPanelUIManager {
  private viewRegistered = false;
  private commandRegistered = false;
  private onSendToChat: ((payload: SemanticContextPayload) => void) | null = null;

  constructor(private config: SemanticPanelUIManagerConfig) {}

  /**
   * Wire the Send-to-Chat callback from ChatView.
   * Must be called before any panel opens so the callback is available at construction.
   */
  setSendToChatCallback(fn: (payload: SemanticContextPayload) => void): void {
    this.onSendToChat = fn;
  }

  async registerViewEarly(): Promise<void> {
    if (this.viewRegistered) return;

    try {
      const { plugin } = this.config;
      const { SemanticPanelView } = await import('../../ui/semanticPanel/SemanticPanelView');
      const self = this;

      plugin.registerView(SEMANTIC_PANEL_VIEW_TYPE, (leaf) => {
        // Always pass a forwarding function so the button renders immediately.
        // The inner callback may be wired later (e.g. after ChatView opens).
        return new SemanticPanelView(leaf, plugin as NexusPlugin, (payload) => {
          self.onSendToChat?.(payload);
        });
      });

      this.viewRegistered = true;
    } catch (error) {
      console.error('[SemanticPanelUIManager] Failed to register view:', error);
    }
  }

  async registerSemanticPanelUI(): Promise<void> {
    if (this.commandRegistered) return;

    try {
      await this.registerViewEarly();

      this.config.plugin.addCommand({
        id: 'open-semantic-panel',
        name: 'Open Semantic Panel',
        callback: () => {
          void this.openSemanticPanel();
        }
      });

      this.config.plugin.addCommand({
        id: 'refresh-semantic-panel',
        name: 'Refresh Semantic Panel',
        callback: () => {
          void this.refreshSemanticPanel();
        }
      });

      this.commandRegistered = true;
    } catch (error) {
      console.error('[SemanticPanelUIManager] Failed to register commands:', error);
    }
  }

  async openSemanticPanel(): Promise<void> {
    const side = (this.config.plugin as unknown as {
      settings?: { connections?: { connections_view_location?: 'left' | 'right' } };
    }).settings?.connections?.connections_view_location ?? 'right';
    await openSemanticPanelView(this.config.app, side);
  }

  private async refreshSemanticPanel(): Promise<void> {
    const leaves = this.config.app.workspace.getLeavesOfType(SEMANTIC_PANEL_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view && typeof (view as unknown as { onActiveFileChange?(): Promise<void> }).onActiveFileChange === 'function') {
        await (view as unknown as { onActiveFileChange(): Promise<void> }).onActiveFileChange();
      }
    }
  }
}
