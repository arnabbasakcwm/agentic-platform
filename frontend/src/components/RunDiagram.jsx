import { graphlib, layout } from "@dagrejs/dagre";
import {
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { END, START, buildGraph } from "../lib/flow.js";
import { formatDuration } from "../lib/format.js";
import { serverNow } from "../lib/runState.js";
import { Icon } from "./icons.jsx";

const AGENT_SIZE = { width: 216, height: 66 };
const TERMINAL_SIZE = { width: 76, height: 36 };
// Below this width the diagram runs top-to-bottom so nodes stay readable.
const NARROW_PX = 640;

const STATE_LABEL = {
  idle: "Idle",
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

const STATE_ICON = { queued: "clock", completed: "check", failed: "close", skipped: "skip" };

function layoutGraph(graph, direction) {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 28, ranksep: direction === "LR" ? 64 : 44, marginx: 12, marginy: 12 });
  g.setDefaultEdgeLabel(() => ({}));
  // dagre writes each node's position into the label object it is given, so every node
  // needs its own copy — a shared object would leave all nodes at the last position.
  g.setNode(START, { ...TERMINAL_SIZE });
  g.setNode(END, { ...TERMINAL_SIZE });
  for (const agent of graph.agents) g.setNode(agent.id, { ...AGENT_SIZE });
  for (const edge of graph.edges) g.setEdge(edge.source, edge.target);
  layout(g);
  const positions = {};
  for (const id of g.nodes()) {
    const { x, y, width, height } = g.node(id);
    positions[id] = { x: x - width / 2, y: y - height / 2 };
  }
  return positions;
}

function terminalState(kind, run) {
  if (run.status === "idle") return "idle";
  if (kind === START) return "completed";
  if (run.status === "running") return "queued";
  if (run.status === "failed" || run.halted) return "failed";
  return "completed";
}

function stateOf(id, run) {
  if (id === START || id === END) return terminalState(id, run);
  return run.nodes[id]?.status ?? "idle";
}

// An edge carries data while its target is working on what its source produced; it is
// done once the target has finished.
function edgeState(edge, run) {
  const source = stateOf(edge.source, run);
  const target = stateOf(edge.target, run);
  if (target === "failed" && source === "completed") return "failed";
  if (target === "running" && source === "completed") return "active";
  if (target === "completed" && source === "completed") return "done";
  return "idle";
}

function AgentNode({ data }) {
  const { title, role, color, state, durationMs, liveMs, error, direction, onSelect, isRouter } = data;
  const time = state === "running" ? liveMs : durationMs;
  const label = `${title}: ${STATE_LABEL[state].toLowerCase()}${time != null ? `, ${formatDuration(time)}` : ""}. Show its output.`;
  return (
    <div
      className={`flow-node flow-node--${state}`}
      style={{ "--agent-color": color }}
      role="button"
      tabIndex={0}
      aria-label={label}
      title={state === "failed" && error ? error : undefined}
      // Mouse clicks arrive through ReactFlow's onNodeClick (it only lets pointer events
      // reach nodes when that handler is set); keyboard activation is handled here.
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <Handle type="target" position={direction === "LR" ? Position.Left : Position.Top} isConnectable={false} />
      <span className="flow-node__stripe" aria-hidden="true" />
      <div className="flow-node__main">
        <span className="flow-node__title">
          {title}
          {isRouter && <span className="flow-node__tag">router</span>}
        </span>
        <span className="flow-node__role">{role}</span>
      </div>
      <span className="flow-node__state">
        {state === "running" ? (
          <span className="spin spin--sm" aria-hidden="true" />
        ) : (
          STATE_ICON[state] && <Icon name={STATE_ICON[state]} size={12} />
        )}
        <span>{time != null ? formatDuration(time) : STATE_LABEL[state]}</span>
      </span>
      <Handle type="source" position={direction === "LR" ? Position.Right : Position.Bottom} isConnectable={false} />
    </div>
  );
}

function TerminalNode({ data }) {
  return (
    <div className={`flow-terminal flow-terminal--${data.state}`}>
      {data.kind === END && (
        <Handle type="target" position={data.direction === "LR" ? Position.Left : Position.Top} isConnectable={false} />
      )}
      <Icon name={data.kind === START ? "play" : "flag"} size={12} />
      {data.kind === START ? "Start" : "End"}
      {data.kind === START && (
        <Handle type="source" position={data.direction === "LR" ? Position.Right : Position.Bottom} isConnectable={false} />
      )}
    </div>
  );
}

function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <g className={`flow-edge flow-edge--${data.state}`} style={{ "--edge-color": data.color }}>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {data.state === "active" && <path className="flow-edge__dash" d={path} fill="none" />}
    </g>
  );
}

const nodeTypes = { agent: AgentNode, terminal: TerminalNode };
const edgeTypes = { flow: FlowEdge };

/**
 * The plan's orchestration as a live diagram: agents are nodes and the compiler's wiring
 * is the edges, laid out automatically. Node and edge states come only from the run's
 * events — what the server reported, never a simulation.
 */
export function RunDiagram({ plan, run, clock, onSelectAgent }) {
  const graph = useMemo(() => buildGraph(plan), [plan]);
  const containerRef = useRef(null);
  const [direction, setDirection] = useState("LR");

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setDirection(entry.contentRect.width < NARROW_PX ? "TB" : "LR");
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const positions = useMemo(() => layoutGraph(graph, direction), [graph, direction]);
  const colorOf = useMemo(
    () => Object.fromEntries(graph.agents.map((a) => [a.id, a.color])),
    [graph],
  );
  const now = serverNow(run, clock);

  const nodes = useMemo(
    () => [
      ...[START, END].map((kind) => ({
        id: kind,
        type: "terminal",
        position: positions[kind],
        data: { kind, state: terminalState(kind, run), direction },
        selectable: false,
        focusable: false,
      })),
      ...graph.agents.map((agent) => {
        const node = run.nodes[agent.id];
        return {
          id: agent.id,
          type: "agent",
          position: positions[agent.id],
          selectable: false,
          focusable: false,
          data: {
            ...agent,
            state: node?.status ?? "idle",
            durationMs: node?.durationMs,
            liveMs:
              node?.status === "running" && node.startedAt != null && now != null
                ? Math.max(0, (now - node.startedAt) * 1000)
                : null,
            error: node?.error,
            direction,
            onSelect: () => onSelectAgent(agent.id),
          },
        };
      }),
    ],
    [graph, positions, run, direction, now, onSelectAgent],
  );

  const edges = useMemo(
    () =>
      graph.edges.map((edge) => {
        const state = edgeState(edge, run);
        const color = colorOf[edge.target] ?? colorOf[edge.source] ?? "var(--accent)";
        return {
          ...edge,
          type: "flow",
          data: { state, color },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color: state === "idle" ? "var(--border-strong)" : state === "failed" ? "var(--danger)" : color,
          },
        };
      }),
    [graph, run, colorOf],
  );

  return (
    <div className="diagram" ref={containerRef}>
      <ReactFlow
        key={`${direction}-${graph.agents.length}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        // Never enlarge nodes past 100%: small teams stay crisp, large ones shrink to fit.
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.4}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        colorMode="system"
        onNodeClick={(_event, node) => {
          if (node.type === "agent") onSelectAgent(node.id);
        }}
        aria-label="Agent orchestration diagram"
      >
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
