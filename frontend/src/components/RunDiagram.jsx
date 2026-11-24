import { graphlib, layout } from "@dagrejs/dagre";
import {
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  getStraightPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { END, START, agentIndex, agentStyle, buildGraph } from "../lib/flow.js";
import { formatDuration } from "../lib/format.js";
import { serverNow } from "../lib/runState.js";
import { useTheme } from "../lib/theme.js";
import { Icon } from "./icons.jsx";

// AgentNode (DESIGN.md §5.9, design/reference/phase-chrome.html): 220px wide, wider
// only when an agent key is too long for one line (keys are never wrapped or cut).
const AGENT_W = 220;
const AGENT_H = 112;
const KEY_CHAR_PX = 8.6; // JetBrains Mono 14px
const NODE_PAD_PX = 30;
const TERMINAL_SIZE = { width: 76, height: 36 };

function agentWidth(id) {
  return Math.max(AGENT_W, Math.ceil(id.length * KEY_CHAR_PX + NODE_PAD_PX));
}
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

const STATE_ICON = {
  queued: "clock",
  completed: "check",
  failed: "close",
  skipped: "skip",
};

// `sizes`: what React Flow measured for each rendered node ({ width, height }). dagre
// centres nodes on their real size, so START, END and the agents share one centre line;
// until a node is measured, the CSS sizes are used.
function layoutGraph(graph, direction, sizes = {}) {
  const g = new graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep: 28,
    ranksep: direction === "LR" ? 56 : 44,
    marginx: 12,
    marginy: 12,
  });
  g.setDefaultEdgeLabel(() => ({}));
  // dagre writes each node's position into the label object it is given, so every node
  // needs its own copy — a shared object would leave all nodes at the last position.
  const sizeOf = (id, fallback) => ({
    width: sizes[id]?.width ?? fallback.width,
    height: sizes[id]?.height ?? fallback.height,
  });
  g.setNode(START, sizeOf(START, TERMINAL_SIZE));
  g.setNode(END, sizeOf(END, TERMINAL_SIZE));
  for (const agent of graph.agents) {
    g.setNode(agent.id, sizeOf(agent.id, { width: agentWidth(agent.id), height: AGENT_H }));
  }
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
// done once the target has finished. "Pending": the target is queued behind a source
// that is still running — the next hand-off (DESIGN.md §7: edges into queued nodes flow).
function edgeState(edge, run) {
  const source = stateOf(edge.source, run);
  const target = stateOf(edge.target, run);
  if (target === "failed" && source === "completed") return "failed";
  if (target === "running" && source === "completed") return "active";
  if (target === "completed" && source === "completed") return "done";
  if (target === "queued" && source === "running") return "pending";
  return "idle";
}

const PILL_TONE = {
  idle: "slate",
  queued: "amber",
  running: "sky",
  completed: "success",
  failed: "danger",
  skipped: "slate",
};

function AgentNode({ data }) {
  const {
    id,
    index,
    title,
    role,
    model,
    tools,
    state,
    durationMs,
    liveMs,
    error,
    direction,
    onSelect,
    isRouter,
  } = data;
  const time = state === "running" ? liveMs : durationMs;
  const label = `${title}: ${STATE_LABEL[state].toLowerCase()}${time != null ? `, ${formatDuration(time)}` : ""}. Show its output.`;
  const meta = [model, isRouter ? "routes the team" : tools.join(", ") || "no tools"]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className={`flow-node flow-node--${state}`}
      style={{ ...agentStyle(index), width: agentWidth(id) }}
      role="button"
      tabIndex={0}
      aria-label={label}
      title={state === "failed" && error ? error : role}
      // Mouse clicks arrive through ReactFlow's onNodeClick (it only lets pointer events
      // reach nodes when that handler is set); keyboard activation is handled here.
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <Handle
        type="target"
        position={direction === "LR" ? Position.Left : Position.Top}
        isConnectable={false}
      />
      <span className="flow-node__idx">
        {agentIndex(index)}
        {isRouter && <span className="flow-node__tag">router</span>}
      </span>
      <span className="flow-node__name">{id}</span>
      <span className="flow-node__state">
        <span className={`pill pill--${PILL_TONE[state]} flow-node__pill`}>
          {state === "running" ? (
            <span className="spin spin--sm" aria-hidden="true" />
          ) : (
            STATE_ICON[state] && (
              // Re-mounted on each state change, so a fresh check pops once.
              <span key={state} className={state === "completed" ? "ap-pop flow-node__icon" : "flow-node__icon"}>
                <Icon name={STATE_ICON[state]} size={12} />
              </span>
            )
          )}
          {STATE_LABEL[state]}
        </span>
        {time != null && <span className="flow-node__time">{formatDuration(time)}</span>}
      </span>
      <span className="flow-node__meta">{meta}</span>
      <Handle
        type="source"
        position={direction === "LR" ? Position.Right : Position.Bottom}
        isConnectable={false}
      />
    </div>
  );
}

function TerminalNode({ data }) {
  return (
    <div className={`flow-terminal flow-terminal--${data.state}`}>
      {data.kind === END && (
        <Handle
          type="target"
          position={data.direction === "LR" ? Position.Left : Position.Top}
          isConnectable={false}
        />
      )}
      <Icon name={data.kind === START ? "play" : "flag"} size={12} />
      {data.kind === START ? "Start" : "End"}
      {data.kind === START && (
        <Handle
          type="source"
          position={data.direction === "LR" ? Position.Right : Position.Bottom}
          isConnectable={false}
        />
      )}
    </div>
  );
}

function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}) {
  // Level handles (a sequential chain) get a dead-straight line; branches keep the curve.
  // Measured sizes are whole pixels, so "level" allows a pixel or two of rounding, which is
  // snapped away rather than drawn as a slant.
  const horizontal = sourcePosition === Position.Right && targetPosition === Position.Left;
  const vertical = sourcePosition === Position.Bottom && targetPosition === Position.Top;
  const levelH = horizontal && Math.abs(sourceY - targetY) < 2;
  const levelV = vertical && Math.abs(sourceX - targetX) < 2;
  const [path] =
    levelH || levelV
      ? getStraightPath({
          sourceX,
          sourceY,
          targetX: levelV ? sourceX : targetX,
          targetY: levelH ? sourceY : targetY,
        })
      : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <g
      className={`flow-edge flow-edge--${data.state}`}
      style={{ "--edge-color": data.color }}
    >
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {data.state === "active" && (
        <path className="flow-edge__dash" d={path} fill="none" />
      )}
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
  const { theme } = useTheme();
  const containerRef = useRef(null);
  const [direction, setDirection] = useState("LR");
  const flowRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setDirection(entry.contentRect.width < NARROW_PX ? "TB" : "LR");
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const colorOf = useMemo(
    () => Object.fromEntries(graph.agents.map((a) => [a.id, a.color])),
    [graph],
  );
  const now = serverNow(run, clock);

  // React Flow measures each node and keeps where its handles are, but only while the node
  // objects it gets back carry `measured`: a new object without it (every run update makes
  // new ones) drops the handle positions, and edges vanish until the node happens to
  // resize. Keep the measurements it reports and pass them back with every node.
  const [measured, setMeasured] = useState({});
  const onNodesChange = useCallback((changes) => {
    const sized = changes.filter(
      (c) => c.type === "dimensions" && c.dimensions,
    );
    if (sized.length === 0) return;
    setMeasured((current) => {
      let changed = false;
      const next = { ...current };
      for (const c of sized) {
        const { width, height } = c.dimensions;
        const had = current[c.id];
        if (had && Math.abs(had.width - width) < 0.5 && Math.abs(had.height - height) < 0.5) continue;
        next[c.id] = { width, height };
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);

  // Re-laid out once the nodes are measured, so dagre works with their real sizes.
  const positions = useMemo(
    () => layoutGraph(graph, direction, measured),
    [graph, direction, measured],
  );

  // The first measurement moves nodes a few pixels (dagre now has their real sizes): fit
  // the view again, once, so the graph stays centred. A user's own zoom is left alone.
  const layoutSignature = JSON.stringify(
    Object.entries(positions).map(([id, p]) => [id, Math.round(p.x), Math.round(p.y)]),
  );
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      flowRef.current?.fitView({ padding: 0.12, maxZoom: 1 }),
    );
    return () => cancelAnimationFrame(id);
  }, [layoutSignature]);

  const nodes = useMemo(
    () => [
      ...[START, END].map((kind) => ({
        id: kind,
        type: "terminal",
        position: positions[kind],
        data: { kind, state: terminalState(kind, run), direction },
        measured: measured[kind],
        selectable: false,
        focusable: false,
      })),
      ...graph.agents.map((agent) => {
        const node = run.nodes[agent.id];
        return {
          id: agent.id,
          type: "agent",
          position: positions[agent.id],
          measured: measured[agent.id],
          selectable: false,
          focusable: false,
          data: {
            ...agent,
            state: node?.status ?? "idle",
            durationMs: node?.durationMs,
            liveMs:
              node?.status === "running" &&
              node.startedAt != null &&
              now != null
                ? Math.max(0, (now - node.startedAt) * 1000)
                : null,
            error: node?.error,
            direction,
            onSelect: () => onSelectAgent(agent.id),
          },
        };
      }),
    ],
    [graph, positions, run, direction, now, onSelectAgent, measured],
  );

  const edges = useMemo(
    () =>
      graph.edges.map((edge) => {
        const state = edgeState(edge, run);
        const color =
          colorOf[edge.target] ?? colorOf[edge.source] ?? "var(--accent)";
        return {
          ...edge,
          type: "flow",
          className: state === "pending" ? "ap-edge-flow" : undefined,
          data: { state, color },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color:
              state === "idle" || state === "pending"
                ? "var(--border-strong)"
                : state === "failed"
                  ? "var(--danger)"
                  : color,
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
        onInit={(instance) => {
          flowRef.current = instance;
        }}
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
        colorMode={theme}
        onNodesChange={onNodesChange}
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
