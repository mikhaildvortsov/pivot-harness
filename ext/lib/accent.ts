// One accent color (Catppuccin blue) for everything that used to be a gradient: pulses, the comet on the prompt border, the splash glyph.
// Motion comes from brightness and position, not from hue.
import { mixColors, parseColor } from "@earendil-works/pi-tui";

type Rgb = ReturnType<typeof mixColors>;
export const ACCENT: Rgb = parseColor("#89b4fa");
const WHITE = parseColor("#ffffff");
const DARK = parseColor("#161b2e");

/** The accent lightened toward white by k in [0, 1]. */
export const tint = (k: number): Rgb => mixColors(ACCENT, WHITE, Math.min(1, Math.max(0, k)));
/** The accent dimmed toward the background by k in [0, 1]. */
export const dim = (k: number): Rgb => mixColors(ACCENT, DARK, Math.min(1, Math.max(0, k)));
/** Slow breathing 0 → 1 → 0 with the given period in seconds. */
export const breathe = (t: number, period = 2.4) => 0.5 - 0.5 * Math.cos((t / period) * Math.PI * 2);
