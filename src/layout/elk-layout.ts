/**
 * Layout: Diagram -> ELK layered graph -> absolute positions.
 * Signals flow left to right; inputs sit in the first layer, outputs in the last.
 */
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import type { DEdge, DNode, DPort, Diagram, Side } from '../core/diagram';
import { alignToGrid } from './grid-align';

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
  /** Top-left corner of the drawing (0 for ELK output; edited sheets can extend anywhere). */
  x?: number;
  y?: number;
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

/** Port pitch. Ports sit on multiples of GRID from the node's corner, so nodes placed on the grid get straight wires. */
const ROW = 20;
export const GRID = 10;

export interface Sized {
  width: number;
  height: number;
  /** Port positions relative to the node. */
  ports: Record<string, Point>;
}

/**
 * A text-measured length rounded up to the grid, so a pin at that distance from the
 * node's corner is on the grid too. (Text widths are fractional; the small slack keeps
 * a width such as 40.000000001 from growing a whole step.)
 */
const toGrid = (v: number) => Math.ceil(v / GRID - 1e-6) * GRID;

/**
 * The width of a node with `count` pins on its top or bottom edge: at least `min`, room
 * for the pins ROW apart and a grid step from each corner, and a multiple of 2 * GRID,
 * so that pins centred on the edge (edgePinX) are on the grid.
 */
function edgeWidth(min: number, count: number): number {
  if (count === 0) return toGrid(min);
  return Math.ceil(Math.max(min, (count - 1) * ROW + 2 * GRID) / (2 * GRID) - 1e-6) * 2 * GRID;
}

/** x of pin `k` of `count` pins centred on a top or bottom edge `width` long (see edgeWidth), ROW apart. */
function edgePinX(k: number, count: number, width: number): number {
  return (width - (count - 1) * ROW) / 2 + k * ROW;
}

/** Adder, subtractor and multiplier: drawn as an ALU, a trapezoid with a notch between its two operands. */
export function isAluType(t: string | undefined): boolean {
  return t === '$add' || t === '$sub' || t === '$mul';
}

export type GateShape = 'and' | 'or' | 'xor';

/** The outline a logic gate is drawn with, or undefined for a cell that is not one of these gates. */
export function gateShape(t: string | undefined): GateShape | undefined {
  switch (t) {
    case '$and':
    case '$logic_and':
    case '$reduce_and':
    case 'dc:and':
    case 'dc:nand':
    case 'dc:reduce_nand':
      return 'and';
    case '$or':
    case '$logic_or':
    case '$reduce_or':
    case '$reduce_bool':
    case 'dc:nor':
    case 'dc:reduce_nor':
      return 'or';
    case '$xor':
    case '$xnor':
    case '$reduce_xor':
    case '$reduce_xnor':
      return 'xor';
    default:
      return undefined;
  }
}

/** Gates with a bubble on their output. */
export function invertsOutput(t: string | undefined): boolean {
  return t === 'dc:nand' || t === 'dc:nor' || t === '$xnor' || t === '$reduce_xnor' || t === 'dc:reduce_nand' || t === 'dc:reduce_nor';
}

/**
 * Reduction gates (`&a`, `|a`, `^a`, `~&a`, `~|a`, `~^a`; `$reduce_bool` is the `|a` of a condition): all the bits of
 * their one input into one bit. Drawn as the gate with that input in the middle of its back, fanned out into
 * bits in a lead before it (REDUCE_LEAD).
 */
export function isReduceType(t: string | undefined): boolean {
  return (
    t === '$reduce_and' ||
    t === '$reduce_or' ||
    t === '$reduce_xor' ||
    t === '$reduce_xnor' ||
    t === '$reduce_bool' ||
    t === 'dc:reduce_nand' ||
    t === 'dc:reduce_nor'
  );
}

/**
 * The lead of a reduction gate: the first grid step of its symbol, between its input pin on the left edge and the
 * gate's back, where its bus input fans out into bits (see the renderer). Inside the symbol, so its wire ends at the
 * pin as any wire does: its bus mark, its label and what is drawn over a selected wire stay clear of the fan.
 */
export const REDUCE_LEAD = GRID;

/** The bus input of a reduction gate, which is drawn fanned out into bits (see REDUCE_LEAD); undefined for any other symbol. */
export function fannedInput<P extends DPort>(n: { kind: DNode['kind']; cellType?: string; ports: P[] }): P | undefined {
  if (n.kind !== 'cell' || !isReduceType(n.cellType)) return undefined;
  const ins = n.ports.filter((p) => p.side === 'WEST');
  return ins.length === 1 && ins[0].width > 1 ? ins[0] : undefined;
}

/**
 * Height of a gate's body: as tall as the symbol up to four inputs. A gate with more inputs keeps that
 * body, centred, and its back edge runs on straight up and down to the outer inputs (as textbooks draw a
 * gate with many inputs), instead of the body stretching into a long thin bullet. With an odd number of
 * inputs the body is one input taller, or the outer two of those it covers would meet its corners.
 */
export function gateBodyHeight(height: number): number {
  if (height <= 4 * ROW) return height;
  return Math.round(height / ROW) % 2 === 1 ? 5 * ROW : 4 * ROW;
}

/** Width of a gate as tall as `height`: wider as the body grows, so it keeps its shape. */
function gateWidth(height: number): number {
  return 40 + (Math.min(gateBodyHeight(height), 4 * ROW) - 40) / 2;
}

/**
 * How far a MUX's top and bottom edges drop towards its output: a quarter of its height, but never
 * steeper than one in two, so a MUX with many inputs keeps a long output edge.
 */
export function muxInset(width: number, height: number): number {
  return Math.min(height / 4, width / 2);
}

/**
 * Size of a symbol and where its ports are, relative to its top-left corner. Every
 * size and port offset is a multiple of GRID, so a symbol placed on the grid has its
 * pins on it.
 */
export function sizeNode(n: DNode, measure: MeasureText): Sized {
  const west = n.ports.filter((p) => p.side === 'WEST');
  const east = n.ports.filter((p) => p.side === 'EAST');
  const south = n.ports.filter((p) => p.side === 'SOUTH');
  const ports: Record<string, Point> = {};

  if (n.kind === 'input' || n.kind === 'output' || n.kind === 'inout') {
    const width = toGrid(measure(n.label, FONT.pin) + (n.kind === 'inout' ? 30 : 22));
    const height = 20;
    for (const p of n.ports) ports[p.id] = { x: p.side === 'EAST' ? width : 0, y: height / 2 };
    return { width, height, ports };
  }

  if (n.kind === 'text') {
    const lines = n.label.split('\n');
    const width = Math.ceil(Math.max(8, ...lines.map((l) => measure(l, FONT.pin))) + 4);
    return { width, height: lines.length * 16 + 4, ports };
  }

  if (n.kind === 'const') {
    const width = toGrid(measure(n.label, FONT.label) + 6);
    const height = 20;
    for (const p of n.ports) ports[p.id] = { x: width, y: height / 2 };
    return { width, height, ports };
  }

  if (n.kind === 'join') {
    // Thin concatenation bar, one grid step wide so the output is on the grid; inputs on a 20px pitch, output in the middle.
    const height = Math.max(20, west.length * ROW);
    const width = GRID;
    west.forEach((p, k) => (ports[p.id] = { x: 0, y: ROW / 2 + k * ROW }));
    east.forEach((p) => (ports[p.id] = { x: width, y: height / 2 }));
    return { width, height, ports };
  }

  if (n.kind === 'split') {
    // The mirror of a join: one bus in on the left, its slices out on the right.
    const height = Math.max(20, east.length * ROW);
    const width = GRID;
    east.forEach((p, k) => (ports[p.id] = { x: width, y: ROW / 2 + k * ROW }));
    west.forEach((p) => (ports[p.id] = { x: 0, y: height / 2 }));
    return { width, height, ports };
  }

  if (n.kind === 'instance') {
    // Header and padding are multiples of the grid so the ports land on it.
    const header = 30 + (n.subLabel ? 20 : 0);
    const rows = Math.max(west.length, east.length, 1);
    const height = header + rows * ROW;
    const wl = Math.max(0, ...west.map((p) => measure(p.name, FONT.port)));
    const el = Math.max(0, ...east.map((p) => measure(p.name, FONT.port)));
    // Instances normally use only WEST/EAST, but never leave a port without a position.
    const north = n.ports.filter((p) => p.side === 'NORTH');
    const width = edgeWidth(
      Math.max(96, measure(n.label, FONT.title, true) + 28, n.subLabel ? measure(n.subLabel, FONT.sub) + 28 : 0, wl + el + 40),
      Math.max(south.length, north.length),
    );
    west.forEach((p, k) => (ports[p.id] = { x: 0, y: header + ROW / 2 + k * ROW }));
    east.forEach((p, k) => (ports[p.id] = { x: width, y: header + ROW / 2 + k * ROW }));
    south.forEach((p, k) => (ports[p.id] = { x: edgePinX(k, south.length, width), y: height }));
    north.forEach((p, k) => (ports[p.id] = { x: edgePinX(k, north.length, width), y: 0 }));
    return { width, height, ports };
  }

  // Primitive cell: compact operator box; ports on a 20px pitch centred vertically.
  const isMux = isMuxType(n.cellType);
  const isAlu = isAluType(n.cellType);
  const gate = gateShape(n.cellType);
  const rows = Math.max(west.length, east.length, isMux || isAlu ? 2 : 1);
  // A MUX and an ALU have a grid step above and below their inputs, for their sloped edges.
  const height = Math.max(40, rows * ROW + (isMux || isAlu ? 20 : 0));
  // A MUX or an ALU is as narrow as a gate, whatever it is called (the MUX writes no name, and an
  // ALU's sign fits); a gate is wider as its body grows, so the body keeps its shape.
  const width =
    isMux || isAlu
      ? edgeWidth(40, south.length)
      : gate
        ? edgeWidth(gateWidth(height) + (isReduceType(n.cellType) ? REDUCE_LEAD : 0), south.length)
        : edgeWidth(Math.max(40, measure(n.label, FONT.op) + 16), south.length);
  const place = (list: typeof west, x: number) => {
    const start = height / 2 - ((list.length - 1) * ROW) / 2;
    list.forEach((p, k) => (ports[p.id] = { x, y: start + k * ROW }));
  };
  if (isAlu && west.length === 2) {
    // The operands come in above and below the notch, half way along the straight parts of the left edge.
    ports[west[0].id] = { x: 0, y: GRID };
    ports[west[1].id] = { x: 0, y: height - GRID };
  } else {
    place(west, 0);
  }
  place(east, width);
  // Pins on the bottom edge, on the grid: a MUX's select pin is on the grid line under its sloped
  // bottom edge, which a short lead joins (see the renderer).
  south.forEach((p, k) => (ports[p.id] = { x: edgePinX(k, south.length, width), y: height }));
  return { width, height, ports };
}

/**
 * The size sizeNode gave a cell with the symbol outlines of version `outlines` (see OUTLINES in editor/doc), for the
 * cells whose size changed since; undefined for the others. Before version 2 an adder was 40x40, a MUX 60 wide, a
 * gate 40 wide whatever its inputs; before version 3 a reduction gate had no lead (REDUCE_LEAD).
 */
export function legacyCellSize(n: DNode, measure: MeasureText, outlines: number): { width: number; height: number } | undefined {
  const isMux = isMuxType(n.cellType);
  if (n.kind !== 'cell' || !(isMux || isAluType(n.cellType) || gateShape(n.cellType))) return undefined;
  if (outlines >= 2) {
    if (!isReduceType(n.cellType)) return undefined;
    const s = sizeNode(n, measure);
    return { width: s.width - REDUCE_LEAD, height: s.height };
  }
  const count = (side: Side) => n.ports.filter((p) => p.side === side).length;
  const rows = Math.max(count('WEST'), count('EAST'), isMux ? 2 : 1);
  return {
    width: edgeWidth(Math.max(isMux ? 30 : 40, measure(n.label, FONT.op) + 16), count('SOUTH')),
    height: Math.max(40, rows * ROW + (isMux ? 20 : 0)),
  };
}

export function isMuxType(t: string | undefined): boolean {
  return t === '$mux' || t === '$pmux' || t === '$bmux' || t === 'dc:mux';
}

export interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
  terminateWorker?(): void;
}

/** Makes a worker ELK; it calls `failed` if the worker cannot load or crashes. */
export type ElkFactory = (failed: () => void) => ElkLike;

interface Job {
  graph: ElkNode;
  /** The ELK the job runs on now; results from any other one are ignored. */
  elk?: ElkLike;
  resolve(out: ElkNode): void;
  reject(e: Error): void;
}

let elkInstance: ElkLike | undefined;
let elkFactory: ElkFactory | undefined;
/** Layouts still running, so they can be stopped or moved to another ELK. */
const running = new Set<Job>();

/** Thrown by layoutDiagram when cancelLayouts() stopped it. */
export class LayoutCancelled extends Error {
  constructor() {
    super('Layout cancelled');
  }
}

async function inProcessElk(): Promise<ElkLike> {
  return new (await import('elkjs/lib/elk.bundled.js')).default();
}

function makeElk(factory: ElkFactory): ElkLike {
  const elk: ElkLike = factory(() => workerFailed(elk));
  return elk;
}

/** The worker could not load or crashed: run on the main thread from now on, and redo its layouts there. */
function workerFailed(elk: ElkLike): void {
  if (elkInstance !== elk) return;
  elk.terminateWorker?.();
  elkFactory = undefined;
  elkInstance = undefined;
  void getElk().then((fallback) => {
    for (const job of running) if (job.elk === elk) start(job, fallback);
  });
}

async function getElk(): Promise<ElkLike> {
  // The in-process ELK is loaded only when no other one was set (tests, no workers).
  return (elkInstance ??= await inProcessElk());
}

function start(job: Job, elk: ElkLike): void {
  job.elk = elk;
  elk.layout(job.graph).then(
    (out) => {
      if (job.elk !== elk || !running.delete(job)) return;
      job.resolve(out);
    },
    (e: unknown) => {
      if (job.elk !== elk || !running.delete(job)) return;
      job.reject(e instanceof Error ? e : new Error(String(e)));
    },
  );
}

/**
 * Use another ELK. The app passes a factory for an ELK that runs in a Web
 * Worker, so a long layout does not freeze the page and can be stopped. With
 * no factory the in-process ELK is used (tests do this).
 */
export function setElkFactory(factory: ElkFactory | undefined): void {
  elkInstance = factory ? makeElk(factory) : undefined;
  elkFactory = factory;
}

/**
 * Stop every running layout (they reject with LayoutCancelled). Only a worker
 * ELK can be stopped; with the in-process ELK this does nothing.
 */
export function cancelLayouts(): void {
  if (running.size === 0 || !elkFactory || !elkInstance?.terminateWorker) return;
  elkInstance.terminateWorker();
  elkInstance = makeElk(elkFactory);
  const jobs = [...running];
  running.clear();
  for (const job of jobs) job.reject(new LayoutCancelled());
}

export async function layoutDiagram(d: Diagram, measure: MeasureText = approxMeasure): Promise<LayoutResult> {
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

  const edgeOfElk = new Map<string, DEdge>();
  const edges: ElkExtendedEdge[] = d.edges.map((e, i) => ({
    id: `e${i}`,
    sources: [elkPort.get(e.source.port)!],
    targets: [elkPort.get(e.target.port)!],
    labels: e.label
      ? [
          {
            id: `e${i}.label`,
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

  const elk = await getElk();
  const out = await new Promise<ElkNode>((resolve, reject) => {
    const job: Job = { graph, resolve, reject };
    running.add(job);
    start(job, elk);
  });

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

  d.edges.forEach((e, i) => edgeOfElk.set(`e${i}`, e));
  const lEdges: LEdge[] = ((out.edges ?? []) as (ElkExtendedEdge & { junctionPoints?: Point[] })[]).map((e) => {
    const base = edgeOfElk.get(e.id)!;
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
  const elkResult: LayoutResult = { module: d.module, width: Math.max(out.width ?? 0, 48), height: Math.max(out.height ?? 0, 48), nodes, edges: lEdges };
  // ELK's coordinates are off the grid: put the symbols and wires on it (see grid-align).
  return alignToGrid(elkResult, GRID);
}
