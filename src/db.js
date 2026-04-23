import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DB_DIR = join(homedir(), '.a2a-bridge-mcp');
const DB_PATH = join(DB_DIR, 'bridge.db');

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode for concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    agent_id        TEXT PRIMARY KEY,
    name            TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    description     TEXT NOT NULL DEFAULT '',
    input_schema_json TEXT NOT NULL DEFAULT '{}',
    output_schema_json TEXT NOT NULL DEFAULT '{}',
    endpoint        TEXT NOT NULL DEFAULT '',
    registered_at   TEXT NOT NULL,
    last_seen       TEXT NOT NULL,
    tasks_completed INTEGER NOT NULL DEFAULT 0,
    tasks_failed    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS delegations (
    delegation_id   TEXT PRIMARY KEY,
    from_agent      TEXT NOT NULL,
    to_agent        TEXT NOT NULL,
    task_description TEXT NOT NULL,
    input_data_json TEXT NOT NULL DEFAULT '{}',
    timeout_ms      INTEGER NOT NULL DEFAULT 30000,
    status          TEXT NOT NULL DEFAULT 'pending',
    broadcast_group TEXT,
    match_score     REAL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    completed_at    TEXT,
    result_json     TEXT,
    error           TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    delegation_id   TEXT NOT NULL,
    from_agent      TEXT NOT NULL,
    to_agent        TEXT NOT NULL,
    message_type    TEXT NOT NULL,
    content_json    TEXT NOT NULL DEFAULT '{}',
    timestamp       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_delegations_delegation_id ON delegations(delegation_id);
  CREATE INDEX IF NOT EXISTS idx_delegations_to_agent ON delegations(to_agent);
  CREATE INDEX IF NOT EXISTS idx_delegations_from_agent ON delegations(from_agent);
  CREATE INDEX IF NOT EXISTS idx_agents_agent_id ON agents(agent_id);
  CREATE INDEX IF NOT EXISTS idx_messages_delegation_id ON messages(delegation_id);
`);

// ── Agents ─────────────────────────────────────────────────────────────────

const stmts = {
  upsertAgent: db.prepare(`
    INSERT INTO agents (agent_id, name, capabilities_json, description, input_schema_json, output_schema_json, endpoint, registered_at, last_seen, tasks_completed, tasks_failed)
    VALUES (@agent_id, @name, @capabilities_json, @description, @input_schema_json, @output_schema_json, @endpoint, @registered_at, @last_seen, 0, 0)
    ON CONFLICT(agent_id) DO UPDATE SET
      name = excluded.name,
      capabilities_json = excluded.capabilities_json,
      description = excluded.description,
      input_schema_json = excluded.input_schema_json,
      output_schema_json = excluded.output_schema_json,
      endpoint = excluded.endpoint,
      last_seen = excluded.last_seen
  `),
  getAgent: db.prepare(`SELECT * FROM agents WHERE agent_id = ?`),
  getAllAgents: db.prepare(`SELECT * FROM agents`),
  incrCompleted: db.prepare(`UPDATE agents SET tasks_completed = tasks_completed + 1, last_seen = ? WHERE agent_id = ?`),
  incrFailed: db.prepare(`UPDATE agents SET tasks_failed = tasks_failed + 1, last_seen = ? WHERE agent_id = ?`),

  // Delegations
  insertDelegation: db.prepare(`
    INSERT INTO delegations (delegation_id, from_agent, to_agent, task_description, input_data_json, timeout_ms, status, broadcast_group, match_score, created_at, updated_at, completed_at, result_json, error)
    VALUES (@delegation_id, @from_agent, @to_agent, @task_description, @input_data_json, @timeout_ms, @status, @broadcast_group, @match_score, @created_at, @updated_at, @completed_at, @result_json, @error)
  `),
  getDelegation: db.prepare(`SELECT * FROM delegations WHERE delegation_id = ?`),
  updateDelegationComplete: db.prepare(`
    UPDATE delegations SET status = 'completed', result_json = ?, updated_at = ?, completed_at = ? WHERE delegation_id = ?
  `),
  updateDelegationFailed: db.prepare(`
    UPDATE delegations SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE delegation_id = ?
  `),
  updateDelegationStatus: db.prepare(`
    UPDATE delegations SET status = ?, updated_at = ? WHERE delegation_id = ?
  `),
  timeoutDelegation: db.prepare(`
    UPDATE delegations SET status = 'failed', error = 'Task timed out', updated_at = ?, completed_at = ? WHERE delegation_id = ? AND status = 'pending'
  `),
  getDelegationsByAgent: db.prepare(`SELECT * FROM delegations WHERE to_agent = ?`),

  // Messages
  insertMessage: db.prepare(`
    INSERT INTO messages (delegation_id, from_agent, to_agent, message_type, content_json, timestamp)
    VALUES (@delegation_id, @from_agent, @to_agent, @message_type, @content_json, @timestamp)
  `),
  getMessagesByDelegation: db.prepare(`SELECT * FROM messages WHERE delegation_id = ?`),
};

// ── Public API (same signatures as the old Map-based storage) ──────────────

export function registerAgent({ agent_id, capabilities, description, input_schema, output_schema, endpoint }) {
  const now = new Date().toISOString();
  stmts.upsertAgent.run({
    agent_id,
    name: agent_id,
    capabilities_json: JSON.stringify(capabilities),
    description: description ?? '',
    input_schema_json: JSON.stringify(input_schema ?? {}),
    output_schema_json: JSON.stringify(output_schema ?? {}),
    endpoint: endpoint ?? '',
    registered_at: now,
    last_seen: now,
  });
  return getAgent(agent_id);
}

export function getAgent(agent_id) {
  const row = stmts.getAgent.get(agent_id);
  if (!row) return null;
  return deserializeAgent(row);
}

export function hasAgent(agent_id) {
  return !!stmts.getAgent.get(agent_id);
}

export function getAllAgents() {
  return stmts.getAllAgents.all().map(deserializeAgent);
}

export function incrementAgentCompleted(agent_id) {
  stmts.incrCompleted.run(new Date().toISOString(), agent_id);
}

export function incrementAgentFailed(agent_id) {
  stmts.incrFailed.run(new Date().toISOString(), agent_id);
}

// ── Delegations ────────────────────────────────────────────────────────────

export function insertDelegation(task) {
  stmts.insertDelegation.run({
    delegation_id: task.task_id,
    from_agent: task.from_agent,
    to_agent: task.to_agent,
    task_description: task.task_description,
    input_data_json: JSON.stringify(task.input_data ?? {}),
    timeout_ms: task.timeout_ms ?? 30000,
    status: task.status ?? 'pending',
    broadcast_group: task.broadcast_group ?? null,
    match_score: task.match_score ?? null,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at ?? null,
    result_json: task.result ? JSON.stringify(task.result) : null,
    error: task.error ?? null,
  });
}

export function getDelegation(task_id) {
  const row = stmts.getDelegation.get(task_id);
  if (!row) return null;
  return deserializeDelegation(row);
}

export function completeDelegation(task_id, result) {
  const now = new Date().toISOString();
  stmts.updateDelegationComplete.run(JSON.stringify(result), now, now, task_id);
}

export function failDelegation(task_id, error) {
  const now = new Date().toISOString();
  stmts.updateDelegationFailed.run(error, now, now, task_id);
}

export function timeoutDelegation(task_id) {
  const now = new Date().toISOString();
  const info = stmts.timeoutDelegation.run(now, now, task_id);
  return info.changes > 0;
}

export function getDelegationsByAgent(agent_id) {
  return stmts.getDelegationsByAgent.all(agent_id).map(deserializeDelegation);
}

// ── Messages ───────────────────────────────────────────────────────────────

export function insertMessage({ delegation_id, from_agent, to_agent, message_type, content }) {
  stmts.insertMessage.run({
    delegation_id,
    from_agent,
    to_agent,
    message_type,
    content_json: JSON.stringify(content ?? {}),
    timestamp: new Date().toISOString(),
  });
}

export function getMessages(delegation_id) {
  return stmts.getMessagesByDelegation.all(delegation_id).map(row => ({
    id: row.id,
    delegation_id: row.delegation_id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    message_type: row.message_type,
    content: JSON.parse(row.content_json),
    timestamp: row.timestamp,
  }));
}

// ── Deserializers ──────────────────────────────────────────────────────────

function deserializeAgent(row) {
  return {
    agent_id: row.agent_id,
    name: row.name,
    capabilities: JSON.parse(row.capabilities_json),
    description: row.description,
    input_schema: JSON.parse(row.input_schema_json),
    output_schema: JSON.parse(row.output_schema_json),
    endpoint: row.endpoint,
    registered_at: row.registered_at,
    last_seen: row.last_seen,
    tasks_completed: row.tasks_completed,
    tasks_failed: row.tasks_failed,
  };
}

function deserializeDelegation(row) {
  return {
    task_id: row.delegation_id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    task_description: row.task_description,
    input_data: JSON.parse(row.input_data_json),
    timeout_ms: row.timeout_ms,
    status: row.status,
    broadcast_group: row.broadcast_group,
    match_score: row.match_score,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
  };
}

export { db };
