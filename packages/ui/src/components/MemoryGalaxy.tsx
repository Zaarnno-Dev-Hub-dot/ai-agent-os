import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/gatewayStore';
import { fetchMemoryGraph, type MemoryGraph, type MemoryGraphNode } from '../lib/memoryGraph';

/** A graph node plus the mutable physics/render state the force sim owns. */
interface SimNode extends MemoryGraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  brightness: number;
}

interface SimLink {
  source: SimNode;
  target: SimNode;
}

const REPULSION = 2600;
const LINK_DISTANCE = 76;
const LINK_STRENGTH = 0.06;
const CENTER_STRENGTH = 0.02;
const DAMPING = 0.86;
const ALPHA_DECAY = 0.985;
const ALPHA_MIN = 0.01;
const MIN_SCALE = 0.15;
const MAX_SCALE = 4;
const MIN_RADIUS = 2.2;
const MAX_RADIUS = 7;
const MIN_BRIGHTNESS = 0.35;
const MAX_BRIGHTNESS = 1;
const HIT_PADDING = 4;

function buildSim(graph: MemoryGraph, width: number, height: number): { nodes: SimNode[]; links: SimLink[] } {
  const mtimes = graph.nodes.map((n) => n.mtime);
  const minM = mtimes.length ? Math.min(...mtimes) : 0;
  const maxM = mtimes.length ? Math.max(...mtimes) : 1;
  const span = maxM - minM || 1;

  const byId = new Map<string, SimNode>();
  const nodes: SimNode[] = graph.nodes.map((n) => {
    const recency = (n.mtime - minM) / span; // 0 (oldest) .. 1 (newest)
    const angle = Math.random() * Math.PI * 2;
    const radiusFromCenter = 40 + Math.random() * Math.min(width, height) * 0.35;
    const node: SimNode = {
      ...n,
      x: width / 2 + Math.cos(angle) * radiusFromCenter,
      y: height / 2 + Math.sin(angle) * radiusFromCenter,
      vx: 0,
      vy: 0,
      radius: MIN_RADIUS + recency * (MAX_RADIUS - MIN_RADIUS),
      brightness: MIN_BRIGHTNESS + recency * (MAX_BRIGHTNESS - MIN_BRIGHTNESS),
    };
    byId.set(n.id, node);
    return node;
  });

  const links: SimLink[] = [];
  for (const l of graph.links) {
    const source = byId.get(l.source);
    const target = byId.get(l.target);
    if (source && target) links.push({ source, target });
  }
  return { nodes, links };
}

function tick(nodes: SimNode[], links: SimLink[], alpha: number, width: number, height: number): void {
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 0.01) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        distSq = dx * dx + dy * dy;
      }
      const dist = Math.sqrt(distSq);
      const force = (REPULSION * alpha) / distSq;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  for (const link of links) {
    const { source: a, target: b } = link;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const force = (dist - LINK_DISTANCE) * LINK_STRENGTH * alpha;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  for (const n of nodes) {
    n.vx += (width / 2 - n.x) * CENTER_STRENGTH * alpha;
    n.vy += (height / 2 - n.y) * CENTER_STRENGTH * alpha;
  }

  for (const n of nodes) {
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += n.vx;
    n.y += n.vy;
  }
}

/**
 * Studio Dock route app `memory-galaxy` (docs/DESIGN-studio-dock.md §4):
 * renders the vault's notes + wikilink edges as a star field. Hand-rolled
 * canvas force sim — no new deps (design doc: "fine at ~200 nodes"; the
 * gateway already caps the graph at 500 newest, so this only ever lays out
 * what the API actually returns). Governance exclusions are entirely a
 * backend concern (memory.ts) — this component just renders whatever
 * `/api/memory/graph` sends.
 */
export function MemoryGalaxy() {
  const openMemoryPath = useStore((s) => s.openMemoryPath);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mutable sim/view state lives in refs — driven by a rAF loop, never
  // through React state (would re-render every physics tick / mousemove).
  const simRef = useRef<{ nodes: SimNode[]; links: SimLink[]; alpha: number } | null>(null);
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  const hoverRef = useRef<SimNode | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; viewX: number; viewY: number } | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    let cancelled = false;
    fetchMemoryGraph()
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load memory graph.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build the sim once the graph loads (and whenever the container is sized).
  useEffect(() => {
    if (!graph || !containerRef.current) return;
    const { clientWidth: width, clientHeight: height } = containerRef.current;
    sizeRef.current = { width, height };
    simRef.current = { ...buildSim(graph, width, height), alpha: 1 };
    viewRef.current = { x: 0, y: 0, scale: 1 };
  }, [graph]);

  // rAF render/physics loop + resize + pointer interaction.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    // Re-bound to a non-nullable-typed const: TS control-flow narrowing on
    // `ctx2d` doesn't survive into the nested `frame` closure below, but a
    // fresh binding with a non-null type annotation does.
    const ctx: CanvasRenderingContext2D = ctx2d;

    const dpr = window.devicePixelRatio || 1;

    function resize() {
      if (!canvas || !container) return;
      const { clientWidth: width, clientHeight: height } = container;
      sizeRef.current = { width, height };
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    function toGraphSpace(clientX: number, clientY: number): { x: number; y: number } {
      const rect = canvas!.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      const view = viewRef.current;
      return { x: (screenX - view.x) / view.scale, y: (screenY - view.y) / view.scale };
    }

    function hitTest(clientX: number, clientY: number): SimNode | null {
      const sim = simRef.current;
      if (!sim) return null;
      const { x: gx, y: gy } = toGraphSpace(clientX, clientY);
      let best: SimNode | null = null;
      let bestDistSq = Infinity;
      for (const n of sim.nodes) {
        const dx = n.x - gx;
        const dy = n.y - gy;
        const distSq = dx * dx + dy * dy;
        const r = n.radius + HIT_PADDING;
        if (distSq <= r * r && distSq < bestDistSq) {
          best = n;
          bestDistSq = distSq;
        }
      }
      return best;
    }

    function onMouseDown(e: MouseEvent) {
      dragRef.current = { startX: e.clientX, startY: e.clientY, viewX: viewRef.current.x, viewY: viewRef.current.y };
    }
    function onMouseMove(e: MouseEvent) {
      if (dragRef.current) {
        const d = dragRef.current;
        viewRef.current.x = d.viewX + (e.clientX - d.startX);
        viewRef.current.y = d.viewY + (e.clientY - d.startY);
        if (tooltipRef.current) tooltipRef.current.style.display = 'none';
        hoverRef.current = null;
        return;
      }
      const hit = hitTest(e.clientX, e.clientY);
      hoverRef.current = hit;
      const tip = tooltipRef.current;
      const rect = canvas!.getBoundingClientRect();
      if (hit && tip) {
        tip.textContent = hit.title;
        tip.style.left = `${e.clientX - rect.left + 12}px`;
        tip.style.top = `${e.clientY - rect.top + 12}px`;
        tip.style.display = 'block';
        canvas!.style.cursor = 'pointer';
      } else if (tip) {
        tip.style.display = 'none';
        canvas!.style.cursor = 'grab';
      }
    }
    function onMouseUp(e: MouseEvent) {
      const wasDrag = dragRef.current;
      dragRef.current = null;
      if (!wasDrag) return;
      const moved = Math.abs(e.clientX - wasDrag.startX) > 3 || Math.abs(e.clientY - wasDrag.startY) > 3;
      if (!moved) {
        const hit = hitTest(e.clientX, e.clientY);
        if (hit) openMemoryPath(hit.path);
      }
    }
    function onMouseLeave() {
      dragRef.current = null;
      hoverRef.current = null;
      if (tooltipRef.current) tooltipRef.current.style.display = 'none';
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = canvas!.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const view = viewRef.current;
      const zoomFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * zoomFactor));
      const wx = (mouseX - view.x) / view.scale;
      const wy = (mouseY - view.y) / view.scale;
      view.scale = newScale;
      view.x = mouseX - wx * newScale;
      view.y = mouseY - wy * newScale;
    }

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let raf = 0;
    function frame() {
      const sim = simRef.current;
      const { width, height } = sizeRef.current;
      if (sim && width > 0 && height > 0) {
        if (sim.alpha > ALPHA_MIN) {
          tick(sim.nodes, sim.links, sim.alpha, width, height);
          sim.alpha *= ALPHA_DECAY;
        }
        const view = viewRef.current;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.translate(view.x, view.y);
        ctx.scale(view.scale, view.scale);

        ctx.strokeStyle = 'rgba(201, 163, 92, 0.16)';
        ctx.lineWidth = 1 / view.scale;
        ctx.beginPath();
        for (const l of sim.links) {
          ctx.moveTo(l.source.x, l.source.y);
          ctx.lineTo(l.target.x, l.target.y);
        }
        ctx.stroke();

        const hovered = hoverRef.current;
        for (const n of sim.nodes) {
          const isHovered = hovered?.id === n.id;
          ctx.beginPath();
          ctx.fillStyle = isHovered ? 'rgba(255,255,255,0.95)' : `rgba(201, 163, 92, ${n.brightness})`;
          ctx.arc(n.x, n.y, isHovered ? n.radius + 1.5 : n.radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [graph, openMemoryPath]);

  const starCount = graph?.nodes.length ?? 0;
  const linkCount = graph?.links.length ?? 0;
  const total = graph?.totalNotes ?? 0;

  return (
    <div className="memory-galaxy">
      <header className="memory-galaxy-hdr">
        <div className="memory-galaxy-title">Memory Galaxy</div>
        <div className="memory-galaxy-chips">
          <span className="memory-galaxy-chip">{starCount} stars</span>
          <span className="memory-galaxy-chip">{linkCount} links</span>
          {total > starCount && (
            <span className="memory-galaxy-chip memory-galaxy-chip-cap">
              showing {starCount} of {total}
            </span>
          )}
        </div>
      </header>

      {error ? (
        <div className="memory-galaxy-empty">
          <div className="empty-hint">Couldn't load the memory graph — {error}</div>
        </div>
      ) : graph && graph.nodes.length === 0 ? (
        <div className="memory-galaxy-empty">
          <div className="empty-hint">No indexed vault notes yet.</div>
        </div>
      ) : (
        <div className="memory-galaxy-canvas-wrap" ref={containerRef}>
          <canvas ref={canvasRef} className="memory-galaxy-canvas" />
          <div ref={tooltipRef} className="memory-galaxy-tooltip" style={{ display: 'none' }} />
          {!graph && <div className="memory-galaxy-loading empty-hint">Loading the vault…</div>}
        </div>
      )}
    </div>
  );
}
