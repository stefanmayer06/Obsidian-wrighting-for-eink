import type { Pt, Rect } from "../geometry";

/**
 * A layered layout of a directed graph with nested clusters, for flowcharts
 * (Mermaid): nodes go into ranks along the flow (top to bottom, left to
 * right, …), the order inside each rank is chosen so that few edges cross,
 * and nodes are placed close to what they are connected to, long edges kept
 * straight. A cluster is laid out on its own first and is then one big node
 * of the level around it (like Mermaid does). Edges get their bends (one per
 * rank they pass) and the middle of every gap between ranks they cross, so
 * that they can be drawn with right angles; their labels get a place beside
 * them.
 */

export type FlowDirection = "TB" | "BT" | "LR" | "RL";

export interface Size {
  w: number;
  h: number;
}

export interface LayoutGraph {
  dir: FlowDirection;
  /** Sizes of the nodes as on the page (whatever the direction). */
  nodes: ReadonlyMap<string, Size>;
  clusters: ReadonlyMap<string, { children: readonly string[]; dir?: FlowDirection | null; title?: Size | null }>;
  /** Nodes and clusters in no cluster, in the order they were written. */
  root: readonly string[];
  edges: ReadonlyArray<{ id: string; from: string; to: string; minlen?: number; label?: Size | null }>;
}

export interface LayoutOptions {
  /** Between ranks. */
  rankSep: number;
  /** Between neighbours in a rank. */
  nodeSep: number;
  /** Between two edges passing a rank side by side. */
  edgeSep: number;
  /** Inside a cluster, around what it holds. */
  clusterPad: number;
  /** Above a cluster's title, and between it and what the cluster holds. */
  titleGap: number;
  /** Between an edge and its label. */
  labelGap: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { rankSep: 38, nodeSep: 30, edgeSep: 16, clusterPad: 14, titleGap: 6, labelGap: 6 };

export interface EdgeRoute {
  /** Flow of the level the edge was laid out in. */
  dir: FlowDirection;
  /** It goes against the flow (it closes a loop). */
  reversed: boolean;
  /** Its bends between its ends, one per rank it passes, from its source to its target. */
  points: Pt[];
  /**
   * The middle of every gap between ranks it crosses, from its source to its
   * target: a y for TB/BT, an x for LR/RL.
   */
  gaps: number[];
  /** Where its label goes. */
  label: Rect | null;
}

export interface ClusterBox extends Rect {
  /** Top left corner of the title. */
  title: Pt | null;
}

export interface LayoutResult {
  width: number;
  height: number;
  nodes: Map<string, Rect>;
  clusters: Map<string, ClusterBox>;
  /** Edges that could be laid out (not loops of a node to itself, not edges from a cluster to what it holds). */
  edges: Map<string, EdgeRoute>;
}

const ROOT = "\u0000root";

const isHorizontal = (d: FlowDirection) => d === "LR" || d === "RL";

// ------------------------------------------------------------------ one level

interface LevelItem extends Size {
  isolated: boolean;
}

interface LevelEdge {
  id: string;
  tail: number;
  head: number;
  minlen: number;
  label: Size | null;
  /** Where the edge really starts / ends, seen from the middle of the item (a node deep inside a cluster). */
  tailOff: Pt;
  headOff: Pt;
}

interface LevelRoute {
  reversed: boolean;
  points: Pt[];
  gaps: number[];
  label: Rect | null;
}

interface LevelResult extends Size {
  centers: Pt[];
  ranks: number[];
  maxRank: number;
  routes: Map<string, LevelRoute>;
}

interface LNode {
  /** Index of the item; -1 for the bend of a long edge. */
  item: number;
  rank: number;
  left: number;
  right: number;
  main: number;
}

interface Seg {
  other: number;
  w: number;
  /** Port offset (along the rank) at this node and at the other one. */
  off: number;
  otherOff: number;
}

/**
 * Positions along a rank: each node as close as it can be to its attractors
 * (positions with weights; the sum of weighted distances is made smallest, so
 * that edges come out straight rather than all a little bent), keeping the
 * order and the gaps `seps` – pool adjacent violators with weighted medians.
 * Where several positions are as good, a node stays nearest to `current`.
 */
export function placeInOrder(attractors: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, current: readonly number[], seps: readonly number[]): number[] {
  const n = attractors.length;
  const off = [0];
  for (let i = 1; i < n; i++) off.push(off[i - 1] + seps[i - 1]);
  interface Block {
    pts: Array<readonly [number, number]>;
    cur: number;
    n: number;
    value: number;
  }
  const median = (pts: Array<readonly [number, number]>, cur: number): number => {
    pts.sort((a, b) => a[0] - b[0]);
    const total = pts.reduce((s, p) => s + p[1], 0);
    let cum = 0;
    for (let i = 0; i < pts.length; i++) {
      cum += pts[i][1];
      if (cum > total / 2 + 1e-9) return pts[i][0];
      if (Math.abs(cum - total / 2) <= 1e-9) {
        const hi = pts[Math.min(i + 1, pts.length - 1)][0];
        return Math.max(pts[i][0], Math.min(hi, cur));
      }
    }
    return cur;
  };
  const blocks: Block[] = [];
  for (let i = 0; i < n; i++) {
    const cur = current[i] - off[i];
    const pts = attractors[i].length ? attractors[i].map(([t, w]) => [t - off[i], Math.max(1e-4, w)] as const) : [[cur, 1e-3] as const];
    blocks.push({ pts, cur, n: 1, value: median(pts, cur) });
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.value <= b.value) break;
      const pts2 = [...a.pts, ...b.pts];
      const cur2 = (a.cur * a.n + b.cur * b.n) / (a.n + b.n);
      blocks.splice(blocks.length - 2, 2, { pts: pts2, cur: cur2, n: a.n + b.n, value: median(pts2, cur2) });
    }
  }
  const out: number[] = [];
  let i = 0;
  for (const b of blocks) for (let k = 0; k < b.n; k++, i++) out.push(b.value + off[i]);
  return out;
}

function layoutLevel(items: LevelItem[], edgesIn: LevelEdge[], dir: FlowDirection, o: LayoutOptions): LevelResult {
  const horizontal = isHorizontal(dir);
  const n = items.length;
  const crossOf = (s: Size) => (horizontal ? s.h : s.w);
  const mainOf = (s: Size) => (horizontal ? s.w : s.h);
  const along = (p: Pt) => (horizontal ? p.y : p.x);
  const edges = edgesIn.filter((e) => e.tail !== e.head).map((e) => ({ ...e, minlen: Math.max(1, e.minlen, e.label ? 2 : 1) }));

  // 1. loops: reverse the edges that go back (depth first, from the nodes nothing points to)
  const outs: number[][] = items.map(() => []);
  const indeg = new Array<number>(n).fill(0);
  edges.forEach((e, k) => {
    outs[e.tail].push(k);
    indeg[e.head]++;
  });
  const reversed = new Set<number>();
  const state = new Array<number>(n).fill(0);
  const visit = (v: number) => {
    state[v] = 1;
    for (const k of outs[v]) {
      const w = edges[k].head;
      if (state[w] === 1) reversed.add(k);
      else if (state[w] === 0) visit(w);
    }
    state[v] = 2;
  };
  for (let v = 0; v < n; v++) if (state[v] === 0 && indeg[v] === 0) visit(v);
  for (let v = 0; v < n; v++) if (state[v] === 0) visit(v);
  const up = (k: number) => (reversed.has(k) ? edges[k].head : edges[k].tail);
  const down = (k: number) => (reversed.has(k) ? edges[k].tail : edges[k].head);

  // 2. ranks: longest path, then nodes nothing points to move down next to what they point to
  const preds: number[][] = items.map(() => []);
  const succs: number[][] = items.map(() => []);
  edges.forEach((_, k) => {
    preds[down(k)].push(k);
    succs[up(k)].push(k);
  });
  const topo: number[] = [];
  const left = preds.map((p) => p.length);
  const queue: number[] = [];
  for (let v = 0; v < n; v++) if (left[v] === 0) queue.push(v);
  while (queue.length) {
    const v = queue.shift() as number;
    topo.push(v);
    for (const k of succs[v]) if (--left[down(k)] === 0) queue.push(down(k));
  }
  const rank = new Array<number>(n).fill(0);
  for (const v of topo) for (const k of preds[v]) rank[v] = Math.max(rank[v], rank[up(k)] + edges[k].minlen);
  for (let i = topo.length - 1; i >= 0; i--) {
    const v = topo[i];
    if (preds[v].length === 0 && succs[v].length > 0) rank[v] = Math.min(...succs[v].map((k) => rank[down(k)] - edges[k].minlen));
  }
  const minRank = n ? Math.min(...rank) : 0;
  for (let v = 0; v < n; v++) rank[v] -= minRank;
  const maxRank = n ? Math.max(...rank) : 0;

  // 3. the bends of long edges, one per rank they pass; a label sits beside the middle one
  const nodes: LNode[] = items.map((it, i) => ({ item: i, rank: rank[i], left: crossOf(it) / 2, right: crossOf(it) / 2, main: mainOf(it) }));
  const chains: number[][] = [];
  const labelAt = new Map<number, number>();
  edges.forEach((e, k) => {
    const a = up(k);
    const b = down(k);
    const chain = [a];
    for (let r = rank[a] + 1; r < rank[b]; r++) {
      nodes.push({ item: -1, rank: r, left: 0, right: 0, main: 0 });
      chain.push(nodes.length - 1);
    }
    chain.push(b);
    if (e.label && chain.length > 2) {
      const d = chain[Math.floor(chain.length / 2)];
      nodes[d].right = o.labelGap + crossOf(e.label);
      nodes[d].main = mainOf(e.label);
      labelAt.set(k, d);
    }
    chains.push(chain);
  });
  const N = nodes.length;
  const downSegs: Seg[][] = nodes.map(() => []);
  const upSegs: Seg[][] = nodes.map(() => []);
  chains.forEach((chain, k) => {
    const e = edges[k];
    // the port offsets of the ends, in the order of the chain
    const offA = along(reversed.has(k) ? e.headOff : e.tailOff);
    const offB = along(reversed.has(k) ? e.tailOff : e.headOff);
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const dummies = (nodes[a].item < 0 ? 1 : 0) + (nodes[b].item < 0 ? 1 : 0);
      // long edges stay straight; an edge against the flow goes round the side and does not pull the nodes off their line
      const w = dummies === 2 ? 8 : reversed.has(k) ? 0.05 : dummies === 1 ? 2 : 1;
      const oa = i === 0 ? offA : 0;
      const ob = i + 1 === chain.length - 1 ? offB : 0;
      downSegs[a].push({ other: b, w, off: oa, otherOff: ob });
      upSegs[b].push({ other: a, w, off: ob, otherOff: oa });
    }
  });

  // 4. order inside the ranks: depth first to start, then barycentres, keeping the order with the fewest crossings
  let layers: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  const placed = new Array<boolean>(N).fill(false);
  const place = (v: number) => {
    if (placed[v]) return;
    placed[v] = true;
    layers[nodes[v].rank].push(v);
    for (const s of downSegs[v]) place(s.other);
  };
  for (let v = 0; v < n; v++) if (upSegs[v].length === 0) place(v);
  for (let v = 0; v < N; v++) place(v);
  const posIn = new Array<number>(N).fill(0);
  const index = (ls: number[][]) => {
    for (const l of ls) l.forEach((v, i) => (posIn[v] = i));
  };
  const crossings = (ls: number[][]): number => {
    index(ls);
    let c = 0;
    for (let r = 0; r + 1 < ls.length; r++) {
      const segs: Array<[number, number]> = [];
      for (const v of ls[r]) for (const s of downSegs[v]) segs.push([posIn[v], posIn[s.other]]);
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) c++;
    }
    return c;
  };
  let best = layers.map((l) => l.slice());
  let bestC = crossings(layers);
  for (let iter = 0; iter < 24 && bestC > 0; iter++) {
    const downward = iter % 2 === 0;
    index(layers);
    const rs = downward ? Array.from({ length: maxRank }, (_, i) => i + 1) : Array.from({ length: maxRank }, (_, i) => maxRank - 1 - i);
    for (const r of rs) {
      const bary = new Map<number, number>();
      for (const v of layers[r]) {
        const segs = downward ? upSegs[v] : downSegs[v];
        bary.set(v, segs.length ? segs.reduce((s, x) => s + posIn[x.other], 0) / segs.length : posIn[v]);
      }
      layers[r] = layers[r].slice().sort((a, b) => (bary.get(a) as number) - (bary.get(b) as number) || posIn[a] - posIn[b]);
      layers[r].forEach((v, i) => (posIn[v] = i));
    }
    const c = crossings(layers);
    if (c < bestC) {
      bestC = c;
      best = layers.map((l) => l.slice());
    }
  }
  layers = best;

  // 5. positions along the ranks: each node as close as it can be to what it is connected to
  const pos = new Array<number>(N).fill(0);
  const sep = (a: number, b: number) => nodes[a].right + nodes[b].left + (nodes[a].item < 0 && nodes[b].item < 0 ? o.edgeSep : o.nodeSep);
  for (const l of layers) {
    let u = 0;
    l.forEach((v, i) => {
      if (i > 0) u += sep(l[i - 1], v);
      pos[v] = u;
    });
  }
  const sweep = (r: number, which: "up" | "down" | "both") => {
    const l = layers[r];
    if (l.length === 0) return;
    const attractors = l.map((v) => {
      const segs = which === "up" ? upSegs[v] : which === "down" ? downSegs[v] : [...upSegs[v], ...downSegs[v]];
      return segs.map((s) => [pos[s.other] + s.otherOff - s.off, s.w] as const);
    });
    const seps = l.slice(1).map((v, i) => sep(l[i], v));
    const out = placeInOrder(
      attractors,
      l.map((v) => pos[v]),
      seps,
    );
    l.forEach((v, i) => (pos[v] = out[i]));
  };
  for (let iter = 0; iter < 8; iter++) {
    if (iter % 2 === 0) for (let r = 1; r <= maxRank; r++) sweep(r, "up");
    else for (let r = maxRank - 1; r >= 0; r--) sweep(r, "down");
  }
  for (let r = 0; r <= maxRank; r++) sweep(r, "both");
  let minU = Infinity;
  let maxU = -Infinity;
  for (let v = 0; v < N; v++) {
    minU = Math.min(minU, pos[v] - nodes[v].left);
    maxU = Math.max(maxU, pos[v] + nodes[v].right);
  }
  if (N === 0) minU = maxU = 0;
  for (let v = 0; v < N; v++) pos[v] -= minU;
  const U = maxU - minU;

  // 6. along the flow: ranks as bands, nodes in the middle of theirs (nodes on their own at its start)
  const band = new Array<number>(maxRank + 1).fill(0);
  for (const nd of nodes) band[nd.rank] = Math.max(band[nd.rank], nd.main);
  const top: number[] = [];
  let acc = 0;
  for (let r = 0; r <= maxRank; r++) {
    top.push(acc);
    acc += band[r] + (r < maxRank ? o.rankSep : 0);
  }
  const V = n ? acc : 0;
  const vc = nodes.map((nd) => (nd.item >= 0 && items[nd.item].isolated ? top[nd.rank] + nd.main / 2 : top[nd.rank] + band[nd.rank] / 2));
  const gapAfter = (r: number) => top[r] + band[r] + o.rankSep / 2;

  // 7. into the level's own frame
  const local = (u: number, v: number): Pt => {
    switch (dir) {
      case "BT":
        return { x: u, y: V - v };
      case "LR":
        return { x: v, y: u };
      case "RL":
        return { x: V - v, y: u };
      default:
        return { x: u, y: v };
    }
  };
  const localAxis = (v: number) => (dir === "BT" || dir === "RL" ? V - v : v);
  const routes = new Map<string, LevelRoute>();
  chains.forEach((chain, k) => {
    const e = edges[k];
    const path = reversed.has(k) ? chain.slice().reverse() : chain;
    const points = path.slice(1, -1).map((v) => local(pos[v], vc[v]));
    const gaps: number[] = [];
    for (let i = 0; i + 1 < path.length; i++) gaps.push(localAxis(gapAfter(Math.min(nodes[path[i]].rank, nodes[path[i + 1]].rank))));
    let label: Rect | null = null;
    const d = labelAt.get(k);
    if (d !== undefined && e.label) {
      const a = local(pos[d] + o.labelGap, vc[d] - mainOf(e.label) / 2);
      const b = local(pos[d] + o.labelGap + crossOf(e.label), vc[d] + mainOf(e.label) / 2);
      label = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    }
    routes.set(e.id, { reversed: reversed.has(k), points, gaps, label });
  });
  const size = horizontal ? { w: V, h: U } : { w: U, h: V };
  return { ...size, centers: items.map((_, i) => local(pos[i], vc[i])), ranks: rank, maxRank, routes };
}

// ------------------------------------------------------------------ clusters

interface Sub extends Size {
  rects: Map<string, Rect>;
  titles: Map<string, Pt | null>;
  routes: Map<string, EdgeRoute>;
}

function moveRoute(r: EdgeRoute, dx: number, dy: number): EdgeRoute {
  const da = isHorizontal(r.dir) ? dx : dy;
  return {
    ...r,
    points: r.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    gaps: r.gaps.map((g) => g + da),
    label: r.label ? { ...r.label, x: r.label.x + dx, y: r.label.y + dy } : null,
  };
}

const moveRect = (r: Rect, dx: number, dy: number): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });

/** Lay out a graph with nested clusters. */
export function layoutGraph(g: LayoutGraph, options: Partial<LayoutOptions> = {}): LayoutResult {
  const o: LayoutOptions = { ...DEFAULT_LAYOUT, ...options };
  const parent = new Map<string, string>();
  for (const id of g.root) parent.set(id, ROOT);
  for (const [cid, c] of g.clusters) for (const ch of c.children) parent.set(ch, cid);
  const chainOf = (id: string): string[] => {
    const out = [id];
    for (let p = parent.get(id); p !== undefined; p = p === ROOT ? undefined : parent.get(p)) out.push(p);
    if (out[out.length - 1] !== ROOT) out.push(ROOT);
    return out;
  };

  // the level each edge is laid out in: the innermost cluster holding both ends (each in another item of it)
  interface Placed {
    id: string;
    level: string;
    tailItem: string;
    headItem: string;
    from: string;
    to: string;
    minlen: number;
    label: Size | null;
  }
  const placedEdges: Placed[] = [];
  const external = new Set<string>();
  const crossing = new Map<string, Array<{ inner: string; incoming: boolean }>>();
  for (const e of g.edges) {
    if (e.from === e.to || !parent.has(e.from) || !parent.has(e.to)) continue;
    const ca = chainOf(e.from);
    const cb = chainOf(e.to);
    if (cb.includes(e.from) || ca.includes(e.to)) continue;
    let i = 1;
    while (i < ca.length && !cb.includes(ca[i])) i++;
    const level = ca[i];
    const j = cb.indexOf(level);
    placedEdges.push({ id: e.id, level, tailItem: ca[i - 1], headItem: cb[j - 1], from: e.from, to: e.to, minlen: e.minlen ?? 1, label: e.label ?? null });
    // the clusters the edge leaves or enters
    for (let k = 1; k < i; k++) {
      external.add(ca[k]);
      const list = crossing.get(ca[k]) ?? [];
      list.push({ inner: e.from, incoming: false });
      crossing.set(ca[k], list);
    }
    for (let k = 1; k < j; k++) {
      external.add(cb[k]);
      const list = crossing.get(cb[k]) ?? [];
      list.push({ inner: e.to, incoming: true });
      crossing.set(cb[k], list);
    }
  }

  // a cluster keeps its own direction only when no edge leaves it (as in Mermaid)
  const dirs = new Map<string, FlowDirection>([[ROOT, g.dir]]);
  const dirOf = (id: string): FlowDirection => {
    const known = dirs.get(id);
    if (known) return known;
    const c = g.clusters.get(id);
    const d = c?.dir && !external.has(id) ? c.dir : dirOf(parent.get(id) ?? ROOT);
    dirs.set(id, d);
    return d;
  };

  const layout = (cid: string): Sub => {
    const cluster = cid === ROOT ? null : g.clusters.get(cid);
    const children = (cid === ROOT ? g.root : (cluster?.children ?? [])).filter((ch) => g.nodes.has(ch) || g.clusters.has(ch));
    const dir = dirOf(cid);
    const subs = new Map<string, Sub>();
    for (const ch of children) if (g.clusters.has(ch)) subs.set(ch, layout(ch));
    const sizeOf = (ch: string): Size => subs.get(ch) ?? (g.nodes.get(ch) as Size);
    const idx = new Map(children.map((ch, i) => [ch, i] as const));
    // where a deep end sits, seen from the middle of the item holding it
    const offsetIn = (item: string, end: string): Pt => {
      const sub = subs.get(item);
      if (!sub || item === end) return { x: 0, y: 0 };
      const r = sub.rects.get(end);
      return r ? { x: r.x + r.w / 2 - sub.w / 2, y: r.y + r.h / 2 - sub.h / 2 } : { x: 0, y: 0 };
    };
    const mine = placedEdges.filter((e) => e.level === cid && idx.has(e.tailItem) && idx.has(e.headItem));
    const touched = new Set<number>();
    const levelEdges: LevelEdge[] = mine.map((e) => {
      const tail = idx.get(e.tailItem) as number;
      const head = idx.get(e.headItem) as number;
      touched.add(tail);
      touched.add(head);
      return { id: e.id, tail, head, minlen: e.minlen, label: e.label, tailOff: offsetIn(e.tailItem, e.from), headOff: offsetIn(e.headItem, e.to) };
    });
    const items: LevelItem[] = children.map((ch, i) => ({ ...sizeOf(ch), isolated: !touched.has(i) }));
    const lv = layoutLevel(items, levelEdges, dir, o);

    // the box: padding, the title above what the cluster holds
    let ox = 0;
    let oy = 0;
    let w = lv.w;
    let h = lv.h;
    let title: Pt | null = null;
    if (cluster) {
      const pad = o.clusterPad;
      const t = cluster.title && cluster.title.w > 0 ? cluster.title : null;
      oy = t ? o.titleGap + t.h + o.titleGap : pad;
      w = Math.max(lv.w + 2 * pad, t ? t.w + 2 * pad : 0, 2 * pad + 20);
      ox = (w - lv.w) / 2;
      h = oy + Math.max(lv.h, 10) + pad;
      if (t) {
        // keep the title off the edges coming in from above (or going out above, bottom to top)
        const entries: number[] = [];
        if (!isHorizontal(dir)) {
          const topRank = dir === "BT" ? lv.maxRank : 0;
          for (const c of crossing.get(cid) ?? []) {
            if (c.incoming !== (dir === "TB")) continue;
            const item = chainOf(c.inner).find((x) => parent.get(x) === cid);
            const i = item !== undefined ? idx.get(item) : undefined;
            if (i === undefined || lv.ranks[i] !== topRank) continue;
            entries.push(lv.centers[i].x + offsetIn(item as string, c.inner).x);
          }
        }
        const m = 10;
        const clear = (a: number, b: number) => entries.every((x) => x + ox < a - m || x + ox > b + m);
        if (clear(pad, pad + t.w)) title = { x: pad, y: o.titleGap };
        else if (clear(w - pad - t.w, w - pad)) title = { x: w - pad - t.w, y: o.titleGap };
        else {
          const lo = Math.min(...entries) + ox;
          const hi = Math.max(...entries) + ox;
          const growLeft = pad + t.w + m - lo;
          const growRight = hi + m + t.w + pad - w;
          if (growLeft <= growRight) {
            w += growLeft;
            ox += growLeft;
            title = { x: pad, y: o.titleGap };
          } else {
            w += growRight;
            title = { x: w - pad - t.w, y: o.titleGap };
          }
        }
      }
    }

    const rects = new Map<string, Rect>();
    const titles = new Map<string, Pt | null>();
    const routes = new Map<string, EdgeRoute>();
    if (cluster) titles.set(cid, title);
    children.forEach((ch, i) => {
      const s = sizeOf(ch);
      const c = lv.centers[i];
      const r = { x: ox + c.x - s.w / 2, y: oy + c.y - s.h / 2, w: s.w, h: s.h };
      rects.set(ch, r);
      const sub = subs.get(ch);
      if (!sub) return;
      for (const [id, rr] of sub.rects) rects.set(id, moveRect(rr, r.x, r.y));
      for (const [id, tt] of sub.titles) titles.set(id, tt);
      for (const [id, rt] of sub.routes) routes.set(id, moveRoute(rt, r.x, r.y));
    });
    for (const [id, rt] of lv.routes) routes.set(id, moveRoute({ ...rt, dir }, ox, oy));
    return { w, h, rects, titles, routes };
  };

  const top = layout(ROOT);
  const nodes = new Map<string, Rect>();
  const clusters = new Map<string, ClusterBox>();
  for (const [id, r] of top.rects) {
    if (g.clusters.has(id)) {
      const t = top.titles.get(id) ?? null;
      clusters.set(id, { ...r, title: t ? { x: r.x + t.x, y: r.y + t.y } : null });
    } else nodes.set(id, r);
  }
  return { width: top.w, height: top.h, nodes, clusters, edges: top.routes };
}
