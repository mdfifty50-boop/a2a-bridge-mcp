# a2a-bridge-mcp

MCP server for agent-to-agent communication -- capability discovery, task delegation, and result aggregation across MCP agents.

MCP connects agents to tools, but not to each other. This server adds a standardized agent-to-agent layer within the MCP protocol -- register agents, discover capabilities, delegate tasks, and broadcast work to multiple agents. Inspired by Google's A2A protocol.

## Install

```bash
npx a2a-bridge-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "a2a-bridge": {
      "command": "npx",
      "args": ["a2a-bridge-mcp"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/mdfifty50-boop/a2a-bridge-mcp.git
cd a2a-bridge-mcp
npm install
node src/index.js
```

## Tools

### register_agent

Register an agent with capabilities for discovery by other agents.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent_id` | string | required | Unique agent identifier |
| `capabilities` | string[] | required | Capability strings (e.g. `["code-review", "summarization"]`) |
| `description` | string | `""` | Human-readable description |
| `input_schema` | object | `{}` | JSON schema for accepted input |
| `output_schema` | object | `{}` | JSON schema for produced output |
| `endpoint` | string | `""` | Optional endpoint or transport hint |

### discover_agents

Find agents matching a capability need with fuzzy text similarity scoring.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `capability_needed` | string | required | Capability to search for |
| `min_score` | number | 0.3 | Minimum similarity score (0-1) |

Returns scored matches sorted by relevance.

### delegate_task

Delegate a task to a specific registered agent. Creates a tracked task with status lifecycle.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `from_agent` | string | required | Delegating agent ID |
| `to_agent` | string | required | Target agent ID |
| `task_description` | string | required | What the target should do |
| `input_data` | object | `{}` | Input data for the task |
| `timeout_ms` | number | 30000 | Timeout in milliseconds |

Returns a `task_id` for tracking.

### get_task_result

Get status and result of a delegated task. Also used by executing agents to submit results.

| Param | Type | Description |
|-------|------|-------------|
| `task_id` | string | Task ID from delegate_task or broadcast_task |
| `submit_result` | object | (Optional) Submit completion result |
| `submit_error` | string | (Optional) Submit failure error |

Status lifecycle: `pending` -> `running` -> `completed` / `failed`.

### broadcast_task

Send a task to ALL agents matching a capability. Creates individual tracked tasks for each match.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `from_agent` | string | required | Broadcasting agent ID |
| `capability_needed` | string | required | Capability to match |
| `task_description` | string | required | What matched agents should do |
| `input_data` | object | `{}` | Input data |
| `min_score` | number | 0.3 | Minimum match score |
| `timeout_ms` | number | 30000 | Timeout per agent |

Returns list of task IDs for aggregation via get_task_result.

### get_agent_card

Get an agent's full capability card with schemas, stats, and task history.

| Param | Type | Description |
|-------|------|-------------|
| `agent_id` | string | Agent identifier |

Returns capabilities, input/output schemas, success rate, and task counts. Inspired by Google A2A agent cards.

### list_agents

List all registered agents, optionally filtered by capability.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `filter` | string | `""` | Capability keyword to filter by (empty = all) |

## Resources

| URI | Description |
|-----|-------------|
| `a2a://agents` | All registered agents with capabilities and stats |

## Usage Pattern

```
1. register_agent    -- each agent registers at startup
2. discover_agents   -- find who can handle a task
3. delegate_task     -- send work to a specific agent
   OR broadcast_task -- send work to all matching agents
4. get_task_result   -- poll for completion or submit results
5. get_agent_card    -- inspect an agent's full profile
6. list_agents       -- overview of the agent network
```

### Multi-agent workflow example

```
Agent A (orchestrator):
  1. register_agent(agent_id="orchestrator", capabilities=["planning", "coordination"])
  2. discover_agents(capability_needed="code review")
     -> finds Agent B (score: 0.95)
  3. delegate_task(from="orchestrator", to="agent-b", task="Review PR #42")
     -> task_id: "task_1234"
  4. get_task_result(task_id="task_1234")
     -> status: "completed", result: { approved: true, comments: [...] }

Agent B (worker):
  1. register_agent(agent_id="agent-b", capabilities=["code-review", "linting"])
  2. (receives task via external notification or polling)
  3. get_task_result(task_id="task_1234", submit_result={ approved: true })
```

## License

MIT
