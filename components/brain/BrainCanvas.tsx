"use client";

import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { GRAPH_SOURCES, SOURCES, hexRgb, sourceDef } from "@/lib/jeff/sources";
import { linksFor } from "@/lib/jeff/retrieve";
import type { JeffDoc } from "@/lib/jeff/demo-data";

/**
 * Jeff's neural network: a decorative 3-D point mesh shaped like a brain,
 * with real records rendered as interactive nodes. Ported from the prototype.
 */

export interface BrainHandle {
  setZoom: (z: number) => void;
  getZoom: () => number;
  reset: () => void;
  pulse: () => void;
  resize: () => void;
}

interface Point {
  x: number;
  y: number;
  z: number;
  group: number;
  size: number;
  twinkle: number;
  inner?: boolean;
}

interface HitNode {
  x: number;
  y: number;
  id: string;
  title: string;
  source: string;
}

interface Props {
  docs: JeffDoc[];
  connected: string[];
  focus: string | null;
  motion: boolean;
  anchors: { id: string; x: number; y: number }[];
  active: boolean;
  onOpen: (id: string) => void;
  onZoom: (z: number) => void;
  onHover: (node: { title: string; x: number; y: number } | null) => void;
}

export const BrainCanvas = forwardRef<BrainHandle, Props>(function BrainCanvas(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const state = useRef({
    points: [] as Point[],
    edges: [] as [number, number][],
    zoom: 1,
    yaw: -0.16,
    pitch: 0.06,
    dragging: false,
    moved: 0,
    last: [0, 0] as [number, number],
    frame: 0,
    pulseAt: 0,
    hitNodes: [] as HitNode[],
    hover: null as string | null,
    drawn: 0,
    w: 0,
    h: 0,
    dpr: 1,
  });

  useImperativeHandle(ref, () => ({
    setZoom: (z) => {
      state.current.zoom = Math.min(1.7, Math.max(0.55, z));
      state.current.drawn = 0;
      propsRef.current.onZoom(state.current.zoom);
    },
    getZoom: () => state.current.zoom,
    reset: () => {
      state.current.yaw = -0.16;
      state.current.pitch = 0.06;
      state.current.zoom = 1;
      state.current.drawn = 0;
      propsRef.current.onZoom(1);
    },
    pulse: () => {
      state.current.pulseAt = performance.now();
      state.current.drawn = 0;
    },
    resize: () => resize(),
  }));

  function makeMesh() {
    const s = state.current;
    s.points = [];
    s.edges = [];
    const rows = 26;
    const cols = 46;
    let seed = 48;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const groups = GRAPH_SOURCES.length;
    for (let side = 0; side < 2; side++) {
      const start = s.points.length;
      for (let r = 0; r <= rows; r++) {
        const theta = (Math.PI * (r + 0.28)) / (rows + 0.56);
        for (let c = 0; c < cols; c++) {
          const phi = (2 * Math.PI * c) / cols;
          const st = Math.sin(theta);
          const ct = Math.cos(theta);
          const fold = 1 + 0.085 * Math.sin(phi * 8 + theta * 6) + 0.045 * Math.cos(theta * 14 - phi * 3);
          const taper = ct < -0.2 ? 1 + (ct + 0.2) * 0.26 : 1;
          let lobe = (0.43 + 0.72 * st * Math.cos(phi) * fold) * taper;
          if (lobe < 0.06) lobe = 0.055 + Math.abs(lobe) * 0.07;
          const x = (side ? 1 : -1) * lobe;
          const y = ct * 0.98 * fold;
          const z = st * Math.sin(phi) * 0.68 * fold;
          const group = (Math.floor((theta / Math.PI) * 3) + (side ? 2 : 0) + Math.floor((phi / (2 * Math.PI)) * 2)) % groups;
          s.points.push({ x, y, z, group, size: 0.65 + rand() * 0.7, twinkle: rand() * 6.3 });
          if (c > 0) s.edges.push([s.points.length - 1, s.points.length - 2]);
          if (r > 0) s.edges.push([s.points.length - 1, s.points.length - 1 - cols]);
          if (c === cols - 1) s.edges.push([s.points.length - 1, start + r * cols]);
        }
      }
    }
    for (let i = 0; i < 260; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand());
      const y = (rand() - 0.5) * 1.8;
      s.points.push({ x: Math.cos(a) * r * 0.64, y, z: Math.sin(a) * r * 0.54, group: i % groups, size: 0.45, twinkle: rand() * 6.3, inner: true });
    }
  }

  function resize() {
    const canvas = canvasRef.current;
    const s = state.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    s.w = rect.width;
    s.h = rect.height;
    if (!s.w || !s.h) return;
    s.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = s.w * s.dpr;
    canvas.height = s.h * s.dpr;
    canvas.getContext("2d")?.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    s.drawn = 0;
  }

  function project(p: Point, time: number) {
    const s = state.current;
    const yaw = s.yaw + (propsRef.current.motion && !s.dragging ? Math.sin(time * 0.00012) * 0.09 : 0);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(s.pitch);
    const sp = Math.sin(s.pitch);
    const x = p.x * cy + p.z * sy;
    const z = -p.x * sy + p.z * cy;
    const y = p.y * cp - z * sp;
    const zz = p.y * sp + z * cp;
    const scale = Math.min(s.w * 0.3, s.h * 0.405) * s.zoom;
    const perspective = 3.8 / (3.8 - zz);
    return { x: s.w * 0.5 + x * scale * perspective, y: s.h * 0.46 - y * scale * perspective, z: zz, scale: perspective };
  }

  function draw(time: number) {
    const canvas = canvasRef.current;
    const s = state.current;
    const c = canvas?.getContext("2d");
    if (!canvas || !c) return;
    const { docs, connected: ids, focus: focused, anchors } = propsRef.current;
    const w = s.w;
    const h = s.h;
    c.clearRect(0, 0, w, h);
    const colorRGB = GRAPH_SOURCES.map((p) => hexRgb(p.color));
    const pos = s.points.map((p) => project(p, time));
    c.save();
    c.lineWidth = 0.45;
    for (let gi = 0; gi < GRAPH_SOURCES.length; gi++) {
      const sid = GRAPH_SOURCES[gi]!.id;
      const active = ids.includes(sid);
      const dim = focused && focused !== sid;
      c.beginPath();
      for (const [i, j] of s.edges) {
        if (s.points[i]!.group !== gi) continue;
        if (pos[i]!.z < -0.4) continue;
        c.moveTo(pos[i]!.x, pos[i]!.y);
        c.lineTo(pos[j]!.x, pos[j]!.y);
      }
      // Inactive connections are neutral (#202026); active ones carry a restrained source tint.
      c.strokeStyle = active ? `rgba(${colorRGB[gi]},${dim ? 0.03 : 0.11})` : "rgba(32,32,38,0.9)";
      c.stroke();
    }
    for (let i = 0; i < s.points.length; i++) {
      const p = s.points[i]!;
      const pt = pos[i]!;
      const sid = GRAPH_SOURCES[p.group]!.id;
      const active = ids.includes(sid);
      const dim = focused && focused !== sid;
      const depth = (pt.z + 0.85) / 1.7;
      let alpha = (0.24 + depth * 0.69) * (p.inner ? 0.34 : 1) * (active ? 1 : 0.12) * (dim ? 0.19 : 1);
      if (propsRef.current.motion) alpha *= 0.91 + 0.09 * Math.sin(time * 0.001 + p.twinkle);
      // Inactive nodes are neutral (#45454D); active nodes use their source tint.
      c.fillStyle = active ? `rgba(${colorRGB[p.group]},${Math.max(0.02, Math.min(0.85, alpha))})` : `rgba(69,69,77,${Math.max(0.03, Math.min(0.45, alpha * 0.6))})`;
      c.beginPath();
      c.arc(pt.x, pt.y, p.size * (0.65 + depth * 0.5), 0, Math.PI * 2);
      c.fill();
    }
    s.hitNodes = [];
    docs.slice(0, 130).forEach((d, i) => {
      const gi = Math.max(0, SOURCES.findIndex((p) => p.id === d.source));
      let index = (i * 83 + 211 + gi * 91) % s.points.length;
      let tries = 0;
      while ((s.points[index]!.group !== gi % GRAPH_SOURCES.length || pos[index]!.z < -0.06) && tries++ < 200) index = (index + 13) % s.points.length;
      const p = pos[index]!;
      const dim = focused && focused !== d.source;
      const colour = sourceDef(d.source).color;
      c.globalAlpha = dim ? 0.12 : 1;
      c.shadowColor = colour;
      c.shadowBlur = 8;
      c.fillStyle = colour;
      c.beginPath();
      c.arc(p.x, p.y, s.hover === d.id ? 4 : 2.15, 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;
      c.globalAlpha = dim ? 0.08 : 0.25;
      c.beginPath();
      c.arc(p.x, p.y, 5, 0, Math.PI * 2);
      c.strokeStyle = colour;
      c.lineWidth = 0.55;
      c.stroke();
      s.hitNodes.push({ x: p.x, y: p.y, id: d.id, title: d.title, source: d.source });
      c.globalAlpha = 1;
    });
    for (const [a, b] of linksFor(docs).slice(0, 30)) {
      const pa = s.hitNodes.find((p) => p.id === a);
      const pb = s.hitNodes.find((p) => p.id === b);
      if (!pa || !pb) continue;
      c.strokeStyle = focused ? "rgba(77,163,255,0.14)" : "rgba(77,163,255,0.2)";
      c.lineWidth = 0.65;
      c.beginPath();
      c.moveTo(pa.x, pa.y);
      c.quadraticCurveTo(w * 0.5, h * 0.4, pb.x, pb.y);
      c.stroke();
    }
    for (const a of anchors) {
      const target = s.hitNodes.find((n) => n.source === a.id) ?? { x: w * 0.5, y: h * 0.48 };
      const x = a.x * w;
      const y = a.y * h;
      const dim = focused && focused !== a.id;
      const colour = sourceDef(a.id).color;
      c.strokeStyle = colour;
      c.globalAlpha = dim ? 0.04 : 0.24;
      c.lineWidth = 0.7;
      c.setLineDash([2, 4]);
      c.beginPath();
      c.moveTo(x, y);
      c.bezierCurveTo((x + target.x) / 2, y, (x + target.x) / 2, target.y, target.x, target.y);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = dim ? 0.08 : 0.75;
      const tt = propsRef.current.motion ? (time * 0.00013 + ids.indexOf(a.id) * 0.13) % 1 : 0.65;
      const mt = 1 - tt;
      const bx = mt * mt * mt * x + 3 * mt * mt * tt * ((x + target.x) / 2) + 3 * mt * tt * tt * ((x + target.x) / 2) + tt * tt * tt * target.x;
      const by = mt * mt * mt * y + 3 * mt * mt * tt * y + 3 * mt * tt * tt * target.y + tt * tt * tt * target.y;
      c.fillStyle = colour;
      c.shadowColor = colour;
      c.shadowBlur = 8;
      c.beginPath();
      c.arc(bx, by, 1.8, 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;
      c.globalAlpha = 1;
    }
    const elapsed = time - s.pulseAt;
    if (s.pulseAt && elapsed < 1800) {
      const p = elapsed / 1800;
      c.strokeStyle = `rgba(77,163,255,${(1 - p) * 0.3})`;
      c.lineWidth = 1;
      c.beginPath();
      c.ellipse(w / 2, h * 0.46, 40 + p * w * 0.45, 40 + p * h * 0.48, 0, 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  function nodeAt(e: { clientX: number; clientY: number }) {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const focus = propsRef.current.focus;
    return state.current.hitNodes
      .filter((n) => !focus || n.source === focus)
      .map((n) => ({ ...n, dist: Math.hypot(n.x - x, n.y - y) }))
      .sort((a, b) => a.dist - b.dist)
      .find((n) => n.dist < 12);
  }

  useEffect(() => {
    makeMesh();
    resize();
    const canvas = canvasRef.current!;
    const ro = new ResizeObserver(() => resize());
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    let raf = 0;
    const animate = (t: number) => {
      raf = requestAnimationFrame(animate);
      const s = state.current;
      if (document.hidden || !propsRef.current.active || !s.w) return;
      if (!propsRef.current.motion && s.drawn && t - s.pulseAt > 2000) return;
      if (propsRef.current.motion && t - s.frame < 32) return;
      s.frame = t;
      draw(t);
      s.drawn++;
    };
    raf = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw when data changes.
  useEffect(() => {
    state.current.drawn = 0;
  }, [props.docs, props.connected, props.focus, props.anchors, props.motion]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Interactive brain-shaped network. Use the source buttons to filter, the memory list to open documents, and the zoom controls to explore."
      onPointerDown={(e) => {
        const s = state.current;
        s.dragging = true;
        s.moved = 0;
        s.last = [e.clientX, e.clientY];
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const s = state.current;
        if (s.dragging) {
          const dx = e.clientX - s.last[0];
          const dy = e.clientY - s.last[1];
          s.yaw += dx * 0.007;
          s.pitch = Math.max(-0.55, Math.min(0.55, s.pitch + dy * 0.006));
          s.moved += Math.abs(dx) + Math.abs(dy);
          s.last = [e.clientX, e.clientY];
          s.drawn = 0;
        } else {
          const n = nodeAt(e);
          s.hover = n?.id ?? null;
          propsRef.current.onHover(n ? { title: n.title, x: n.x, y: n.y } : null);
          (e.target as HTMLCanvasElement).style.cursor = n ? "pointer" : "grab";
          s.drawn = 0;
        }
      }}
      onPointerUp={(e) => {
        const s = state.current;
        s.dragging = false;
        if (s.moved < 5) {
          const n = nodeAt(e);
          if (n) propsRef.current.onOpen(n.id);
        }
      }}
      onPointerCancel={() => (state.current.dragging = false)}
      onPointerLeave={() => {
        state.current.hover = null;
        propsRef.current.onHover(null);
      }}
      onWheel={(e) => {
        const s = state.current;
        s.zoom = Math.min(1.7, Math.max(0.55, s.zoom + (e.deltaY < 0 ? 0.08 : -0.08)));
        s.drawn = 0;
        propsRef.current.onZoom(s.zoom);
      }}
    />
  );
});
