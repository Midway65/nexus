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

import { Notice } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import type NexusPlugin from '../../main';
import { SEMANTIC_PANEL_VIEW_TYPE, CHAT_VIEW_TYPES } from '../../constants/branding';
import { openSemanticPanelView } from '../../ui/semanticPanel/SemanticPanelNavigation';
import type { SemanticContextPayload } from '../../ui/semanticPanel/SemanticPanelView';
import { SemanticSendModal } from '../../ui/semanticPanel/SemanticSendModal';

export interface SemanticPanelUIManagerConfig {
  plugin: Plugin;
  app: App;
}

type ChatViewRef = {
  addSemanticContext?(p: SemanticContextPayload): void;
  createChatWithContext?(p: SemanticContextPayload): Promise<void>;
  getCurrentTitle?(): string;
};

export class SemanticPanelUIManager {
  private viewRegistered = false;
  private commandRegistered = false;
  private onSendToChat: ((payload: SemanticContextPayload) => void) | null = null;
  /** Direct reference set when ChatView opens the panel via its own button. */
  private chatViewRef: ChatViewRef | null = null;

  constructor(private config: SemanticPanelUIManagerConfig) {}

  /**
   * Wire the Send-to-Chat callback from ChatView.
   * Must be called before any panel opens so the callback is available at construction.
   */
  setSendToChatCallback(fn: (payload: SemanticContextPayload) => void): void {
    this.onSendToChat = fn;
  }

  /**
   * Store a direct reference to the ChatView that opened the panel.
   * This avoids relying on workspace leaf scanning for the common case.
   */
  setCurrentChatView(view: unknown): void {
    this.chatViewRef = view as ChatViewRef;
  }

  clearCurrentChatView(): void {
    this.chatViewRef = null;
  }

  async registerViewEarly(): Promise<void> {
    if (this.viewRegistered) return;

    try {
      const { plugin } = this.config;
      const { SemanticPanelView } = await import('../../ui/semanticPanel/SemanticPanelView');
      const self = this;

      plugin.registerView(SEMANTIC_PANEL_VIEW_TYPE, (leaf) => {
        // Always pass a forwarding function so the button renders immediately.
        // When a chat view is open, show SemanticSendModal so the user can choose
        // between adding to the active conversation or spawning a new one.
        // Falls back to a Notice when no chat is open at all.
        return new SemanticPanelView(leaf, plugin as NexusPlugin, async (payload) => {
          const openModal = (chatView: ChatViewRef) => {
            const chatTitle = chatView.getCurrentTitle?.() ?? 'Nexus Chat';
            new SemanticSendModal(
              self.config.app,
              payload,
              chatTitle,
              (p) => chatView.addSemanticContext!(p),
              (p) => { chatView.createChatWithContext?.(p)?.catch(err => console.error('[Nexus] createChatWithContext error:', err)); }
            ).open();
          };

          // Tier 1: stored ref — set by ChatView.onOpen() or when panel opened via
          // the chat button.
          if (self.chatViewRef && typeof self.chatViewRef.addSemanticContext === 'function') {
            openModal(self.chatViewRef);
            return;
          }

          // Tier 2: workspace scan — panel opened via Ctrl+P or session restore.
          // Use iterateAllLeaves to catch leaves in any split or popup window.
          let found = false;
          let deferredLeaf: import('obsidian').WorkspaceLeaf | null = null;
          self.config.app.workspace.iterateAllLeaves((chatLeaf) => {
            if (found) return;
            if (chatLeaf.view?.getViewType?.() !== CHAT_VIEW_TYPES.current) return;
            const chatView = chatLeaf.view as unknown as ChatViewRef;
            if (typeof chatView.addSemanticContext === 'function') {
              found = true;
              openModal(chatView);
            } else if (!deferredLeaf) {
              deferredLeaf = chatLeaf; // Found but not yet instantiated
            }
          });
          if (found) return;

          // Tier 2b: deferred view — chat leaf exists but view is a stub.
          // Reveal the leaf to trigger ChatView.onOpen(), then wait briefly.
          if (deferredLeaf) {
            self.config.app.workspace.revealLeaf(deferredLeaf);
            await new Promise<void>(resolve => setTimeout(resolve, 300));
            if (self.chatViewRef && typeof self.chatViewRef.addSemanticContext === 'function') {
              openModal(self.chatViewRef);
              return;
            }
            // Check the leaf directly in case onOpen registered a different ref
            const chatView = (deferredLeaf as import('obsidian').WorkspaceLeaf).view as unknown as ChatViewRef;
            if (typeof chatView.addSemanticContext === 'function') {
              openModal(chatView);
              return;
            }
          }

          // Tier 3: no chat open.
          new Notice('Open a Nexus chat conversation first to use Send to Chat.', 3000);
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
