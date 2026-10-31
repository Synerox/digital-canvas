/**
 * Layout: Diagram -> ELK layered graph -> absolute positions.
 * Signals flow left to right; inputs sit in the first layer, outputs in the last.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import type { DEdge, DNode, Diagram, Side } from '../core/diagram';

export interface Point {
  x: number;
  y: number;
}

export interface LPort {
  id: string;
  name: string;
  side: Side;
  dir: 'in' | 'out';
  width: number;
  /** Absolute position. */
  x: number;
  y: number;
}

export interface LNode extends Omit<DNode, 'ports'> {
  x: number;
  y: number;
  width: number;
  height: number;
  ports: LPort[];
}

export interface LEdge extends DEdge {
  points: Point[];
  junctions: Point[];
  labelBox?: { x: number; y: number; width: number; height: number };
}

export interface LayoutResult {
  module: string;
  width: number;
  height: number;
  nodes: LNode[];
  edges: LEdge[];
}

export type MeasureText = (text: string, fontSize: number, bold?: boolean) => number;

/** Rough text width for Helvetica-like fonts; good enough when no canvas is available. */
export const approxMeasure: MeasureText = (text, size, bold) => {
  let w = 0;
  for (const ch of text) {
    if (/[⺀-￿]/.test(ch)) w += size;
    else if (/[ilj.,:;'|![\]]/.test(ch)) w += size * 0.3;
    else if (/[mwMW@]/.test(ch)) w += size * 0.85;
    else if (/[A-Z0-9]/.test(ch)) w += size * 0.66;
    else w += size * 0.56;
  }
  return w * (bold ? 1.06 : 1);
};

export const FONT = {
  title: 13,
  sub: 11,
  port: 11,
  pin: 12,
  label: 11,
  op: 14,
};

const ROW = 20;

interface Sized {
  width: number;
  height: number;
  /** Port positions relative to the node. */
  ports: Record<string, Point>;
}

function sizeNode(n: DNode, measure: MeasureText): Sized {
  const west = n.ports.filter((p) => p.side === 'WEST');
  const east = n.ports.filter((p) => p.side === 'EAST');
  const south = n.ports.filter((p) => p.side === 'SOUTH');
  const ports: Record<string, Point> = {};

  if (n.kind === 'input' || n.kind === 'output' || n.kind === 'inout') {
    const width = Math.ceil(measure(n.label, FONT.pin) + (n.kind === 'inout' ? 30 : 22));
    const height = 20;
    for (const p of n.ports) ports[p.id] = { x: p.side === 'EAST' ? width : 0, y: height / 2 };
    return { width, height, ports };
  }

  if (n.kind === 'const') {
    const width = Math.ceil(measure(n.label, FONT.label) + 6);
    const height = 16;
    for (const p of n.ports) ports[p.id] = { x: width, y: height / 2 };
    return { width, height, ports };
  }

  if (n.kind === 'join') {
    // Thin concatenation bar; inputs on a 20px pitch, output in the middle.
    const height = Math.max(20, west.length * ROW);
    const width = 6;
    west.forEach((p, k) => (ports[p.id] = { x: 0, y: ROW / 2 + k * ROW }));
    east.forEach((p) => (ports[p.id] = { x: width, y: height / 2 }));
    return { width, height, ports };
  }

  if (n.kind === 'instance') {
    const header = 22 + (n.subLabel ? 14 : 0);
    const rows = Math.max(west.length, east.length, 1);
    const height = header + rows * ROW + 6;
    const wl = Math.max(0, ...west.map((p) => measure(p.name, FONT.port)));
    const el = Math.max(0, ...east.map((p) => measure(p.name, FONT.port)));
    const width = Math.ceil(
      Math.max(
        96,
        measure(n.label, FONT.title, true) + 28,
        n.subLabel ? measure(n.subLabel, FONT.sub) + 28 : 0,
        wl + el + 40,
      ),
    );
    const w2 = Math.ceil(width / 2) * 2;
    west.forEach((p, k) => (ports[p.id] = { x: 0, y: header + ROW / 2 + k * ROW }));
    east.forEach((p, k) => (ports[p.id] = { x: w2, y: header + ROW / 2 + k * ROW }));
    // Instances normally use only WEST/EAST, but never leave a port without a position.
    const north = n.ports.filter((p) => p.side === 'NORTH');
    south.forEach((p, k) => (ports[p.id] = { x: (w2 * (k + 1)) / (south.length + 1), y: height }));
    north.forEach((p, k) => (ports[p.id] = { x: (w2 * (k + 1)) / (north.length + 1), y: 0 }));
    return { width: w2, height, ports };
  }

  // Primitive cell: compact operator box; ports on a 20px pitch centred vertically.
  const isMux = n.cellType === '$mux' || n.cellType === '$pmux' || n.cellType === '$bmux';
  const rows = Math.max(west.length, east.length, isMux ? 2 : 1);
  const height = Math.max(40, rows * ROW + (isMux ? 20 : 0));
  const width = Math.max(isMux ? 30 : 40, Math.ceil(measure(n.label, FONT.op) + 16));
  const place = (list: typeof west, x: number) => {
    const start = height / 2 - ((list.length - 1) * ROW) / 2;
    list.forEach((p, k) => (ports[p.id] = { x, y: start + k * ROW }));
  };
  place(west, 0);
  place(east, width);
  south.forEach((p, k) => {
    const x = (width * (k + 1)) / (south.length + 1);
    // A MUX's bottom edge slopes up towards the output: put the select pin on the outline.
    const inset = isMux ? (Math.min(10, height / 4) * x) / width : 0;
    ports[p.id] = { x, y: height - inset };
  });
  return { width, height, ports };
}

let elkInstance: InstanceType<typeof ELK> | undefined;

export async function layoutDiagram(d: Diagram, measure: MeasureText = approxMeasure): Promise<LayoutResult> {
  const elk = (elkInstance ??= new ELK());
  const sized = new Map<string, Sized>();
  for (const n of d.nodes) sized.set(n.id, sizeNode(n, measure));

  // ELK resolves node and port IDs in one namespace; give it opaque IDs so names like `a.out` cannot collide.
  const elkNode = new Map<string, string>();
  const elkPort = new Map<string, string>();
  const nodeOfElk = new Map<string, string>();
  d.nodes.forEach((n, i) => {
    elkNode.set(n.id, `n${i}`);
    nodeOfElk.set(`n${i}`, n.id);
    n.ports.forEach((p) => elkPort.set(p.id, `p${elkPort.size}`));
  });

  const children: ElkNode[] = d.nodes.map((n) => {
    const s = sized.get(n.id)!;
    const layoutOptions: Record<string, string> = { 'elk.portConstraints': 'FIXED_POS' };
    if (n.kind === 'input') layoutOptions['elk.layered.layering.layerConstraint'] = 'FIRST';
    if (n.kind === 'output') layoutOptions['elk.layered.layering.layerConstraint'] = 'LAST';
    const ports: ElkPort[] = n.ports.map((p) => ({
      id: elkPort.get(p.id)!,
      x: s.ports[p.id].x,
      y: s.ports[p.id].y,
      width: 0,
      height: 0,
      layoutOptions: { 'elk.port.side': p.side },
    }));
    return { id: elkNode.get(n.id)!, width: s.width, height: s.height, ports, layoutOptions };
  });

  const edges: ElkExtendedEdge[] = d.edges.map((e) => ({
    id: e.id,
    sources: [elkPort.get(e.source.port)!],
    targets: [elkPort.get(e.target.port)!],
    labels: e.label
      ? [
          {
            id: `${e.id}.label`,
            text: e.label,
            width: Math.ceil(measure(e.label, FONT.label)) + 4,
            height: 13,
            layoutOptions: { 'elk.edgeLabels.placement': 'HEAD' },
          },
        ]
      : [],
  }));

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
      'elk.spacing.nodeNode': '28',
      'elk.spacing.edgeEdge': '10',
      'elk.spacing.edgeNode': '14',
      'elk.spacing.edgeLabel': '3',
      'elk.layered.spacing.nodeNodeBetweenLayers': '48',
      'elk.layered.spacing.edgeNodeBetweenLayers': '20',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
      // Network simplex gives straighter wires but is slow on large graphs (layout runs on the main thread).
      'elk.layered.nodePlacement.strategy': d.nodes.length + d.edges.length <= 150 ? 'NETWORK_SIMPLEX' : 'BRANDES_KOEPF',
      // Keep inputs in the first layer and outputs in the last even when the module has independent parts.
      'elk.separateConnectedComponents': 'false',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.edgeLabels.sideSelection': 'ALWAYS_UP',
    },
    children,
    edges,
  };

  const out = await elk.layout(graph);

  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const nodes: LNode[] = (out.children ?? []).map((c) => {
    const id = nodeOfElk.get(c.id)!;
    const n = byId.get(id)!;
    const s = sized.get(id)!;
    const x = c.x ?? 0;
    const y = c.y ?? 0;
    return {
      ...n,
      x,
      y,
      width: s.width,
      height: s.height,
      ports: n.ports.map((p) => ({
        id: p.id,
        name: p.name,
        side: p.side,
        dir: p.dir,
        width: p.width,
        x: x + s.ports[p.id].x,
        y: y + s.ports[p.id].y,
      })),
    };
  });

  const edgeById = new Map(d.edges.map((e) => [e.id, e]));
  const lEdges: LEdge[] = ((out.edges ?? []) as (ElkExtendedEdge & { junctionPoints?: Point[] })[]).map((e) => {
    const base = edgeById.get(e.id)!;
    const points: Point[] = [];
    for (const sec of e.sections ?? []) {
      points.push(sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint);
    }
    const lab = e.labels?.[0];
    return {
      ...base,
      points,
      junctions: e.junctionPoints ?? [],
      labelBox:
        lab && lab.x !== undefined && lab.y !== undefined
          ? { x: lab.x, y: lab.y, width: lab.width ?? 0, height: lab.height ?? 0 }
          : undefined,
    };
  });

  // An empty module still gets a small canvas, so export never produces a 0x0 image.
  return { module: d.module, width: Math.max(out.width ?? 0, 48), height: Math.max(out.height ?? 0, 48), nodes, edges: lEdges };
}
