/**
 * Repair script: seed sync_state and populate conversations/messages from JSONL files.
 *
 * Run this with Obsidian CLOSED. After running, open Obsidian normally.
 * Obsidian will find sync_state, skip fullRebuild, and show all data.
 *
 * Usage: node scripts/repair_sqlite_cache.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const VAULT = 'C:/Users/middl/Documents/Obsidian/Michael';
const DATA_DIR = `${VAULT}/.obsidian/plugins/nexus/data`;
const DB_PATH = `${DATA_DIR}/cache.db`;
const DEVICE_ID = '98ed764c-6ac3-4a32-8bb5-30f70dce17a8';

function readJsonlEvents(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .filter(l => l.trim())
    .map(l => {
      try { return JSON.parse(l); }
      catch (e) { console.warn('  WARN: skipping malformed line'); return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function applyConversationEvents(db, events) {
  let convId = null;

  for (const event of events) {
    try {
      switch (event.type) {
        case 'metadata': {
          if (!event.data?.id) break;
          const d = event.data;
          const settings = d.settings;
          const chatSettings = settings?.chatSettings;
          const workspaceId = settings?.workspaceId ?? chatSettings?.workspaceId ?? null;
          const sessionId = settings?.sessionId ?? chatSettings?.sessionId ?? null;
          db.prepare(`
            INSERT OR REPLACE INTO conversations
            (id, title, created, updated, vaultName, messageCount, metadataJson, workspaceId, sessionId, workflowId, runTrigger, scheduledFor, runKey)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            d.id,
            d.title ?? 'Untitled',
            d.created ?? event.timestamp,
            d.created ?? event.timestamp,
            d.vault ?? '',
            0,
            settings ? JSON.stringify(settings) : null,
            workspaceId,
            sessionId,
            settings?.workflowId ?? null,
            settings?.runTrigger ?? null,
            settings?.scheduledFor ?? null,
            settings?.runKey ?? null
          );
          convId = d.id;
          break;
        }

        case 'conversation_updated': {
          if (!convId || !event.data) break;
          const u = event.data;
          const cols = [];
          const vals = [];
          if (u.title !== undefined) { cols.push('title = ?'); vals.push(u.title); }
          if (u.updated !== undefined) { cols.push('updated = ?'); vals.push(u.updated); }
          if (u.settings !== undefined) { cols.push('metadataJson = ?'); vals.push(JSON.stringify(u.settings)); }
          if (cols.length > 0) {
            vals.push(convId);
            db.prepare(`UPDATE conversations SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
          }
          break;
        }

        case 'message': {
          if (!convId || !event.data?.id) break;
          const m = event.data;
          db.prepare(`
            INSERT OR REPLACE INTO messages
            (id, conversationId, role, content, timestamp, state, toolCallsJson, toolCallId, reasoningContent, sequenceNumber, alternativesJson, activeAlternativeIndex)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            m.id,
            convId,
            m.role ?? 'user',
            m.content ?? '',
            m.timestamp ?? event.timestamp,
            m.state ?? 'complete',
            m.toolCalls ? JSON.stringify(m.toolCalls) : null,
            m.toolCallId ?? null,
            m.reasoningContent ?? null,
            m.sequenceNumber ?? 0,
            m.alternatives ? JSON.stringify(m.alternatives) : null,
            m.activeAlternativeIndex ?? 0
          );
          // Update message count
          db.prepare(`UPDATE conversations SET messageCount = (SELECT COUNT(*) FROM messages WHERE conversationId = ?) WHERE id = ?`).run(convId, convId);
          break;
        }

        case 'message_updated': {
          if (!convId || !event.data?.id) break;
          const mu = event.data;
          const cols = [];
          const vals = [];
          if (mu.content !== undefined) { cols.push('content = ?'); vals.push(mu.content); }
          if (mu.state !== undefined) { cols.push('state = ?'); vals.push(mu.state); }
          if (mu.toolCalls !== undefined) { cols.push('toolCallsJson = ?'); vals.push(JSON.stringify(mu.toolCalls)); }
          if (mu.reasoningContent !== undefined) { cols.push('reasoningContent = ?'); vals.push(mu.reasoningContent); }
          if (mu.alternatives !== undefined) { cols.push('alternativesJson = ?'); vals.push(JSON.stringify(mu.alternatives)); }
          if (mu.activeAlternativeIndex !== undefined) { cols.push('activeAlternativeIndex = ?'); vals.push(mu.activeAlternativeIndex); }
          if (cols.length > 0) {
            vals.push(mu.id);
            db.prepare(`UPDATE messages SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
          }
          break;
        }

        case 'message_deleted': {
          if (!event.data?.id) break;
          db.prepare(`DELETE FROM messages WHERE id = ?`).run(event.data.id);
          break;
        }

        // Skip branch events (legacy)
        case 'branch_created':
        case 'branch_message':
        case 'branch_message_updated':
        case 'branch_updated':
          break;
      }
    } catch (err) {
      console.warn(`  WARN: error applying ${event.type} event:`, err.message);
    }
  }
}

function main() {
  console.log('=== Nexus SQLite Cache Repair ===');
  console.log(`DB: ${DB_PATH}`);
  console.log(`DeviceId: ${DEVICE_ID}`);
  console.log('');

  if (!fs.existsSync(DB_PATH)) {
    console.error('ERROR: cache.db not found at', DB_PATH);
    process.exit(1);
  }

  const db = new Database(DB_PATH);

  // Enable WAL mode for safety
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ── Conversations ──────────────────────────────────────────────────────────
  const convDir = `${DATA_DIR}/conversations`;
  const convFiles = fs.readdirSync(convDir).filter(f => f.endsWith('.jsonl'));
  console.log(`Processing ${convFiles.length} conversation files...`);

  let added = 0;
  let skipped = 0;

  for (const file of convFiles) {
    const match = file.match(/conv_(.+)\.jsonl$/);
    if (!match) continue;
    const convId = match[1];

    const events = readJsonlEvents(path.join(convDir, file));

    // Skip deleted conversations
    if (events.some(e => e.type === 'conversation_deleted')) {
      console.log(`  SKIP (deleted): ${file}`);
      skipped++;
      continue;
    }

    // Skip if no metadata event (can't create conversation row)
    if (!events.some(e => e.type === 'metadata')) {
      console.log(`  SKIP (no metadata): ${file}`);
      skipped++;
      continue;
    }

    // Check if already in DB
    const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(convId);
    if (existing) {
      console.log(`  EXISTS: ${file}`);
      continue;
    }

    try {
      db.transaction(() => applyConversationEvents(db, events))();
      const conv = db.prepare('SELECT title, messageCount FROM conversations WHERE id = ?').get(convId);
      console.log(`  ADDED: ${file} → "${conv?.title}" (${conv?.messageCount} messages)`);
      added++;
    } catch (err) {
      console.error(`  ERROR: ${file}:`, err.message);
    }
  }

  console.log(`\nConversations: ${added} added, ${skipped} skipped`);

  // ── Seed sync_state ────────────────────────────────────────────────────────
  const existingSyncState = db.prepare('SELECT * FROM sync_state WHERE deviceId = ?').get(DEVICE_ID);
  if (existingSyncState) {
    console.log('\nsync_state already has a row for this device — skipping seed');
  } else {
    db.prepare(`
      INSERT INTO sync_state (deviceId, lastEventTimestamp, syncedFilesJson)
      VALUES (?, ?, ?)
    `).run(DEVICE_ID, Date.now(), '{}');
    console.log('\nsync_state seeded with deviceId:', DEVICE_ID);
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  const wsCount = db.prepare('SELECT COUNT(*) c FROM workspaces').get().c;
  const convCount = db.prepare('SELECT COUNT(*) c FROM conversations').get().c;
  const msgCount = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  const syncRows = db.prepare('SELECT COUNT(*) c FROM sync_state').get().c;

  console.log('\n=== Final DB state ===');
  console.log(`workspaces:   ${wsCount}`);
  console.log(`conversations: ${convCount}`);
  console.log(`messages:     ${msgCount}`);
  console.log(`sync_state:   ${syncRows} row(s)`);

  db.close();
  console.log('\nDone. Open Obsidian — data should appear immediately.');
}

main();
