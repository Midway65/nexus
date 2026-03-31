/**
 * SQLite Schema for Hybrid Storage System
 * Location: src/database/schema/schema.ts
 * Purpose: Complete database schema with indexes and FTS
 * Current Version: 9
 *
 * IMPORTANT: When updating the schema:
 * 1. Update SCHEMA_SQL below for new installs
 * 2. Add a migration in SchemaMigrator.ts for existing databases
 * 3. Update CURRENT_SCHEMA_VERSION in SchemaMigrator.ts
 *
 * NOTE: Uses camelCase column names to match TypeScript/JavaScript conventions.
 */

export const SCHEMA_SQL = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  appliedAt INTEGER NOT NULL
);

-- ==================== WORKSPACES ====================

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rootFolder TEXT NOT NULL,
  created INTEGER NOT NULL,
  lastAccessed INTEGER NOT NULL,
  isActive INTEGER DEFAULT 1,
  isArchived INTEGER DEFAULT 0,
  contextJson TEXT,
  dedicatedAgentId TEXT,
  UNIQUE(name)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_name ON workspaces(name);
CREATE INDEX IF NOT EXISTS idx_workspaces_folder ON workspaces(rootFolder);
CREATE INDEX IF NOT EXISTS idx_workspaces_active ON workspaces(isActive);
CREATE INDEX IF NOT EXISTS idx_workspaces_archived ON workspaces(isArchived);
CREATE INDEX IF NOT EXISTS idx_workspaces_accessed ON workspaces(lastAccessed);

-- ==================== SESSIONS ====================

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  startTime INTEGER,
  endTime INTEGER,
  isActive INTEGER DEFAULT 0,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspaceId);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(isActive);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(startTime);

-- ==================== STATES ====================

CREATE TABLE IF NOT EXISTS states (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created INTEGER NOT NULL,
  stateJson TEXT,
  tagsJson TEXT,
  FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_states_session ON states(sessionId);
CREATE INDEX IF NOT EXISTS idx_states_workspace ON states(workspaceId);
CREATE INDEX IF NOT EXISTS idx_states_created ON states(created);

-- ==================== MEMORY TRACES ====================

CREATE TABLE IF NOT EXISTS memory_traces (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT,
  content TEXT,
  metadataJson TEXT,
  FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_traces_session ON memory_traces(sessionId);
CREATE INDEX IF NOT EXISTS idx_traces_workspace ON memory_traces(workspaceId);
CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON memory_traces(timestamp);
CREATE INDEX IF NOT EXISTS idx_traces_type ON memory_traces(type);

-- ==================== CONVERSATIONS ====================

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  vaultName TEXT NOT NULL,
  messageCount INTEGER DEFAULT 0,
  metadataJson TEXT,
  workspaceId TEXT,
  sessionId TEXT,
  workflowId TEXT,
  runTrigger TEXT,
  scheduledFor INTEGER,
  runKey TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversations_workspaceId ON conversations(workspaceId);
CREATE INDEX IF NOT EXISTS idx_conversations_sessionId ON conversations(sessionId);
CREATE INDEX IF NOT EXISTS idx_conversations_workflowId ON conversations(workflowId);
CREATE INDEX IF NOT EXISTS idx_conversations_scheduledFor ON conversations(scheduledFor);
CREATE INDEX IF NOT EXISTS idx_conversations_runKey ON conversations(runKey);

CREATE INDEX IF NOT EXISTS idx_conversations_vault ON conversations(vaultName);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created);

-- ==================== MESSAGES ====================

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  timestamp INTEGER NOT NULL,
  state TEXT,
  toolCallsJson TEXT,
  toolCallId TEXT,
  reasoningContent TEXT,
  sequenceNumber INTEGER NOT NULL,
  alternativesJson TEXT,
  activeAlternativeIndex INTEGER DEFAULT 0,
  FOREIGN KEY(conversationId) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversationId);
CREATE INDEX IF NOT EXISTS idx_messages_sequence ON messages(conversationId, sequenceNumber);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

-- ==================== FULL-TEXT SEARCH (FTS5) ====================
-- Using FTS5 for full-text search capabilities

CREATE VIRTUAL TABLE IF NOT EXISTS workspace_fts USING fts5(
  id,
  name,
  description,
  content='workspaces',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS workspace_fts_insert AFTER INSERT ON workspaces BEGIN
  INSERT INTO workspace_fts(rowid, id, name, description)
  VALUES (new.rowid, new.id, new.name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS workspace_fts_delete AFTER DELETE ON workspaces BEGIN
  INSERT INTO workspace_fts(workspace_fts, rowid, id, name, description)
  VALUES ('delete', old.rowid, old.id, old.name, old.description);
END;

CREATE TRIGGER IF NOT EXISTS workspace_fts_update AFTER UPDATE ON workspaces BEGIN
  INSERT INTO workspace_fts(workspace_fts, rowid, id, name, description)
  VALUES ('delete', old.rowid, old.id, old.name, old.description);
  INSERT INTO workspace_fts(rowid, id, name, description)
  VALUES (new.rowid, new.id, new.name, new.description);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
  id,
  title,
  content='conversations',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS conversation_fts_insert AFTER INSERT ON conversations BEGIN
  INSERT INTO conversation_fts(rowid, id, title)
  VALUES (new.rowid, new.id, new.title);
END;

CREATE TRIGGER IF NOT EXISTS conversation_fts_delete AFTER DELETE ON conversations BEGIN
  INSERT INTO conversation_fts(conversation_fts, rowid, id, title)
  VALUES ('delete', old.rowid, old.id, old.title);
END;

CREATE TRIGGER IF NOT EXISTS conversation_fts_update AFTER UPDATE ON conversations BEGIN
  INSERT INTO conversation_fts(conversation_fts, rowid, id, title)
  VALUES ('delete', old.rowid, old.id, old.title);
  INSERT INTO conversation_fts(rowid, id, title)
  VALUES (new.rowid, new.id, new.title);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  id,
  conversationId,
  content,
  reasoningContent,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS message_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_fts(rowid, id, conversationId, content, reasoningContent)
  VALUES (new.rowid, new.id, new.conversationId, new.content, new.reasoningContent);
END;

CREATE TRIGGER IF NOT EXISTS message_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO message_fts(message_fts, rowid, id, conversationId, content, reasoningContent)
  VALUES ('delete', old.rowid, old.id, old.conversationId, old.content, old.reasoningContent);
END;

CREATE TRIGGER IF NOT EXISTS message_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO message_fts(message_fts, rowid, id, conversationId, content, reasoningContent)
  VALUES ('delete', old.rowid, old.id, old.conversationId, old.content, old.reasoningContent);
  INSERT INTO message_fts(rowid, id, conversationId, content, reasoningContent)
  VALUES (new.rowid, new.id, new.conversationId, new.content, new.reasoningContent);
END;

-- ==================== SYNC STATE ====================

CREATE TABLE IF NOT EXISTS sync_state (
  deviceId TEXT PRIMARY KEY,
  lastEventTimestamp INTEGER NOT NULL,
  syncedFilesJson TEXT
);

CREATE TABLE IF NOT EXISTS applied_events (
  eventId TEXT PRIMARY KEY,
  appliedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_applied_events_time ON applied_events(appliedAt);

-- ==================== NOTE EMBEDDINGS (Plan 04 — v12, 768-dim Nomic default) ====================

-- Vector storage (vec0 virtual table) — 768-dim for nomic-embed-text-v1.5
CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings USING vec0(
  embedding float[768]
);

-- Metadata linked to vec0 by rowid — includes dimension column for multi-model support
CREATE TABLE IF NOT EXISTS embedding_metadata (
  rowid       INTEGER PRIMARY KEY,
  notePath    TEXT NOT NULL UNIQUE,
  contentHash TEXT NOT NULL,
  model       TEXT NOT NULL,
  dimension   INTEGER NOT NULL,
  created     INTEGER NOT NULL,
  updated     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_embed_meta_notePath ON embedding_metadata(notePath);
CREATE INDEX IF NOT EXISTS idx_embed_meta_updated ON embedding_metadata(updated);

-- Block-level embeddings (optional — enabled via embedding_config.blockIndexingEnabled)
CREATE VIRTUAL TABLE IF NOT EXISTS block_embeddings USING vec0(
  embedding float[768]
);

CREATE TABLE IF NOT EXISTS block_embedding_metadata (
  rowid          INTEGER PRIMARY KEY,
  notePath       TEXT NOT NULL,
  chunkIndex     INTEGER NOT NULL,
  heading        TEXT,
  charOffset     INTEGER NOT NULL,
  contentHash    TEXT NOT NULL,
  contentPreview TEXT,
  model          TEXT NOT NULL,
  dimension      INTEGER NOT NULL,
  created        INTEGER NOT NULL,
  updated        INTEGER NOT NULL,
  UNIQUE(notePath, chunkIndex)
);

CREATE INDEX IF NOT EXISTS idx_block_embed_meta_notePath ON block_embedding_metadata(notePath);
CREATE INDEX IF NOT EXISTS idx_block_embed_meta_note_chunk ON block_embedding_metadata(notePath, chunkIndex);

-- Embedding runtime configuration store
CREATE TABLE IF NOT EXISTS embedding_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO embedding_config(key, value) VALUES ('activeModel', 'Xenova/nomic-embed-text-v1.5');
INSERT OR IGNORE INTO embedding_config(key, value) VALUES ('activeDimension', '768');
INSERT OR IGNORE INTO embedding_config(key, value) VALUES ('blockIndexingEnabled', 'false');
INSERT OR IGNORE INTO embedding_config(key, value) VALUES ('blockIndexStale', 'false');

-- ==================== TRACE EMBEDDINGS ====================

-- Vector storage for memory traces
CREATE VIRTUAL TABLE IF NOT EXISTS trace_embeddings USING vec0(
  embedding float[384]
);

-- Metadata linked to vec0 by rowid
CREATE TABLE IF NOT EXISTS trace_embedding_metadata (
  rowid INTEGER PRIMARY KEY,
  traceId TEXT NOT NULL UNIQUE,
  workspaceId TEXT NOT NULL,
  sessionId TEXT,
  model TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trace_embed_id ON trace_embedding_metadata(traceId);
CREATE INDEX IF NOT EXISTS idx_trace_embed_workspace ON trace_embedding_metadata(workspaceId);
CREATE INDEX IF NOT EXISTS idx_trace_embed_session ON trace_embedding_metadata(sessionId);

-- ==================== CUSTOM PROMPTS ====================

CREATE TABLE IF NOT EXISTS custom_prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  prompt TEXT NOT NULL,
  isEnabled INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  modified INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_custom_prompts_name ON custom_prompts(name);
CREATE INDEX IF NOT EXISTS idx_custom_prompts_enabled ON custom_prompts(isEnabled);

-- ==================== CONVERSATION EMBEDDINGS ====================

-- Vector storage for conversation QA pair chunks
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_embeddings USING vec0(
  embedding float[384]
);

-- Metadata linked to vec0 by rowid
CREATE TABLE IF NOT EXISTS conversation_embedding_metadata (
  rowid INTEGER PRIMARY KEY,
  pairId TEXT NOT NULL,
  side TEXT NOT NULL,
  chunkIndex INTEGER NOT NULL,
  conversationId TEXT NOT NULL,
  startSequenceNumber INTEGER NOT NULL,
  endSequenceNumber INTEGER NOT NULL,
  pairType TEXT NOT NULL,
  sourceId TEXT,
  sessionId TEXT,
  workspaceId TEXT,
  model TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  contentPreview TEXT,
  referencedNotes TEXT,
  created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_embed_meta_pairId ON conversation_embedding_metadata(pairId);
CREATE INDEX IF NOT EXISTS idx_conv_embed_meta_conversationId ON conversation_embedding_metadata(conversationId);
CREATE INDEX IF NOT EXISTS idx_conv_embed_meta_workspaceId ON conversation_embedding_metadata(workspaceId);
CREATE INDEX IF NOT EXISTS idx_conv_embed_meta_sessionId ON conversation_embedding_metadata(sessionId);

-- ==================== EMBEDDING BACKFILL STATE ====================

CREATE TABLE IF NOT EXISTS embedding_backfill_state (
  id TEXT PRIMARY KEY DEFAULT 'conversation_backfill',
  lastProcessedConversationId TEXT,
  totalConversations INTEGER DEFAULT 0,
  processedConversations INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  startedAt INTEGER,
  completedAt INTEGER,
  errorMessage TEXT
);

-- ==================== PROJECTS ====================

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  metadataJson TEXT,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(workspaceId, name)
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspaceId);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated);

-- ==================== TASKS ====================

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  parentTaskId TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT DEFAULT 'medium',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  completedAt INTEGER,
  dueDate INTEGER,
  assignee TEXT,
  tagsJson TEXT,
  metadataJson TEXT,
  FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(parentTaskId) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspaceId);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentTaskId);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(dueDate);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(projectId, status);

-- ==================== TASK DEPENDENCIES (DAG edges) ====================

CREATE TABLE IF NOT EXISTS task_dependencies (
  taskId TEXT NOT NULL,
  dependsOnTaskId TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(taskId, dependsOnTaskId),
  FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY(dependsOnTaskId) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(taskId);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(dependsOnTaskId);

-- ==================== TASK-NOTE LINKS (bidirectional) ====================

CREATE TABLE IF NOT EXISTS task_note_links (
  taskId TEXT NOT NULL,
  notePath TEXT NOT NULL,
  linkType TEXT NOT NULL DEFAULT 'reference',
  created INTEGER NOT NULL,
  PRIMARY KEY(taskId, notePath),
  FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_links_note ON task_note_links(notePath);

-- ==================== SEMANTIC PANEL FEEDBACK (Plan 05 — v13) ====================

CREATE TABLE IF NOT EXISTS semantic_feedback (
  sourceNotePath TEXT NOT NULL,
  targetNotePath TEXT NOT NULL,
  state          TEXT NOT NULL CHECK(state IN ('pinned', 'hidden')),
  createdAt      INTEGER NOT NULL,
  PRIMARY KEY (sourceNotePath, targetNotePath, state)
);

CREATE INDEX IF NOT EXISTS idx_semantic_feedback_source ON semantic_feedback(sourceNotePath);
CREATE INDEX IF NOT EXISTS idx_semantic_feedback_state ON semantic_feedback(sourceNotePath, state);

-- ==================== INITIALIZATION ====================

INSERT OR IGNORE INTO schema_version VALUES (13, strftime('%s', 'now') * 1000);
`;
