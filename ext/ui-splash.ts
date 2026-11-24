// Splash screen: a large rotating ASCII π over the whole terminal while the chat is empty and the prompt is empty.
// Typing hides it; clearing the prompt (in a chat with no messages yet) brings it back. The agent starting hides it for good.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseKey } from "@earendil-works/pi-tui";
import { bootFrame, warmUp } from "./lib/boot.ts";
import { animate } from "./lib/ui-kit.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1" || process.env.PI_NO_SPLASH === "1" || process.env.PIVOT_NO_SPLASH === "1") return;
	setImmediate(warmUp); // build the 3D body once, before the first frame needs it
	// While the splash is (about to be) on screen, header and footer draw nothing, so nothing shows before the animation starts.
	const flag = ((globalThis as { __pivotSplash?: { visible: boolean } }).__pivotSplash ??= { visible: false });
	const interactive = process.stdout.isTTY && !process.argv.some((a) => a === "-p" || a === "--print" || a === "--mode");
	flag.visible = interactive;
	let epoch = 0;
	let introSeen = false; // the full intro plays once per process; later returns go straight to the idle loop

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.mode !== "tui" || ctx.sessionManager.getBranch().some((e) => e.type === "message")) {
			flag.visible = false;
			return;
		}
		const my = ++epoch;
		let used = false; // a command or prompt was sent in this chat: the animation never comes back
		let close: (() => void) | undefined;
		let stopMonitor: (() => void) | undefined;
		let shown = false;
		const fresh = () => !ctx.sessionManager.getBranch().some((e) => e.type === "message");
		const wanted = () => my === epoch && !used && fresh() && ctx.isIdle() && ctx.ui.getEditorText().length === 0;

		const show = () => {
			if (shown) return;
			shown = true;
			void ctx.ui
				.custom<void>(
					(tui, theme, _kb, done) => {
						close = () => done();
						// The full intro plays once per process; a later return starts already in the idle loop (offset fixed at creation).
						const offset = introSeen ? 4 : 0;
						introSeen = true;
						// The animation clock starts only once the event loop is calm: pi and the other extensions do a few hundred milliseconds of
						// synchronous startup work right now, and animating through it looks like stutter. Until then the first (still) frame is held.
						// After that the clock advances by the time between frames, capped, so a late hiccup slows the animation briefly
						// instead of freezing it and fast-forwarding to catch up.
						let clock = offset, last = 0, ready = offset > 0;
						const born = Date.now();
						let lastStall = born, prevTick = born;
						const monitor = setInterval(() => {
							const n = Date.now();
							if (n - prevTick > 45) lastStall = n;
							prevTick = n;
						}, 20);
						monitor.unref?.();
						stopMonitor = () => clearInterval(monitor);
						return {
							invalidate() {},
							render(width: number): string[] {
								animate(tui, true, 50);
								const rows = tui.terminal.rows;
								const now = Date.now();
								if (!ready && ((now - born > 700 && now - lastStall > 450) || now - born > 3000)) {
									ready = true;
									last = now;
								}
								if (ready && last) clock += Math.min(now - last, 60) / 1000;
								last = now;
								const t = clock;
								return bootFrame(theme, width, rows, t, "начните вводить команду или задачу");
							},
						};
					},
					{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", nonCapturing: true }, onHandle: (h) => h.unfocus({ target: null }) },
				)
				.finally(() => {
					stopMonitor?.();
					flag.visible = false;
					shown = false;
					close = undefined;
				});
		};
		const hide = () => close?.();
		const sync = () => {
			if (wanted()) show();
			else {
				flag.visible = false;
				hide();
			}
		};

		// After every key the editor text has changed: re-check on the next tick. Terminal replies, focus and mouse reports are not keys.
		const off = ctx.ui.onTerminalInput((data) => {
			if (data.startsWith("\x1b") && (parseKey(data) === undefined || /^\x1b\[(?:[IO]|<)/.test(data))) return undefined;
			if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				// Enter with text that leaves the editor empty means a command or prompt was submitted (not just an autocomplete pick).
				const before = ctx.ui.getEditorText();
				setTimeout(() => {
					if (before.trim() && ctx.ui.getEditorText() === "") used = true;
					sync();
				}, 0);
				return undefined;
			}
			setTimeout(sync, 0);
			return undefined;
		});
		const poll = setInterval(sync, 400);
		poll.unref?.();
		pi.on("agent_start", async () => hide());
		pi.on("agent_settled", async () => sync());
		pi.on("session_shutdown", async () => {
			epoch++;
			off();
			clearInterval(poll);
			hide();
		});
		sync();
	});
}
