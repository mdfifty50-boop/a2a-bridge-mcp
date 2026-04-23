#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const agents = new Map();
const tasks = new Map();
let taskCounter = 0;

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function similarity(query, target) {
  const qTokens = tokenize(query);
  const tTokens = new Set(tokenize(target));
  if (!qTokens.length || !tTokens.size) return 0;
  let hits = 0;
  for (const q of qTokens) {
    for (const t of tTokens) { if (t.includes(q) || q.includes(t)) { hits++; break; } }
  }
  return hits / qTokens.length;
}

function matchAgent(agent, cap) {
  return similarity(cap, agent.capabilities.join(' ') + ' ' + (agent.description || ''));
}

function genId() { return `task_${Date.now()}_${++taskCounter}`; }

function reply(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function agentSummary(a) {
  return { agent_id: a.agent_id, capabilities: a.capabilities, description: a.description,
    tasks_completed: a.tasks_completed, tasks_failed: a.tasks_failed, registered_at: a.registered_at };
}

function autoTimeout(taskId, ms) {
  setTimeout(() => {
    const t = tasks.get(taskId);
    if (t && t.status === 'pending') {
      t.status = 'failed'; t.error = 'Task timed out';
      t.updated_at = new Date().toISOString(); t.completed_at = t.updated_at;
      const a = agents.get(t.to_agent);
      if (a) a.tasks_failed++;
    }
  }, ms);
}

const server = new McpServer({
  name: 'a2a-bridge-mcp', version: '0.1.0',
  description: 'Agent-to-agent communication — capability discovery, task delegation, and result aggregation across MCP agents',
});

// register_agent
server.tool(
  'register_agent',
  'Register an agent with its capabilities, input/output schemas for discovery by other agents.',
  {
    agent_id: z.string().describe('Unique identifier for the agent'),
    capabilities: z.array(z.string()).describe('Capability strings (e.g. ["code-review", "summarization"])'),
    description: z.string().default('').describe('Human-readable description'),
    input_schema: z.record(z.any()).default({}).describe('JSON schema for accepted input'),
    output_schema: z.record(z.any()).default({}).describe('JSON schema for produced output'),
    endpoint: z.string().default('').describe('Optional endpoint or transport hint'),
  },
  async (p) => {
    const card = { agent_id: p.agent_id, capabilities: p.capabilities, description: p.description,
      input_schema: p.input_schema, output_schema: p.output_schema, endpoint: p.endpoint,
      registered_at: new Date().toISOString(), tasks_completed: 0, tasks_failed: 0 };
    agents.set(p.agent_id, card);
    return reply({ registered: true, agent_id: card.agent_id, capabilities: card.capabilities, registered_at: card.registered_at });
  }
);

// discover_agents
server.tool(
  'discover_agents',
  'Find registered agents matching a capability need. Returns scored results with fuzzy text matching.',
  {
    capability_needed: z.string().describe('Capability to search for'),
    min_score: z.number().min(0).max(1).default(0.3).describe('Minimum similarity score (0-1, default 0.3)'),
  },
  async ({ capability_needed, min_score }) => {
    const results = [];
    for (const agent of agents.values()) {
      const score = matchAgent(agent, capability_needed);
      if (score >= min_score) {
        results.push({ agent_id: agent.agent_id, score: Math.round(score * 100) / 100,
          capabilities: agent.capabilities, description: agent.description, tasks_completed: agent.tasks_completed });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return reply({ query: capability_needed, min_score, matches: results, total: results.length });
  }
);

// delegate_task
server.tool(
  'delegate_task',
  'Delegate a task to a specific registered agent. Creates a tracked task with status lifecycle (pending -> running -> completed/failed).',
  {
    from_agent: z.string().describe('Agent ID of the delegator'),
    to_agent: z.string().describe('Agent ID of the target agent'),
    task_description: z.string().describe('What the target agent should do'),
    input_data: z.record(z.any()).default({}).describe('Input data for the task'),
    timeout_ms: z.number().int().min(1000).default(30000).describe('Timeout in milliseconds (default 30s)'),
  },
  async (p) => {
    if (!agents.has(p.to_agent)) return reply({ error: `Agent "${p.to_agent}" is not registered` });
    const taskId = genId();
    const now = new Date().toISOString();
    const task = { task_id: taskId, from_agent: p.from_agent, to_agent: p.to_agent,
      task_description: p.task_description, input_data: p.input_data, timeout_ms: p.timeout_ms,
      status: 'pending', result: null, error: null, created_at: now, updated_at: now, completed_at: null };
    tasks.set(taskId, task);
    autoTimeout(taskId, p.timeout_ms);
    return reply({ delegated: true, task_id: taskId, from_agent: task.from_agent,
      to_agent: task.to_agent, status: task.status, timeout_ms: task.timeout_ms, created_at: task.created_at });
  }
);

// get_task_result
server.tool(
  'get_task_result',
  'Get status/result of a delegated task. Executing agents call this with submit_result or submit_error to report completion.',
  {
    task_id: z.string().describe('Task ID from delegate_task or broadcast_task'),
    submit_result: z.record(z.any()).optional().describe('Submit completion result (called by executing agent)'),
    submit_error: z.string().optional().describe('Submit failure error message'),
  },
  async ({ task_id, submit_result, submit_error }) => {
    const task = tasks.get(task_id);
    if (!task) return reply({ error: `Task "${task_id}" not found` });
    if (submit_result !== undefined) {
      task.status = 'completed'; task.result = submit_result;
      task.updated_at = new Date().toISOString(); task.completed_at = task.updated_at;
      const a = agents.get(task.to_agent); if (a) a.tasks_completed++;
    } else if (submit_error !== undefined) {
      task.status = 'failed'; task.error = submit_error;
      task.updated_at = new Date().toISOString(); task.completed_at = task.updated_at;
      const a = agents.get(task.to_agent); if (a) a.tasks_failed++;
    }
    return reply({ task_id: task.task_id, status: task.status, from_agent: task.from_agent,
      to_agent: task.to_agent, task_description: task.task_description,
      result: task.result, error: task.error, created_at: task.created_at, completed_at: task.completed_at });
  }
);

// broadcast_task
server.tool(
  'broadcast_task',
  'Send a task to ALL agents matching a capability. Creates individual tasks for each match for aggregation.',
  {
    from_agent: z.string().describe('Agent ID of the broadcaster'),
    capability_needed: z.string().describe('Capability to match agents against'),
    task_description: z.string().describe('What matched agents should do'),
    input_data: z.record(z.any()).default({}).describe('Input data for the task'),
    min_score: z.number().min(0).max(1).default(0.3).describe('Minimum capability match score (default 0.3)'),
    timeout_ms: z.number().int().min(1000).default(30000).describe('Timeout per agent in milliseconds'),
  },
  async (p) => {
    const matched = [];
    for (const agent of agents.values()) {
      const score = matchAgent(agent, p.capability_needed);
      if (score >= p.min_score) matched.push({ agent, score });
    }
    matched.sort((a, b) => b.score - a.score);
    if (!matched.length) {
      return reply({ broadcast: false, reason: `No agents match "${p.capability_needed}" (min_score ${p.min_score})`, agents_checked: agents.size });
    }
    const now = new Date().toISOString();
    const group = `bcast_${Date.now()}`;
    const taskList = [];
    for (const { agent, score } of matched) {
      const taskId = genId();
      tasks.set(taskId, { task_id: taskId, from_agent: p.from_agent, to_agent: agent.agent_id,
        task_description: p.task_description, input_data: p.input_data, timeout_ms: p.timeout_ms,
        status: 'pending', result: null, error: null, broadcast_group: group, match_score: score,
        created_at: now, updated_at: now, completed_at: null });
      taskList.push({ task_id: taskId, agent_id: agent.agent_id, score: Math.round(score * 100) / 100 });
      autoTimeout(taskId, p.timeout_ms);
    }
    return reply({ broadcast: true, capability: p.capability_needed, agents_matched: taskList.length, tasks: taskList });
  }
);

// get_agent_card
server.tool(
  'get_agent_card',
  "Get an agent's full capability card — capabilities, schemas, stats. Inspired by Google A2A agent cards.",
  { agent_id: z.string().describe('Agent identifier') },
  async ({ agent_id }) => {
    const agent = agents.get(agent_id);
    if (!agent) return reply({ error: `Agent "${agent_id}" is not registered` });
    let pending = 0, running = 0, completed = 0, failed = 0;
    for (const t of tasks.values()) {
      if (t.to_agent !== agent_id) continue;
      if (t.status === 'pending') pending++; else if (t.status === 'running') running++;
      else if (t.status === 'completed') completed++; else if (t.status === 'failed') failed++;
    }
    return reply({ agent_id: agent.agent_id, description: agent.description,
      capabilities: agent.capabilities, input_schema: agent.input_schema, output_schema: agent.output_schema,
      endpoint: agent.endpoint, registered_at: agent.registered_at,
      stats: { tasks_completed: agent.tasks_completed, tasks_failed: agent.tasks_failed,
        tasks_pending: pending, tasks_running: running,
        success_rate: (completed + failed) > 0 ? Math.round((completed / (completed + failed)) * 100) + '%' : 'N/A' } });
  }
);

// list_agents
server.tool(
  'list_agents',
  'List all registered agents. Optionally filter by a capability keyword.',
  { filter: z.string().default('').describe('Capability keyword to filter by (empty = show all)') },
  async ({ filter }) => {
    const results = [];
    for (const agent of agents.values()) {
      if (filter) {
        const score = matchAgent(agent, filter);
        if (score < 0.1) continue;
        results.push({ ...agentSummary(agent), relevance: Math.round(score * 100) / 100 });
      } else {
        results.push(agentSummary(agent));
      }
    }
    if (filter) results.sort((a, b) => b.relevance - a.relevance);
    return reply({ filter: filter || null, agents: results, total: results.length });
  }
);

// Resource: a2a://agents
server.resource('agents', 'a2a://agents', async () => {
  const all = []; for (const a of agents.values()) all.push(agentSummary(a));
  return { contents: [{ uri: 'a2a://agents', mimeType: 'application/json',
    text: JSON.stringify({ agents: all, total: all.length, generated_at: new Date().toISOString() }, null, 2) }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('A2A Bridge MCP Server running on stdio');
}
main().catch(console.error);
