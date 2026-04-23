import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Use a temp DB path so tests don't pollute the real one
process.env.HOME = '/tmp/a2a-bridge-test-' + process.pid;
import { mkdirSync } from 'fs';
mkdirSync(process.env.HOME, { recursive: true });

// Dynamic import after setting HOME so db.js picks up the temp path
const {
  registerAgent, getAgent, hasAgent, getAllAgents,
  incrementAgentCompleted, incrementAgentFailed,
  insertDelegation, getDelegation, completeDelegation, failDelegation,
  timeoutDelegation, getDelegationsByAgent,
  insertMessage, getMessages,
  db,
} = await import('./db.js');

// ── Test 1: Agent registration and retrieval ────────────────────────────────

describe('Agent registration', () => {
  it('registers an agent and retrieves it by ID', () => {
    const card = registerAgent({
      agent_id: 'test-agent-1',
      capabilities: ['summarization', 'code-review'],
      description: 'A test agent',
      input_schema: { type: 'object' },
      output_schema: { type: 'string' },
      endpoint: 'stdio://test',
    });

    assert.equal(card.agent_id, 'test-agent-1');
    assert.deepEqual(card.capabilities, ['summarization', 'code-review']);
    assert.equal(card.description, 'A test agent');
    assert.equal(card.tasks_completed, 0);
    assert.equal(card.tasks_failed, 0);
    assert.ok(card.registered_at);

    assert.equal(hasAgent('test-agent-1'), true);
    assert.equal(hasAgent('nonexistent'), false);

    const fetched = getAgent('test-agent-1');
    assert.equal(fetched.agent_id, 'test-agent-1');
    assert.deepEqual(fetched.capabilities, ['summarization', 'code-review']);
  });

  it('getAllAgents returns all registered agents', () => {
    registerAgent({
      agent_id: 'test-agent-2',
      capabilities: ['translation'],
      description: 'Another test agent',
    });

    const all = getAllAgents();
    const ids = all.map(a => a.agent_id);
    assert.ok(ids.includes('test-agent-1'));
    assert.ok(ids.includes('test-agent-2'));
  });

  it('increments task counters correctly', () => {
    registerAgent({ agent_id: 'counter-agent', capabilities: ['counting'] });

    incrementAgentCompleted('counter-agent');
    incrementAgentCompleted('counter-agent');
    incrementAgentFailed('counter-agent');

    const agent = getAgent('counter-agent');
    assert.equal(agent.tasks_completed, 2);
    assert.equal(agent.tasks_failed, 1);
  });
});

// ── Test 2: Delegation lifecycle ────────────────────────────────────────────

describe('Delegation lifecycle', () => {
  const now = new Date().toISOString();

  it('inserts and retrieves a delegation', () => {
    registerAgent({ agent_id: 'delegatee', capabilities: ['processing'] });

    insertDelegation({
      task_id: 'task-001',
      from_agent: 'orchestrator',
      to_agent: 'delegatee',
      task_description: 'Process this data',
      input_data: { value: 42 },
      timeout_ms: 5000,
      status: 'pending',
      result: null,
      error: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });

    const task = getDelegation('task-001');
    assert.equal(task.task_id, 'task-001');
    assert.equal(task.from_agent, 'orchestrator');
    assert.equal(task.to_agent, 'delegatee');
    assert.equal(task.status, 'pending');
    assert.deepEqual(task.input_data, { value: 42 });
    assert.equal(task.result, null);
    assert.equal(task.error, null);
  });

  it('completes a delegation and stores result', () => {
    completeDelegation('task-001', { output: 'done', processed: 42 });

    const task = getDelegation('task-001');
    assert.equal(task.status, 'completed');
    assert.deepEqual(task.result, { output: 'done', processed: 42 });
    assert.ok(task.completed_at);
  });

  it('fails a delegation and stores error', () => {
    const taskNow = new Date().toISOString();
    insertDelegation({
      task_id: 'task-002',
      from_agent: 'orchestrator',
      to_agent: 'delegatee',
      task_description: 'This will fail',
      input_data: {},
      timeout_ms: 5000,
      status: 'pending',
      result: null,
      error: null,
      created_at: taskNow,
      updated_at: taskNow,
      completed_at: null,
    });

    failDelegation('task-002', 'Something went wrong');
    const task = getDelegation('task-002');
    assert.equal(task.status, 'failed');
    assert.equal(task.error, 'Something went wrong');
    assert.ok(task.completed_at);
  });

  it('timeouts a pending delegation only', () => {
    const taskNow = new Date().toISOString();
    insertDelegation({
      task_id: 'task-003',
      from_agent: 'orchestrator',
      to_agent: 'delegatee',
      task_description: 'Slow task',
      input_data: {},
      timeout_ms: 1,
      status: 'pending',
      result: null,
      error: null,
      created_at: taskNow,
      updated_at: taskNow,
      completed_at: null,
    });

    const changed = timeoutDelegation('task-003');
    assert.equal(changed, true);
    const task = getDelegation('task-003');
    assert.equal(task.status, 'failed');
    assert.equal(task.error, 'Task timed out');

    // Timing out an already-failed task should return false (no rows changed)
    const changedAgain = timeoutDelegation('task-003');
    assert.equal(changedAgain, false);
  });

  it('getDelegationsByAgent returns correct tasks', () => {
    const tasks = getDelegationsByAgent('delegatee');
    const ids = tasks.map(t => t.task_id);
    assert.ok(ids.includes('task-001'));
    assert.ok(ids.includes('task-002'));
    assert.ok(ids.includes('task-003'));
  });
});

// ── Test 3: Messages ────────────────────────────────────────────────────────

describe('Messages', () => {
  it('inserts and retrieves messages for a delegation', () => {
    insertMessage({
      delegation_id: 'task-001',
      from_agent: 'orchestrator',
      to_agent: 'delegatee',
      message_type: 'status_update',
      content: { progress: 50, note: 'halfway done' },
    });
    insertMessage({
      delegation_id: 'task-001',
      from_agent: 'delegatee',
      to_agent: 'orchestrator',
      message_type: 'result',
      content: { output: 'complete' },
    });

    const msgs = getMessages('task-001');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].message_type, 'status_update');
    assert.deepEqual(msgs[0].content, { progress: 50, note: 'halfway done' });
    assert.equal(msgs[1].message_type, 'result');
    assert.equal(msgs[0].delegation_id, 'task-001');
    assert.ok(msgs[0].timestamp);
    assert.ok(typeof msgs[0].id === 'number');
  });

  it('returns empty array for unknown delegation', () => {
    const msgs = getMessages('no-such-task');
    assert.deepEqual(msgs, []);
  });
});

after(() => {
  db.close();
});
