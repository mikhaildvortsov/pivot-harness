// Shared 3D ASCII π: glyph mask → rounded height field → z-buffered, light-shaded character grid, colored per brightness.
// Used by the splash screen (large) and the working indicator above the prompt (small).
import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, parseColor } from "@earendil-works/pi-tui";
import { currentGradient, GRADIENT_PERIOD, gradientColor, phase } from "./gradients.ts";

// π as a Times-style glyph (thin top bar with serifs, curved left leg with a swash foot, straight right leg with a foot serif),
// inflated into a rounded 3D body: a 2D mask → distance-to-edge → pillow height field, front and back faces with smooth normals.
type Vec = [number, number];
const quad = (p0: Vec, p1: Vec, p2: Vec, s: number): Vec => [(1 - s) * (1 - s) * p0[0] + 2 * s * (1 - s) * p1[0] + s * s * p2[0], (1 - s) * (1 - s) * p0[1] + 2 * s * (1 - s) * p1[1] + s * s * p2[1]];
// Left leg centre line with its half-width, sampled once.
const LEFT_LEG = Array.from({ length: 70 }, (_, i) => {
	const s = i / 69;
	const [x, y] = quad([-0.3, 0.66], [-0.38, -0.3], [-0.74, -0.88], s);
	return { x, y, r: 0.095 - 0.03 * s + 0.045 * Math.exp(-(((1 - s) * 9) ** 2)) };
});
const inTri = (x: number, y: number, a: Vec, b: Vec, c: Vec) => {
	const d = (p: Vec, q: Vec) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
	const d1 = d(a, b), d2 = d(b, c), d3 = d(c, a);
	return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
function inside(x: number, y: number): boolean {
	if (x >= -0.86 && x <= 0.96 && y >= 0.62 && y <= 0.8) return true; // top bar
	if (inTri(x, y, [-1.04, 0.5], [-0.78, 0.8], [-0.78, 0.6])) return true; // left serif hook
	if (x >= 0.86 && x <= 0.98 && y >= 0.5 && y <= 0.8) return true; // right serif
	for (const p of LEFT_LEG) if ((x - p.x) ** 2 + (y - p.y) ** 2 <= p.r * p.r) return true; // curved left leg
	if (x >= 0.35 && x <= 0.49 - 0.015 * (0.62 - y) && y >= -0.84 && y <= 0.64) return true; // right leg
	if (x >= 0.26 && x <= 0.62 && y >= -0.9 && y <= -0.8) return true; // right foot serif
	return false;
}

const GRID = 0.012, X0 = -1.12, Y0 = -1.0, NX = Math.ceil(2.2 / GRID), NY = Math.ceil(1.9 / GRID);
const DEPTH = 0.17, BEVEL = 0.12;
type Cloud = { n: number; x: Float32Array; y: Float32Array; z: Float32Array; nx: Float32Array; ny: Float32Array; nz: Float32Array };
let cloud: Cloud | undefined;
function buildCloud(): Cloud {
	const mask = new Uint8Array(NX * NY);
	for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) mask[j * NX + i] = inside(X0 + i * GRID, Y0 + j * GRID) ? 1 : 0;
	// distance to the nearest outside cell (two-pass chamfer, in cells)
	const dist = new Float32Array(NX * NY);
	for (let k = 0; k < dist.length; k++) dist[k] = mask[k] ? 1e6 : 0;
	const at = (i: number, j: number) => (i < 0 || j < 0 || i >= NX || j >= NY ? 0 : dist[j * NX + i]!);
	for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
		const k = j * NX + i;
		if (dist[k]) dist[k] = Math.min(dist[k]!, at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + 1.414, at(i + 1, j - 1) + 1.414);
	}
	for (let j = NY - 1; j >= 0; j--) for (let i = NX - 1; i >= 0; i--) {
		const k = j * NX + i;
		if (dist[k]) dist[k] = Math.min(dist[k]!, at(i + 1, j) + 1, at(i, j + 1) + 1, at(i + 1, j + 1) + 1.414, at(i - 1, j + 1) + 1.414);
	}
	const height = new Float32Array(NX * NY);
	for (let k = 0; k < height.length; k++) {
		if (!mask[k]) continue;
		const u = Math.min(1, (dist[k]! * GRID) / BEVEL);
		height[k] = DEPTH * Math.sqrt(1 - (1 - u) * (1 - u)); // quarter-circle profile: round edge, flat top
	}
	const h = (i: number, j: number) => (i < 0 || j < 0 || i >= NX || j >= NY ? 0 : height[j * NX + i]!);
	const cap = mask.reduce((n, v) => n + v, 0) * 2;
	const c: Cloud = { n: 0, x: new Float32Array(cap), y: new Float32Array(cap), z: new Float32Array(cap), nx: new Float32Array(cap), ny: new Float32Array(cap), nz: new Float32Array(cap) };
	const ox = -0.02, oy = -0.065; // centre the glyph
	for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
		const k = j * NX + i;
		if (!mask[k]) continue;
		const gx = (h(i + 1, j) - h(i - 1, j)) / (2 * GRID), gy = (h(i, j + 1) - h(i, j - 1)) / (2 * GRID);
		const len = Math.hypot(gx, gy, 1);
		for (const side of [1, -1]) {
			const q = c.n++;
			c.x[q] = X0 + i * GRID + ox;
			c.y[q] = Y0 + j * GRID + oy;
			c.z[q] = side * height[k]!;
			c.nx[q] = -gx / len;
			c.ny[q] = -gy / len;
			c.nz[q] = side / len;
		}
	}
	return c;
}

const LIGHT = (() => {
	const v = [-0.4, 0.55, 0.75];
	const n = Math.hypot(...v);
	return v.map((c) => c / n) as [number, number, number];
})();

export type FitOptions = { margin?: number; pad?: number };
export type Pixels = { w: number; h: number; cov: Uint8Array; lum: Float32Array };

/** Rasterize the spinning glyph into a w×h pixel buffer (square pixels): coverage + brightness. Fits any size. */
export function renderPixels(w: number, h: number, t: number, fit: FitOptions = {}): Pixels {
	const c = (cloud ??= buildCloud());
	const cov = new Uint8Array(w * h);
	const lum = new Float32Array(w * h);
	const depth = new Float32Array(w * h).fill(-1e9);
	const a = t * 0.9; // yaw
	const b = 0.22 * Math.sin(t * 0.55) - 0.08; // tilt
	const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
	// Glyph extent ≈ ±1.05 wide, ±0.95 tall; margin leaves room for perspective growth and tilt, so nothing is clipped.
	const margin = fit.margin ?? 1.18;
	const pad = fit.pad ?? 1;
	const scale = Math.max(1.5, Math.min((h / 2 - pad) / (0.95 * margin), (w / 2 - pad) / (1.05 * margin)));
	const cx = w / 2, cy = h / 2;
	for (let q = 0; q < c.n; q++) {
		const px = c.x[q]!, py = c.y[q]!, pz = c.z[q]!;
		const nxq = c.nx[q]!, nyq = c.ny[q]!, nzq = c.nz[q]!;
		const x1 = px * ca + pz * sa, z1 = -px * sa + pz * ca;
		const y2 = py * cb - z1 * sb, z2 = py * sb + z1 * cb;
		const nz1 = -nxq * sa + nzq * ca;
		const nz2 = nyq * sb + nz1 * cb;
		if (nz2 <= -0.12) continue; // facing away from the camera
		const f = 3.2 / (3.2 - z2);
		const sx = Math.floor(cx + x1 * scale * f);
		const sy = Math.floor(cy - y2 * scale * f);
		if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
		const k = sy * w + sx;
		if (z2 <= depth[k]!) continue;
		depth[k] = z2;
		const nx1 = nxq * ca + nzq * sa;
		const ny2 = nyq * cb - nz1 * sb;
		const diffuse = Math.max(0, nx1 * LIGHT[0] + ny2 * LIGHT[1] + nz2 * LIGHT[2]);
		const rim = Math.pow(1 - Math.max(0, nz2), 2) * 0.28; // soft rim light on the rounded edges gives depth
		cov[k] = 1;
		lum[k] = Math.min(1, 0.14 + diffuse * 0.74 + rim);
	}
	return { w, h, cov, lum };
}

// Brightness → color ramp (dark edge → gradient color → bright), 16 levels, for each of BINS positions along the active gradient.
// The picture is colored by position (left → right across the glyph shows the gradient the user picked) and the whole gradient
// slowly slides over it, GRADIENT_PERIOD seconds per pass.
type Rgb = ReturnType<typeof mixColors>;
const DARK = parseColor("#161b2e");
const WHITE = parseColor("#ffffff");
const BINS = 10;
const SHIFT_STEPS = 40;
const shiftStep = (t: number) => Math.floor(((t / GRADIENT_PERIOD) % 1) * SHIFT_STEPS);
let lutKey = "";
let lut: Rgb[][] = [];
function colors(_theme: Theme, t: number): Rgb[][] {
	const name = currentGradient();
	const step = shiftStep(t);
	const key = `${name}:${step}`;
	if (key === lutKey) return lut;
	lutKey = key;
	const slide = phase((step / SHIFT_STEPS) * GRADIENT_PERIOD) * 0.3; // how far the gradient has slid along the picture
	lut = Array.from({ length: BINS }, (_, b) => {
		const mid = gradientColor(Math.min(1, (b / (BINS - 1)) * 0.7 + slide), name);
		return Array.from({ length: 16 }, (_, i) => {
			const k = i / 15;
			return k < 0.6 ? mixColors(DARK, mid, k / 0.6) : mixColors(mid, WHITE, ((k - 0.6) / 0.4) * 0.7);
		});
	});
	return lut;
}
/** Which gradient bin a horizontal position (0..1) falls into. */
const binAt = (frac: number) => Math.min(BINS - 1, Math.max(0, Math.round(frac * (BINS - 1))));
const styleCache = new Map<string, readonly [string, string]>();
function ansi(theme: Theme, key: string, fg: Rgb | undefined, bg: Rgb | undefined): readonly [string, string] {
	let s = styleCache.get(key);
	if (!s) {
		if (styleCache.size > 4000) styleCache.clear();
		const marked = theme.style("\u0000", { fg, bg } as never);
		const at = marked.indexOf("\u0000");
		styleCache.set(key, (s = [marked.slice(0, at), marked.slice(at + 1)] as const));
	}
	return s;
}
const level = (l: number) => Math.min(15, Math.max(0, Math.round(l * 15)));

/**
 * Glow: uncovered pixels near bright ones get a dim halo (brightness falls off with distance), drawn in place.
 * `radius` in pixels, `strength` scales the halo relative to the source brightness.
 */
export function bloom(px: Pixels, radius: number, strength: number): void {
	const { w, h, cov, lum } = px;
	const add: Array<[number, number]> = [];
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		if (cov[y * w + x]) continue;
		let best = 0;
		for (let dy = -radius; dy <= radius; dy++) {
			const yy = y + dy;
			if (yy < 0 || yy >= h) continue;
			for (let dx = -radius; dx <= radius; dx++) {
				const xx = x + dx;
				if (xx < 0 || xx >= w || !cov[yy * w + xx]) continue;
				const d = Math.hypot(dx, dy);
				if (d > radius) continue;
				const v = lum[yy * w + xx]! * (1 - d / (radius + 0.5)) * strength;
				if (v > best) best = v;
			}
		}
		if (best > 0.05) add.push([y * w + x, best]);
	}
	for (const [k, v] of add) {
		cov[k] = 1;
		lum[k] = v;
	}
}

/** Color levels (16) for a brightness, drifting slowly with time. */
export function palette(theme: Theme, t: number): { pal: Rgb[][]; key: string } {
	return { pal: colors(theme, t), key: `${currentGradient()}${shiftStep(t)}` };
}

/**
 * Half-block pixel art in truecolor: 2 square pixels per character cell, 16 brightness levels.
 * `bgCell(x, y)` may supply an already styled string for cells without glyph pixels (rain, text).
 */
export function encodeHalf(theme: Theme, px: Pixels, t: number, bgCell?: (x: number, y: number) => string | undefined): string[] {
	const { pal, key: hueKey } = palette(theme, t);
	const cols = px.w, rows = px.h >> 1;
	const out: string[] = [];
	for (let y = 0; y < rows; y++) {
		// Style escapes are emitted only when the style changes along the line (about half the bytes of per-cell styling).
		let line = "";
		let curKey = "";
		let curSuf = "";
		for (let x = 0; x < cols; x++) {
			const kt = y * 2 * cols + x, kb = kt + cols;
			const top = px.cov[kt]!, bot = px.cov[kb]!;
			if (!top && !bot) {
				const extra = bgCell?.(x, y);
				if (curKey) {
					line += curSuf;
					curKey = "";
				}
				line += extra ?? " ";
				continue;
			}
			const lt = level(px.lum[kt]!), lb = level(px.lum[kb]!);
			const bin = binAt(x / Math.max(1, cols - 1)), P = pal[bin]!;
			let key: string, ch: string, fg: Rgb | undefined, bg: Rgb | undefined;
			if (top && bot) [key, ch, fg, bg] = [`${hueKey}:${bin}b${lt}:${lb}`, "▀", P[lt], P[lb]];
			else if (top) [key, ch, fg, bg] = [`${hueKey}:${bin}t${lt}`, "▀", P[lt], undefined];
			else [key, ch, fg, bg] = [`${hueKey}:${bin}u${lb}`, "▄", P[lb], undefined];
			if (key !== curKey) {
				const [pre, suf] = ansi(theme, key, fg, bg);
				if (curKey) line += curSuf;
				line += pre;
				curKey = key;
				curSuf = suf;
			}
			line += ch;
		}
		if (curKey) line += curSuf;
		out.push(line);
	}
	return out;
}

/** A single colored character (for rain / text cells) at a brightness 0..1. */
export function glyphCell(theme: Theme, t: number, ch: string, brightness: number, frac = 0.5): string {
	const { pal, key } = palette(theme, t);
	const lv = level(brightness);
	const bin = binAt(frac);
	const [pre, suf] = ansi(theme, `${key}:${bin}c${lv}`, pal[bin]![lv], undefined);
	return `${pre}${ch}${suf}`;
}

/** Large version for a plain static use: the spinning glyph as `rows` text rows. */
export function renderStyled(theme: Theme, cols: number, rows: number, t: number, fit: FitOptions = {}): string[] {
	return encodeHalf(theme, renderPixels(cols, rows * 2, t, fit), t);
}

// 2×4 ordered-dither thresholds: brightness decides which braille dots of a cell light up, so shading survives at tiny size.
const DITHER = [[0.06, 0.52], [0.77, 0.31], [0.44, 0.88], [0.69, 0.19]];
const BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

/** Small version: braille dots (2×4 sub-pixels per character), dithered by brightness, colored per cell. */
export function renderMini(theme: Theme, cols: number, rows: number, t: number): string[] {
	const px = renderPixels(cols * 2, rows * 4, t, { margin: 1.06, pad: 0.5 });
	const pal = colors(theme, t);
	const hueKey = `${currentGradient()}${shiftStep(t)}`;
	const out: string[] = [];
	for (let y = 0; y < rows; y++) {
		let line = "";
		for (let x = 0; x < cols; x++) {
			let bits = 0, sum = 0, n = 0;
			for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) {
				const k = (y * 4 + dy) * px.w + x * 2 + dx;
				if (!px.cov[k]) continue;
				const l = px.lum[k]!;
				sum += l;
				n++;
				if (l > DITHER[dy]![dx]! * 0.8 + 0.08) bits |= BITS[dy]![dx]!;
			}
			if (!bits) {
				line += " ";
				continue;
			}
			const lv = level(Math.min(1, sum / n + 0.15));
			const bin = binAt(x / Math.max(1, cols - 1));
			const [pre, suf] = ansi(theme, `${hueKey}:${bin}m${lv}`, pal[bin]![lv], undefined);
			line += `${pre}${String.fromCharCode(0x2800 + bits)}${suf}`;
		}
		out.push(line);
	}
	return out;
}
