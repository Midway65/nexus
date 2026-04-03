/**
 * Location: src/services/embeddings/EmbeddingUtils.ts
 * Purpose: Shared utility functions for the embedding pipeline.
 *
 * Centralizes content preprocessing (frontmatter stripping, whitespace
 * normalization) and hashing (DJB2) so that all consumers -- EmbeddingService,
 * IndexingQueue, QAPairBuilder -- use the same canonical implementations.
 *
 * Relationships:
 * - Used by EmbeddingService, IndexingQueue, QAPairBuilder
 * - Exported via src/services/embeddings/index.ts barrel
 */

/**
 * Preprocess note / conversation content before embedding or hashing.
 *
 * Steps:
 * 1. Strip YAML frontmatter (delimited by `---`)
 * 2. Remove Obsidian image embeds (`![[...]]`)
 * 3. Resolve wiki-link aliases (`[[path|alias]]` -> `alias`)
 * 4. Resolve plain wiki-links (`[[path]]` -> `path`)
 * 5. Normalize inline whitespace (tabs, multiple spaces) but preserve newlines
 * 6. Return null if result is shorter than 10 characters
 * 7. Truncate to maxChars (caller supplies model-appropriate limit)
 *
 * Newlines are intentionally preserved. Collapsing them to spaces destroys
 * heading/paragraph/list structure that embedding models rely on — a smaller
 * model with structure intact outperforms a larger model on flattened text.
 *
 * @param content  - Raw markdown/text content
 * @param maxChars - Character limit matched to the model's token window.
 *                   MiniLM/BGE (512 tok) → 2000. Nomic (8192 tok) → 8000.
 *                   Defaults to 2000 for backward compat with trace embeddings.
 * @returns Processed content string, or null if too short after processing
 */
export function preprocessContent(content: string, maxChars = 2000): string | null {
  // Include frontmatter as readable key:value lines — stripping it discards all the
  // semantic signal (tags, type, lcsh_related, domain, etc.) from metadata-heavy notes.
  // Only the '---' delimiters are removed; the YAML key-value pairs remain visible
  // to the embedding model.
  let processed = content.replace(/^---\n([\s\S]*?)\n---\n?/, '$1\n');

  // Strip image embeds, keep link text
  processed = processed
    .replace(/!\[\[.*?\]\]/g, '')                           // Obsidian image embeds
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')          // [[path|alias]] -> alias
    .replace(/\[\[([^\]]+)\]\]/g, '$1');                    // [[path]] -> path

  // Normalize inline whitespace only — preserve newlines so heading/paragraph
  // structure remains visible to the embedding model.
  processed = processed
    .replace(/\t+/g, ' ')          // tabs → single space
    .replace(/ {2,}/g, ' ')        // multiple spaces → single space
    .replace(/\n{3,}/g, '\n\n')    // 3+ blank lines → one blank line
    .trim();

  // Skip if too short
  if (processed.length < 10) {
    return null;
  }

  return processed.length > maxChars
    ? processed.slice(0, maxChars)
    : processed;
}

/**
 * DJB2 hash function for string content.
 *
 * A fast, deterministic, non-cryptographic hash suitable for change detection.
 * Produces a hex string from the hash value. Collisions are acceptable since
 * this is only used to detect when content has changed, not for security.
 *
 * This is the canonical implementation. All callers in the embedding pipeline
 * should use this function rather than rolling their own hash.
 *
 * @param input - The string to hash
 * @returns Hex string representation of the hash
 */
export function hashContent(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    // hash * 33 + charCode (using bit shift for multiplication)
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit integer, then to hex string
  return (hash >>> 0).toString(16);
}

/**
 * Extract all [[wiki-links]] from a text string.
 *
 * Matches the Obsidian wiki-link patterns:
 * - `[[note name]]` -> "note name"
 * - `[[note name|alias]]` -> "note name" (returns the target, not the alias)
 *
 * @param text - Text to scan for wiki-links
 * @returns Deduplicated array of link targets (lowercased)
 */
export function extractWikiLinks(text: string): string[] {
  const pattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const links = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    links.add(match[1].toLowerCase().trim());
  }

  return Array.from(links);
}
