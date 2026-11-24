// Gradient presets tuned for dark terminals (hex, independent of the pi theme), the active choice, and animated sampling.
// The choice lives in state/ui-gradient.json ({"name": "aurora"}), written by /gradient, re-read at most twice a second.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { colorToRgb, mixColors, parseColor } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GRADIENTS: Record<string, { label: string; stops: string[]; bg: string; nebula: number; stars: number }> = {
	aurora: { label: "Аврора: бирюзовый → индиго → фуксия", stops: ["#5eead4", "#818cf8", "#e879f9"], bg: "#0e1621", nebula: 0.055, stars: 0.994 },
	ocean: { label: "Океан: циан → синий → фиолетовый", stops: ["#22d3ee", "#3b82f6", "#8b5cf6"], bg: "#0a1424", nebula: 0.06, stars: 0.995 },
	ember: { label: "Уголь: янтарь → коралл → сирень", stops: ["#fbbf24", "#fb7185", "#c084fc"], bg: "#1a1015", nebula: 0.05, stars: 0.996 },
	neon: { label: "Неон: лайм → циан → лаванда", stops: ["#a3e635", "#22d3ee", "#a78bfa"], bg: "#0b0f14", nebula: 0.04, stars: 0.992 },
	rainbow: { label: "Радуга: весь спектр красный → оранжевый → жёлтый → зелёный → голубой → синий → фиолетовый", stops: ["#ff5f5f", "#ffa24a", "#ffe55c", "#5fe08a", "#4cd9ff", "#5f8bff", "#c57bff"], bg: "#0b0f14", nebula: 0.045, stars: 0.993 },
	mauve: { label: "Мокко: роза → мальва → небо (в тон catppuccin)", stops: ["#f5c2e7", "#cba6f7", "#89b4fa"], bg: "#1e1e2e", nebula: 0.045, stars: 0.994 },
};
export const DEFAULT_GRADIENT = "aurora";
/** Seconds for one full pass through the gradient (there and back). */
export const GRADIENT_PERIOD = 1;

const FILE = join(homedir(), ".pi", "agent", "state", "ui-gradient.json");
let cached = { name: DEFAULT_GRADIENT, at: 0 };
export function currentGradient(): string {
	if (Date.now() - cached.at < 500) return cached.name;
	let name = DEFAULT_GRADIENT;
	try {
		if (existsSync(FILE)) {
			const n = JSON.parse(readFileSync(FILE, "utf8")).name;
			if (typeof n === "string" && GRADIENTS[n]) name = n;
		}
	} catch {
		/* keep default */
	}
	cached = { name, at: Date.now() };
	return name;
}

type Rgb = ReturnType<typeof mixColors>;
const parsed = new Map<string, Rgb[]>();
const stopsOf = (name: string): Rgb[] => {
	let s = parsed.get(name);
	if (!s) parsed.set(name, (s = GRADIENTS[name]!.stops.map((h) => parseColor(h))));
	return s;
};

/** Rainbow: a full turn of the hue wheel per half of the position range, so any window of the gradient (text, border, bar) shows the whole spectrum. */
const hueHex = (h: number) => {
	const a = 0.85 * Math.min(0.64, 1 - 0.64);
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		return Math.round(255 * (0.64 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
	};
	return "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("");
};

/** Color of the active gradient at position p in [0, 1]. */
export function gradientColor(p: number, name = currentGradient()): Rgb {
	if (name === "rainbow") return parseColor(hueHex((Math.min(1, Math.max(0, p)) * 720) % 360));
	const s = stopsOf(name);
	const x = Math.min(0.9999, Math.max(0, p)) * (s.length - 1);
	const i = Math.floor(x);
	return mixColors(s[i]!, s[i + 1]!, x - i);
}

/** Position that sweeps 0 → 1 → 0 once per GRADIENT_PERIOD seconds. */
export const phase = (t: number) => 0.5 - 0.5 * Math.cos((t / GRADIENT_PERIOD) * Math.PI * 2);

/** Text colored with the active gradient along its length, shifting with time. */
export function gradientText(theme: Theme, text: string, t: number, bold = true): string {
	const chars = [...text];
	const shift = phase(t) * 0.5;
	return chars.map((c, i) => (c === " " ? c : theme.style(c, { fg: gradientColor(shift + (chars.length < 2 ? 0 : i / (chars.length - 1)) * 0.5), bold }))).join("");
}

/**
 * Applies the chosen gradient to Ghostty: seven samples of the gradient and the backdrop parameters go into the shader (between the GRADIENT and
 * BACKDROP markers), and the matching background color into the Ghostty config (between the BACKGROUND markers), so every
 * gradient has its own backdrop. Returns true when a file changed (Ghostty then needs a config reload).
 */
export function syncShader(name = currentGradient()): boolean {
	const dir = join(homedir(), ".pi", "agent", "ghostty");
	const preset = GRADIENTS[name]!;
	// the shader always has 7 evenly spaced stops; 3-stop presets are resampled with the same interpolation the TUI uses
	const samples = Array.from({ length: 7 }, (_, i) => {
		const c = colorToRgb(gradientColor((i / 6) * (name === "rainbow" ? 0.5 : 1), name));
		return [c.r, c.g, c.b].map((v) => (v / 255).toFixed(3)).join(", ");
	});
	let changed = false;
	const rewrite = (file: string, begin: RegExp, end: string, body: string) => {
		try {
			if (!existsSync(file)) return;
			const src = readFileSync(file, "utf8");
			const next = src.replace(new RegExp(`(${begin.source}[^\\n]*\\n)[\\s\\S]*?(${end})`), `$1${body}\n$2`);
			if (next !== src) {
				writeFileSync(file, next);
				changed = true;
			}
		} catch {
			/* best effort */
		}
	};
	const shader = join(dir, "pivot-void.glsl");
	rewrite(shader, /\/\/ GRADIENT-BEGIN/, "// GRADIENT-END", samples.map((c, i) => `const vec3 G${i} = vec3(${c});`).join("\n"));
	rewrite(shader, /\/\/ BACKDROP-BEGIN/, "// BACKDROP-END", `const float NEB = ${preset.nebula.toFixed(3)};\nconst float STAR_T = ${preset.stars.toFixed(3)};`);
	rewrite(join(dir, "config"), /# BACKGROUND-BEGIN/, "# BACKGROUND-END", `background = ${preset.bg}`);
	return changed;
}
