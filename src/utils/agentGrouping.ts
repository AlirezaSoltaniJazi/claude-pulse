import {
  AgentGraph,
  AgentNode,
  AgentTypeGroup,
  AgentTypeInstance,
  AgentTypeSession,
} from '../types';

/**
 * Inverts the agent graph: session-keyed in, agent-type-keyed out.
 *
 * Pure, so the whole shape of the type-first view is testable without touching a filesystem.
 * It is also why this is not a second scan — the type view and the session view are two
 * readings of the same AgentGraph, so switching tabs costs nothing and can never show two
 * different truths about the same agent.
 *
 * Sessions that spawned no agents appear in no group, because they ran no agent type. The
 * session-first tab is what keeps them reachable; see renderAgentGraphSection().
 */
export function groupAgentsByType(graph: AgentGraph | null): AgentTypeGroup[] {
  if (!graph) return [];

  const groups = new Map<string, AgentTypeGroup>();

  for (const session of graph.sessions) {
    const flat = flattenAgents(session.agents);
    if (flat.length === 0) continue;

    // Descriptions of everything in this session, so a nested agent can name its parent
    // even when the parent sits under a different type.
    const descriptions = new Map(flat.map((agent) => [agent.id, agent.description]));

    const byType = new Map<string, AgentTypeInstance[]>();
    for (const agent of flat) {
      const instance: AgentTypeInstance = {
        agent,
        parentDescription: agent.parentAgentId
          ? (descriptions.get(agent.parentAgentId) ?? null)
          : null,
      };
      const list = byType.get(agent.agentType);
      if (list) {
        list.push(instance);
      } else {
        byType.set(agent.agentType, [instance]);
      }
    }

    for (const [agentType, instances] of byType) {
      // Running first, then costliest. Same rule as the tree: the runs there is something to
      // do about must not sit below a screenful of finished ones.
      instances.sort(compareInstances);

      const entry: AgentTypeSession = {
        session,
        instances,
        runningCount: instances.filter((i) => i.agent.status === 'running').length,
        totalTokens: instances.reduce((sum, i) => sum + i.agent.tokens, 0),
      };

      const group = groups.get(agentType);
      if (group) {
        group.sessions.push(entry);
        group.count += instances.length;
        group.runningCount += entry.runningCount;
        group.totalTokens += entry.totalTokens;
      } else {
        groups.set(agentType, {
          agentType,
          count: instances.length,
          runningCount: entry.runningCount,
          totalTokens: entry.totalTokens,
          sessions: [entry],
        });
      }
    }
  }

  for (const group of groups.values()) {
    group.sessions.sort(compareSessions);
  }

  // Types with something running first, then by cost: a tab bar is a place to look for what
  // needs attention before it is a league table.
  return [...groups.values()].sort((a, b) => {
    const aLive = a.runningCount > 0 ? 1 : 0;
    const bLive = b.runningCount > 0 ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return b.totalTokens - a.totalTokens;
  });
}

/**
 * Every agent in a session's tree, depth-first, parents before children.
 *
 * The type view lists runs flat on purpose: a `general-purpose` agent's child may be an
 * `Explore` agent, which belongs to a different tab, so a tree here would either cross tabs
 * or hide the child entirely.
 */
export function flattenAgents(agents: AgentNode[]): AgentNode[] {
  const flat: AgentNode[] = [];
  const visit = (nodes: AgentNode[]): void => {
    for (const node of nodes) {
      flat.push(node);
      visit(node.children);
    }
  };
  visit(agents);
  return flat;
}

function compareInstances(a: AgentTypeInstance, b: AgentTypeInstance): number {
  const aLive = a.agent.status === 'running' ? 1 : 0;
  const bLive = b.agent.status === 'running' ? 1 : 0;
  if (aLive !== bLive) return bLive - aLive;
  return b.agent.tokens - a.agent.tokens;
}

/** Live sessions first — they are the only ones with anything to stop — then by cost. */
function compareSessions(a: AgentTypeSession, b: AgentTypeSession): number {
  if (a.session.isAlive !== b.session.isAlive) return a.session.isAlive ? -1 : 1;
  return b.totalTokens - a.totalTokens;
}
