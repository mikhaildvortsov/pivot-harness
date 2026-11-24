// Flat neon-tube drawing: strokes (polylines) are turned into a sparse distance field once per size; each frame only maps
// distance → brightness, with a "draw-on" progress along the path, a bright moving head, an ignition flicker and a slow pulse.
import type { Pixels } from "./pi-glyph.ts";

export type Polyline = ReadonlyArray<readonly [number, number]>;
/** A group of strokes placed on the canvas: centre (cx, cy) in pixels, height H in pixels, half stroke thickness in letter heights. */
export type Placement = { strokes: Polyline[]; cx: number; cy: number; H: number; half: number; group: number };

export type NeonField = {
	n: number;
	index: Uint32Array; // pixel index
	dist: Float32Array; // distance in letter heights
	s: Float32Array; // position along the group's path, 0..1
	group: Uint8Array;
	half: Float32Array; // half thickness of the stroke the pixel belongs to
	halo: number;
};

const HALO = 0.16; // glow reach in letter heights

export function buildField(w: number, h: number, placements: Placement[]): NeonField {
	const index: number[] = [], dist: number[] = [], sv: number[] = [], group: number[] = [], halfv: number[] = [];
	for (const pl of placements) {
		// flatten segments with cumulative path parameter
		const segs: Array<[number, number, number, number, number, number]> = []; // ax ay bx by s0 s1
		let total = 0;
		for (const line of pl.strokes) for (let i = 0; i + 1 < line.length; i++) total += Math.hypot(line[i + 1]![0] - line[i]![0], line[i + 1]![1] - line[i]![1]);
		let acc = 0;
		for (const line of pl.strokes) for (let i = 0; i + 1 < line.length; i++) {
			const [ax, ay] = line[i]!, [bx, by] = line[i + 1]!;
			const len = Math.hypot(bx - ax, by - ay);
			segs.push([ax, ay, bx, by, acc / total, (acc + len) / total]);
			acc += len;
		}
		const reach = pl.half + HALO;
		let minX = 9, maxX = -9, minY = 9, maxY = -9;
		for (const [ax, ay, bx, by] of segs) {
			minX = Math.min(minX, ax, bx); maxX = Math.max(maxX, ax, bx);
			minY = Math.min(minY, ay, by); maxY = Math.max(maxY, ay, by);
		}
		const x0 = Math.max(0, Math.floor(pl.cx + (minX - reach) * pl.H)), x1 = Math.min(w - 1, Math.ceil(pl.cx + (maxX + reach) * pl.H));
		const y0 = Math.max(0, Math.floor(pl.cy - (maxY + reach) * pl.H)), y1 = Math.min(h - 1, Math.ceil(pl.cy - (minY - reach) * pl.H));
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			const ux = (x + 0.5 - pl.cx) / pl.H, uy = (pl.cy - (y + 0.5)) / pl.H;
			let best = 9, bs = 0;
			for (const [ax, ay, bx, by, s0, s1] of segs) {
				const pax = ux - ax, pay = uy - ay, bax = bx - ax, bay = by - ay;
				const t = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay || 1)));
				const d = Math.hypot(pax - bax * t, pay - bay * t);
				if (d < best) {
					best = d;
					bs = s0 + (s1 - s0) * t;
				}
			}
			if (best > reach) continue;
			index.push(y * w + x);
			dist.push(best);
			sv.push(bs);
			group.push(pl.group);
			halfv.push(pl.half);
		}
	}
	return { n: index.length, index: Uint32Array.from(index), dist: Float32Array.from(dist), s: Float32Array.from(sv), group: Uint8Array.from(group), half: Float32Array.from(halfv), halo: HALO };
}

const hash = (n: number) => {
	const x = Math.sin(n * 12.9898) * 43758.5453;
	return x - Math.floor(x);
};

/**
 * Brightness for every field pixel at time t. `progress[g]` is how much of group g's path is drawn (0..1); a bright head runs
 * along the leading edge; just after a group completes it flickers like a neon tube igniting, then it breathes slowly.
 */
export function paint(px: Pixels, f: NeonField, progress: number[], doneAt: number[], t: number, glintX?: number) {
	for (let i = 0; i < f.n; i++) {
		const g = f.group[i]!, p = progress[g] ?? 0;
		if (p <= 0) continue;
		const s = f.s[i]!, d = f.dist[i]!, half = f.half[i]!;
		if (s > p) continue;
		let l = d <= half ? 0.7 + 0.25 * (1 - d / half) : 0.42 * (1 - (d - half) / f.halo) ** 2;
		const head = p < 1 ? Math.max(0, 1 - (p - s) / 0.06) : 0; // bright head at the leading edge while drawing
		l += head * 0.6;
		if (p >= 1) {
			const since = t - (doneAt[g] ?? 0);
			if (since < 0.5) l *= 0.55 + 0.45 * (hash(Math.floor(t * 30) + g * 7) > 0.35 ? 1 : 0.25); // ignition flicker
			else l *= 0.9 + 0.1 * Math.sin(t * 1.8 + g);
		}
		if (glintX !== undefined) l += 0.35 * Math.max(0, 1 - Math.abs((f.index[i]! % px.w) + Math.floor(f.index[i]! / px.w) * 0.6 - glintX) / 5);
		const k = f.index[i]!;
		px.cov[k] = 1;
		px.lum[k] = Math.min(1, l);
	}
}

// ---- glyph geometry (unit box: height 1, y up) ------------------------------------------------------------------------
export const PI_STROKES: Polyline[] = [
	[[-0.54, 0.27], [-0.5, 0.36], [0.5, 0.36], [0.5, 0.28]],                                           // bar with serifs
	[[-0.16, 0.36], [-0.2, 0.05], [-0.28, -0.22], [-0.38, -0.44], [-0.45, -0.5], [-0.52, -0.46], [-0.52, -0.4]], // curved left leg with a curl
	[[0.22, 0.36], [0.22, -0.46], [0.34, -0.46]],                                                       // right leg with a foot
];
const ellipse = (a: number, b: number, n: number): Array<[number, number]> => Array.from({ length: n + 1 }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * a, Math.sin((i / n) * Math.PI * 2) * b]);
export const LETTER_STROKES: Polyline[][] = [
	[[[-0.24, -0.5], [-0.24, 0.5], [0.08, 0.5], [0.26, 0.38], [0.26, 0.12], [0.08, 0.0], [-0.24, 0.0]]], // P
	[[[0, -0.5], [0, 0.5]]],                                                                              // I
	[[[-0.28, 0.5], [0, -0.5], [0.28, 0.5]]],                                                             // V
	[ellipse(0.27, 0.5, 20)],                                                                             // O
	[[[-0.28, 0.5], [0.28, 0.5]], [[0, 0.5], [0, -0.5]]],                                                 // T
];
export const ADVANCE = 0.82;
export const WORD_UNITS = LETTER_STROKES.length * ADVANCE - 0.2;
