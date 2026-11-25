// Splash screen: a large rotating ASCII π over the whole terminal. It shows once when a fresh chat opens and goes away for good at the
// first typed character or agent run (clearing the prompt does not bring it back). The /splash command shows it again on demand;
// any key hides it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseKey } from "@earendil-works/pi-tui";
import { bootFrame, warmUp } from "./lib/boot.ts";
import { animate } from "./lib/ui-kit.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1" || process.env.PI_NO_SPLASH === "1" || process.env.PIVOT_NO_SPLASH === "1") return;
	setImmediate(warmUp); // build the 3D body once, before the first frame needs it
	// While the splash is (about to be) on screen, header and footer draw nothing, so nothing shows before the animation starts.
	const flag = ((globalThis as { __pivotSplash?: { visible: boolean } }).__pivotSplash ??= { visible: false });
	// /fresh (fresh-chat.ts) opened this chat from the previous one: no splash between chats, so the screen is not held back or covered.
	const handover = globalThis as { __pivotFresh?: boolean };
	const fromFresh = handover.__pivotFresh === true;
	handover.__pivotFresh = false;
	const interactive = process.stdout.isTTY && !process.argv.some((a) => a === "-p" || a === "--print" || a === "--mode") && !fromFresh;
	flag.visible = interactive;
	// pi draws its own first frame (prompt box, path, token stats) a moment before this extension can put the splash over it, which shows
	// as a flash. Until the splash has produced its first frame, whole render updates (synchronized-output blocks) are held back and then
	// written together with it as one update. Everything else (terminal queries, OSC) passes straight through.
	let held: string[] | undefined;
	let heldTimer: ReturnType<typeof setTimeout> | undefined;
	let releaseHeld = () => {};
	if (interactive) {
		const rawWrite = process.stdout.write.bind(process.stdout) as (...a: unknown[]) => boolean;
		held = [];
		process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
			if (held && typeof chunk === "string" && chunk.includes("\x1b[?2026h")) {
				held.push(chunk);
				const cb = rest.find((a) => typeof a === "function") as (() => void) | undefined;
				if (cb) setImmediate(cb);
				return true;
			}
			return rawWrite(chunk, ...rest);
		}) as typeof process.stdout.write;
		releaseHeld = () => {
			if (!held) return;
			clearTimeout(heldTimer);
			process.stdout.write = rawWrite as typeof process.stdout.write;
			const all = held.join("").split("\x1b[?2026l\x1b[?2026h").join("");
			held = undefined;
			if (all) rawWrite(all);
		};
		heldTimer = setTimeout(releaseHeld, 1500); // failsafe: never keep the screen frozen
	}
	let epoch = 0;
	let showNow: (() => void) | undefined; // set by the live session; /splash calls it
	let introSeen = false; // the full intro plays once per process; later returns go straight to the idle loop

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.mode !== "tui") {
			flag.visible = false;
			releaseHeld();
			return;
		}
		const resumed = fromFresh || ctx.sessionManager.getBranch().some((e) => e.type === "message"); // a chat with history: no automatic splash, /splash still works
		if (resumed) {
			flag.visible = false;
			releaseHeld();
		}
		const my = ++epoch;
		let used = false; // a command or prompt was sent in this chat: the animation never comes back
		let close: (() => void) | undefined;
		let stopMonitor: (() => void) | undefined;
		let shown = false;
		let armed = !resumed; // the automatic first showing is still pending; typing or an agent run disarms it for good
		let manual = false; // shown by /splash: ignores chat history, any key hides it
		const fresh = () => !ctx.sessionManager.getBranch().some((e) => e.type === "message");
		// no isIdle() check: during startup the session may briefly report busy, and then the splash would be skipped (or shown late)
		const wanted = () => my === epoch && ctx.ui.getEditorText().length === 0 && (manual || (armed && !used && fresh()));

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
						let lastStall = born, prevTick = born, warm = 0;
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
								if (held) setTimeout(releaseHeld, 15); // the splash's own first frame is being written right after this call
								const rows = tui.terminal.rows;
								let now = Date.now();
								if (!ready) {
									// Holding the first frame while startup finishes. Meanwhile one intro frame per tick is rendered offscreen, covering every
									// stage (digits, π reveal and spin, wordmark), so the real animation hits warm code instead of pausing mid-intro.
									// The time spent on it is not counted as a stall of the rest of the startup.
									if (warm <= 12) {
										bootFrame(theme, width, rows, warm * 0.4, "");
										warm++;
										prevTick += Date.now() - now;
									}
									if (warm > 12 && ((now - born > 500 && now - lastStall > 350) || now - born > 3500)) {
										ready = true;
										now = last = prevTick = Date.now();
									}
								}
								if (ready && last) clock += Math.min(now - last, 60) / 1000;
								last = now;
								if (!ready) return Array<string>(rows).fill(" ".repeat(width)); // holding: blank cells hide the prompt underneath, only the terminal background shows
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
			if (ctx.ui.getEditorText().length > 0) armed = false;
			if (wanted()) show();
			else {
				flag.visible = false;
				releaseHeld();
				hide();
			}
		};

		// After every key the editor text has changed: re-check on the next tick. Terminal replies, focus and mouse reports are not keys.
		const off = ctx.ui.onTerminalInput((data) => {
			if (data.startsWith("\x1b") && (parseKey(data) === undefined || /^\x1b\[(?:[IO]|<)/.test(data))) return undefined;
			manual = false;
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
		showNow = () => {
			manual = true;
			setTimeout(sync, 60);
		};
		const poll = setInterval(sync, 400);
		poll.unref?.();
		pi.on("agent_start", async () => void ((armed = false), (manual = false), hide()));
		pi.on("agent_settled", async () => sync());
		pi.on("session_shutdown", async () => {
			epoch++;
			showNow = undefined;
			off();
			clearInterval(poll);
			hide();
		});
		sync();
	});
	pi.registerCommand("splash", { description: "Показать заставку (любая клавиша её скрывает)", handler: async () => showNow?.() });
}
