/**
 * Location: src/services/embeddings/NoteChunker.ts
 * Purpose: Heading-aware chunking for semantic note indexing.
 *
 * This is separate from ContentChunker (used for conversation QA pairs).
 * ContentChunker must NOT be modified — it uses fixed-size overlapping windows
 * optimized for short-context QA embedding. NoteChunker uses structural boundaries.
 *
 * Strategy:
 * 1. Strip YAML frontmatter from the semantic body.
 * 2. Split by heading sections (# ## ###) when present.
 * 3. Within long sections, split by paragraph groups.
 * 4. Fall back to fixed-size character splitting only for very long prose.
 * 5. Each chunk is enriched with title + heading context before embedding.
 *
 * Chunk identity:
 * - contentHash is the canonical identity signal (not position).
 * - chunkIndex is the storage key for ordering and stale pruning.
 * - After upsert, any rows with chunkIndex >= newChunkCount are pruned.
 */

import { hashContent } from './EmbeddingUtils';

export interface NoteChunk {
  /** Position-based storage key (0-based). Used for ordering and stale pruning. */
  chunkIndex: number;
  /** Nearest heading above this chunk, or null if in the preamble. */
  heading: string | null;
  /** Character offset in the stripped note body (before enrichment). */
  charOffset: number;
  /** Hash of the raw chunk text for stale detection. */
  contentHash: string;
  /** First 150 chars for UI display. */
  contentPreview: string;
  /** Title + heading + content used for embedding. */
  enrichedText: string;
}

const MAX_CHUNK_CHARS = 1200;
const PARAGRAPH_OVERLAP_CHARS = 0; // No overlap for heading-based chunks
const FIXED_OVERLAP_CHARS = 100;   // Small overlap only for fixed-size fallback

/**
 * Produce heading-aware chunks from a note's markdown content.
 *
 * @param notePath - Vault-relative path, used to derive the display title.
 * @param content  - Raw markdown content including frontmatter.
 * @returns Array of NoteChunk objects ready for embedding.
 */
export function chunkNote(notePath: string, content: string): NoteChunk[] {
  const title = deriveTitle(notePath);
  const body = stripFrontmatter(content);

  if (!body.trim()) return [];

  // Split into sections by headings
  const sections = splitBySections(body);

  const chunks: NoteChunk[] = [];
  let globalOffset = 0;

  for (const section of sections) {
    const subChunks = splitSectionIntoChunks(section.text);

    for (const text of subChunks) {
      const raw = text.trim();
      if (raw.length < 20) {
        globalOffset += text.length;
        continue;
      }

      const enriched = buildEnrichedText(title, section.heading, raw);
      const chunk: NoteChunk = {
        chunkIndex: chunks.length,
        heading: section.heading,
        charOffset: globalOffset,
        contentHash: hashContent(raw),
        contentPreview: raw.slice(0, 150),
        enrichedText: enriched,
      };
      chunks.push(chunk);
      globalOffset += text.length;
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deriveTitle(notePath: string): string {
  const base = notePath.split('/').pop() ?? notePath;
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

function stripFrontmatter(content: string): string {
  // Strip YAML frontmatter delimited by ---
  return content.replace(/^---[\s\S]*?---\n?/, '');
}

interface Section {
  heading: string | null;
  text: string;
}

function splitBySections(body: string): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      // Flush previous section
      const text = currentLines.join('\n').trim();
      if (text) {
        sections.push({ heading: currentHeading, text });
      }
      currentHeading = headingMatch[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush final section
  const text = currentLines.join('\n').trim();
  if (text) {
    sections.push({ heading: currentHeading, text });
  }

  // If no headings found, return the full body as one section
  if (sections.length === 0) {
    return [{ heading: null, text: body.trim() }];
  }

  return sections;
}

function splitSectionIntoChunks(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) {
    return [text];
  }

  // Try paragraph-based splitting first
  const paragraphs = text.split(/\n\n+/);
  const groups: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? current + '\n\n' + para : para;
    if (candidate.length > MAX_CHUNK_CHARS && current) {
      groups.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) groups.push(current);

  // If any group is still too large, fall back to fixed-size splitting
  const result: string[] = [];
  for (const group of groups) {
    if (group.length <= MAX_CHUNK_CHARS) {
      result.push(group);
    } else {
      result.push(...fixedSizeSplit(group));
    }
  }

  return result;
}

function fixedSizeSplit(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + MAX_CHUNK_CHARS, text.length);
    chunks.push(text.slice(start, end));
    start = end - FIXED_OVERLAP_CHARS;
    if (start >= text.length - FIXED_OVERLAP_CHARS) break;
  }
  return chunks;
}

function buildEnrichedText(
  title: string,
  heading: string | null,
  content: string,
): string {
  const parts = [`Title: ${title}`];
  if (heading) parts.push(`Heading: ${heading}`);
  parts.push(`Content: ${content}`);
  return parts.join('\n');
}
