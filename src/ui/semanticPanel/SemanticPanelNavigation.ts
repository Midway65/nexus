/**
 * Location: src/ui/semanticPanel/SemanticPanelNavigation.ts
 * Purpose: Navigation helper for the semantic panel — open or focus an existing leaf.
 *
 * Follows the same behavioral pattern as taskBoardNavigation.ts:
 * focus an existing panel leaf or create a new one in the right sidebar.
 */

import { App, WorkspaceLeaf } from 'obsidian';
import { SEMANTIC_PANEL_VIEW_TYPE } from '../../constants/branding';

export { SEMANTIC_PANEL_VIEW_TYPE };

/**
 * Open the semantic panel in the right sidebar, or focus it if already open.
 */
export async function openSemanticPanelView(app: App): Promise<WorkspaceLeaf | null> {
  // Look for an existing leaf of this type
  const existing = app.workspace.getLeavesOfType(SEMANTIC_PANEL_VIEW_TYPE);
  if (existing.length > 0) {
    app.workspace.revealLeaf(existing[0]);
    app.workspace.setActiveLeaf(existing[0], { focus: true });
    return existing[0];
  }

  // Create a new leaf in the right sidebar
  const leaf = app.workspace.getRightLeaf(false);
  if (!leaf) return null;

  await leaf.setViewState({
    type: SEMANTIC_PANEL_VIEW_TYPE,
    active: true,
  });
  app.workspace.revealLeaf(leaf);
  return leaf;
}
