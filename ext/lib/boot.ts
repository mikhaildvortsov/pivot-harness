// Pivot boot animation (pixel identity). Timeline in seconds, speed-adjusted by INTRO_SPEED:
//   0.0–2.6  numbers fall: big pixel digits (3×5 font ×2), small digits of π, twinkling stars, a shooting star now and then
//   0.9–2.0  out of the empty screen a pixel π materializes (a sweeping scan line reveals it) and starts spinning like a coin
//   2.0–3.2  the PIVOT wordmark in a block pixel font appears letter by letter (bottom-up wipe, flash, drop shadow)
//   3.0+     a glint runs across the wordmark; the π keeps spinning (idle loop)
// Everything is drawn as half-block truecolor pixels (see pi-glyph.ts), sized to the terminal on every frame.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { encodeHalf, glyphCell, type Pixels } from "./pi-glyph.ts";
import { PI_STROKES } from "./neon.ts";

const DIGITS = "31415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679";
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const easeOut = (p: number) => 1 - (1 - p) ** 3;
const rnd = (seed: number) => {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const DIGIT_FONT: string[][] = [
	["###", "#.#", "#.#", "#.#", "###"], [".#.", "##.", ".#.", ".#.", "###"], ["###", "..#", "###", "#..", "###"], ["###", "..#", "###", "..#", "###"],
	["#.#", "#.#", "###", "..#", "..#"], ["###", "#..", "###", "..#", "###"], ["###", "#..", "###", "#.#", "###"], ["###", "..#", "..#", ".#.", ".#."],
	["###", "#.#", "###", "#.#", "###"], ["###", "#.#", "###", "..#", "###"],
];
/** True when Ghostty draws the π with the pivot-void shader: the TUI then skips its own π and leaves the center empty. */
const SHADER_PI = false; // the shader no longer draws the π: the pixel π always comes from the TUI

/**
 * Backdrop drawn behind the π: big falling digits (3×5 pixel font, scaled ×2), twinkling stars and an occasional shooting star.
 * Only pixels not already covered by the π are touched. `fade` scales the digits; stars and shooting stars stay.
 */
function backdrop(px: Pixels, t: number, fade: number) {
	const { w, h, cov, lum } = px;
	const put = (x: number, y: number, l: number) => {
		if (x < 0 || x >= w || y < 0 || y >= h) return;
		const k = y * w + x;
		if (cov[k]) return;
		cov[k] = 1;
		lum[k] = l;
	};
	// stars: fixed positions, twinkling (with the Ghostty shader the shader draws finer ones)
	const stars = SHADER_PI ? 0 : Math.floor((w * h) / 380);
	for (let i = 0; i < stars; i++) {
		const sx = Math.floor(hash1(i * 3.1) * w), sy = Math.floor(hash1(i * 7.7 + 1) * h);
		put(sx, sy, 0.1 + 0.22 * (0.5 + 0.5 * Math.sin(t * (1.5 + hash1(i) * 2.5) + i)));
	}
	// shooting star: crosses the upper area every ~3.5 s
	const cycle = 3.5, ph = (t % cycle) / cycle;
	if (ph < 0.22 && !SHADER_PI) {
		const k = ph / 0.22, id = Math.floor(t / cycle);
		const x0 = hash1(id * 5.3) * w * 0.7, y0 = hash1(id * 2.9 + 4) * h * 0.4;
		for (let tail = 0; tail < 9; tail++) {
			const kk = k - tail * 0.018;
			if (kk < 0) continue;
			put(Math.round(x0 + kk * w * 0.35), Math.round(y0 + kk * h * 0.3), 0.85 * (1 - tail / 9));
		}
	}
	if (fade <= 0) return;
	// big digits: columns of 6×10 px glyphs falling at different speeds
	const gw = 8, gh = 12;
	const colsN = Math.floor(w / gw);
	for (let c = 0; c < colsN; c++) {
		const seed = hash1(c * 12.9 + 3);
		if (seed > 0.3) continue; // sparse: about a third of the columns
		const speed = 10 + hash1(c * 4.1) * 22;
		const headY = ((t * speed + hash1(c * 9.7) * (h + 70)) % (h + 70)) - 20;
		for (let n = 0; n < 6; n++) {
			const gy = Math.round(headY - n * gh);
			const l = (n === 0 ? 0.62 : 0.5 * (1 - n / 6) ** 1.5) * fade;
			if (l < 0.04) continue;
			const d = Math.floor(hash1(c * 31 + n * 17 + Math.floor(t * 2.5 + c)) * 10);
			const rows = DIGIT_FONT[d]!;
			for (let fy = 0; fy < 5; fy++) for (let fx = 0; fx < 3; fx++) {
				if (rows[fy]![fx] !== "#") continue;
				for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) put(c * gw + 1 + fx * 2 + dx, gy + fy * 2 + dy, l);
			}
		}
	}
}
function hash1(n: number) {
	const x = Math.sin(n * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}

function digitRain(theme: Theme, t: number, totalRows: number, cols: number) {
	const fade = clamp(t / 0.4) * clamp(1 - (t - 1.8) / 0.8);
	if (fade <= 0) return undefined;
	return (x: number, y: number): string | undefined => {
		const seed = (Math.imul(x + 1, 2654435761) >>> 0) % 997;
		if (seed % 3 !== 0) return undefined; // a third of the columns: fewer cells to send each frame
		const speed = 7 + (seed % 7);
		const head = ((t * speed + seed * 0.37) % (totalRows + 16)) - 8;
		const dist = head - y;
		if (dist < 0 || dist > 7) return undefined;
		const ch = DIGITS[(x * 3 + y + Math.floor(t * 5 + seed)) % DIGITS.length]!;
		const b = (dist < 1 ? 0.95 : (1 - dist / 7) ** 2 * 0.6) * fade;
		return glyphCell(theme, t, ch, b, x / Math.max(1, cols - 1));
	};
}


// ---- pixel π sprite: a small mask rasterized from the glyph strokes, drawn with big square pixels and spun like a coin ----------
const SPRITE_H = 20;
let sprite: { w: number; h: number; m: Uint8Array } | undefined;
function buildSprite() {
	const h = SPRITE_H, w = Math.round(h * 1.12);
	const m = new Uint8Array(w * h);
	const half = 0.075; // fraction of the height
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const ux = (x + 0.5 - w / 2) / h, uy = (h / 2 - (y + 0.5)) / h;
		let d = 9;
		for (const line of PI_STROKES) for (let i = 0; i + 1 < line.length; i++) {
			const [ax, ay] = line[i]!, [bx, by] = line[i + 1]!;
			const pax = ux - ax, pay = uy - ay, bax = bx - ax, bay = by - ay;
			const t = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay || 1));
			d = Math.min(d, Math.hypot(pax - bax * t, pay - bay * t));
		}
		// the bar is a little thicker than the legs, like a printed π
		const thick = uy > 0.27 ? half * 1.25 : half;
		m[y * w + x] = d <= thick ? 1 : 0;
	}
	return (sprite = { w, h, m });
}

/** Draws the π into `px` (square pixels). `angle` is the spin; k = integer pixel size of one sprite pixel. */
function drawPi(px: Pixels, cx: number, cy: number, k: number, angle: number, reveal: number) {
	const s = sprite ?? buildSprite();
	const c = Math.cos(angle), sn = Math.sin(angle);
	const back = c < 0;
	const wScale = Math.max(Math.abs(c), 0.06);
	const depth = Math.round(Math.abs(sn) * 6 * k); // visible thickness of the side while turned
	const W = s.w * k, H = s.h * k;
	const sweep = reveal * (H + 10) - 5;
	const put = (x: number, y: number, l: number) => {
		if (x < 0 || x >= px.w || y < 0 || y >= px.h) return;
		const i = y * px.w + x;
		px.cov[i] = 1;
		px.lum[i] = l;
	};
	const Wf = Math.max(1, Math.round(W * wScale));
	const dir = sn * c >= 0 ? -1 : 1; // the side lies towards the hidden face: it swaps sides each time the coin passes edge-on
	const xl = Math.round(cx - (Wf + depth) / 2); // face + extruded side are centred together
	const faceX = dir > 0 ? xl : xl + depth;
	const edgeOn = wScale < 0.24; // nearly edge-on: the whole slab is solid, not only the columns the face happens to sample
	for (let oy = 0; oy < H; oy++) {
		if (oy > sweep) continue;
		const sy = Math.floor(oy / k);
		const y = Math.round(cy - H / 2 + oy);
		let inkRow = false;
		for (let sx = 0; sx < s.w; sx++) if (s.m[sy * s.w + sx]) { inkRow = true; break; }
		if (!inkRow) continue;
		const srcX = (ox: number) => Math.min(s.w - 1, Math.floor((back ? 1 - (ox + 0.5) / Wf : (ox + 0.5) / Wf) * s.w));
		// extruded side: copies of the face shape, so it follows the π outline (a solid slab only when nearly edge-on)
		const sideL = (d: number) => 0.3 + 0.16 * (dir > 0 ? d : depth - d) / Math.max(1, depth);
		if (edgeOn) {
			for (let d = dir > 0 ? 0 : -depth; d < (dir > 0 ? Wf + depth : Wf); d++) put(faceX + d, y, 0.3 + 0.1 * Math.abs(d) / Math.max(1, Wf + depth));
		} else {
			for (let ox = 0; ox < Wf; ox++) if (s.m[sy * s.w + srcX(ox)]) for (let d = 1; d <= depth; d++) put(faceX + ox + dir * d, y, sideL(d));
		}
		for (let ox = 0; ox < Wf; ox++) {
			// source column for this output column (nearest neighbour), mirrored when the back is showing
			const frac = (ox + 0.5) / Wf;
			const sx = Math.min(s.w - 1, Math.floor((back ? 1 - frac : frac) * s.w));
			const ink = s.m[sy * s.w + sx];
			if (!ink && !edgeOn) continue;
			const up = sy === 0 || !s.m[(sy - 1) * s.w + sx], down = sy === s.h - 1 || !s.m[(sy + 1) * s.w + sx];
			let l = back ? 0.5 : 0.72;
			if (ink && up) l += 0.22;
			if (ink && down) l -= 0.2;
			if (!ink) l = 0.5;
			if (sweep - oy < 4) l = 0.98; // bright scan line while it is being revealed
			put(faceX + ox, y, Math.min(1, l));
		}
	}
}

// ---- pixel wordmark: 5×7 block font, scaled, with a drop shadow, wipe-in, flash and glint -----------------------------------
const FONT: Record<string, string[]> = {
	P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
	I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
	V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
	O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
	T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
};
const WORD = "PIVOT";
const WORD_W = WORD.length * 5 + (WORD.length - 1);

function wordmark(w: number, rowsTxt: number, s: number, t: number): Pixels {
	const h = rowsTxt * 2;
	const px: Pixels = { w, h, cov: new Uint8Array(w * h), lum: new Float32Array(w * h) };
	const x0 = Math.floor((w - WORD_W * s) / 2), y0 = Math.floor((h - 7 * s) / 2);
	const put = (x: number, y: number, l: number, shadow = false) => {
		if (x < 0 || x >= w || y < 0 || y >= h) return;
		const k = y * w + x;
		if (shadow && px.cov[k]) return;
		px.cov[k] = 1;
		px.lum[k] = shadow ? Math.max(px.lum[k]!, l) : l;
	};
	const glintAt = ((t - 3.2) * 34) % (w + 90) - 30;
	for (const pass of [0, 1]) {
		for (let li = 0; li < WORD.length; li++) {
			const rows = FONT[WORD[li]!]!;
			const r = clamp((t - (2.0 + li * 0.16)) / 0.45);
			if (r <= 0) continue;
			for (let fy = 0; fy < 7; fy++) for (let fx = 0; fx < 5; fx++) {
				if (rows[fy]![fx] !== "#") continue;
				for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
					const x = x0 + (li * 6 + fx) * s + dx, y = y0 + fy * s + dy;
					const fromBottom = 1 - (fy * s + dy) / (7 * s);
					if (fromBottom > r * 1.15) continue;
					if (pass === 0) put(x + Math.max(1, s >> 1), y + Math.max(1, s >> 1), 0.14, true);
					else {
						let l = 0.5 + 0.38 * (1 - (fy * s + dy) / (7 * s)) + 0.45 * (1 - r) * (1 - r);
						if (t > 3.2) l += 0.4 * clamp(1 - Math.abs(x + y * 0.8 - glintAt) / 5);
						put(x, y, Math.min(1, l));
					}
				}
			}
		}
	}
	return px;
}

/** Intro runs this many times faster than its nominal timeline (nominal times in the header comment). */
const INTRO_SPEED = 1.25;

export function bootFrame(theme: Theme, cols: number, rows: number, tReal: number, hint: string): string[] {
	const t = tReal * INTRO_SPEED; // intro clock; the spin below uses real time so it stays calm
	const small = rows < 20 || cols < 40;
	let s = 0; // wordmark pixel size
	if (!small) for (const cand of [4, 3, 2, 1]) if (WORD_W * cand <= cols - 6 && Math.ceil((7 * cand) / 2) <= Math.max(4, Math.floor(rows * 0.3))) { s = cand; break; }
	const wmRows = s ? Math.ceil((7 * s) / 2) + 1 : 0;
	const textRows = small ? 0 : 3;
	const gap = s ? 1 : 0;
	const G = Math.max(4, rows - wmRows - gap - textRows - 1);
	const w = cols, h = G * 2;

	const rain = digitRain(theme, t, rows, cols);
	const bgGlyph = rain ? (x: number, y: number) => rain(x, y) : undefined;
	const px: Pixels = { w, h, cov: new Uint8Array(w * h), lum: new Float32Array(w * h) };
	// π: integer pixel size so it stays crisp; spins like a coin once revealed
	const k = Math.max(1, Math.min(Math.floor((h * 0.92) / SPRITE_H), Math.floor((w * 0.4) / (SPRITE_H * 1.12))));
	const reveal = clamp((t - 0.9) / 1.1);
	if (reveal > 0) {
		const tr = Math.max(0, tReal - 2.0 / INTRO_SPEED);
		const spin = tr < 1.0 ? (tr * tr) / 2 : tr - 0.5; // eases from rest to a steady turn
		drawPi(px, w / 2, h / 2, k, spin * 1.9, reveal);
	}
	backdrop(px, tReal, clamp(t / 0.5) * clamp(1 - (t - 2.4) / 1.0));
	const out = encodeHalf(theme, px, tReal, bgGlyph);
	if (small) return out.slice(0, rows);

	if (s) {
		out.push("");
		const wm = wordmark(w, wmRows - 1, s, t);
		const bgWm = rain ? (x: number, y: number) => rain(x, y + G + 1) : undefined;
		out.push(...encodeHalf(theme, wm, tReal, bgWm), "");
	}
	const center = (plain: string, styled: string) => " ".repeat(Math.max(0, Math.floor((cols - [...plain].length) / 2))) + styled;
	const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
	out.push(center(hint, t > 3.4 ? theme.style(hint, { fg: theme.colors.dim, bold: pulse > 0.5 }) : ""));
	while (out.length < rows) out.push("");
	return out.slice(0, rows);
}

/** Pre-builds the π sprite so the first animation frame does not stall on it. */
export const warmUp = () => void buildSprite();
