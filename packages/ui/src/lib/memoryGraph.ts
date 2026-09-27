import { gatewayHttpOrigin } from './gatewayOrigin';

const GATEWAY_ORIGIN = gatewayHttpOrigin();

/** Mirrors packages/gateway/src/memory.ts's MemoryGraph* shapes (docs/DESIGN-studio-dock.md §4). */
export interface MemoryGraphNode {
  id: string;
  title: string;
  path: string;
  mtime: number;
  size: number;
}

export interface MemoryGraphLink {
  source: string;
  target: string;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
  totalNotes: number;
}

export async function fetchMemoryGraph(): Promise<MemoryGraph> {
  const res = await fetch(`${GATEWAY_ORIGIN}/api/memory/graph`);
  if (!res.ok) throw new Error(`Failed to load memory graph: ${res.status}`);
  return (await res.json()) as MemoryGraph;
}
