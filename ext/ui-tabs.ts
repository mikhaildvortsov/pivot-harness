// Tab mode: the tab title shows the chat and its state (spinner while working, ✓ done, ✗ error, ○ idle), a bell marks a finished
// task in a background tab, and a heartbeat file lets the other tabs (sessions panel) see this chat's live status.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { removeBeat, type TabStatus, writeBeat } from "./lib/tabs.ts";
import { spinnerFrame } from "./lib/ui-kit.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1") return;
	let status: TabStatus = "idle";
	let since = Date.now();
	let ctxRef: { cwd: string; sessionManager: { getSessionName(): string | undefined; getSessionFile(): string | undefined; getBranch(): Array<{ type: string; message?: { role?: string; content?: unknown } }> }; ui: { setTitle(t: string): void }; mode: string } | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const name = () => {
		const c = ctxRef!;
		const named = c.sessionManager.getSessionName();
		if (named) return named;
		const first = c.sessionManager.getBranch().find((e) => e.type === "message" && e.message?.role === "user");
		const content = first?.message?.content;
		const text = typeof content === "string" ? content : Array.isArray(content) ? ((content.find((p: { type?: string }) => p?.type === "text") as { text?: string } | undefined)?.text ?? "") : "";
		return text.replace(/\s+/g, " ").trim().slice(0, 28) || c.cwd.split("/").pop() || "pivot";
	};
	const glyph = () => (status === "working" ? spinnerFrame() : status === "done" ? "✓" : status === "error" ? "✗" : "○");
	const refresh = () => {
		if (!ctxRef || ctxRef.mode !== "tui") return;
		ctxRef.ui.setTitle(`${glyph()} ${name()}`);
		writeBeat({ session: ctxRef.sessionManager.getSessionFile(), name: name(), cwd: ctxRef.cwd, status, since });
	};
	const setStatus = (s: TabStatus) => {
		status = s;
		since = Date.now();
		refresh();
	};

	pi.on("session_start", async (_e, ctx) => {
		ctxRef = ctx as never;
		setStatus("idle");
		clearInterval(timer);
		timer = setInterval(refresh, status === "working" ? 250 : 4000);
		timer.unref?.();
	});
	pi.on("agent_start", async () => {
		setStatus("working");
		clearInterval(timer);
		timer = setInterval(refresh, 250); // animate the spinner in the tab title
		timer.unref?.();
	});
	pi.on("agent_settled", async (e) => {
		const outcome = (e as unknown as { outcome?: string }).outcome;
		setStatus(outcome && outcome !== "completed" ? "error" : "done");
		clearInterval(timer);
		timer = setInterval(refresh, 4000);
		timer.unref?.();
		try {
			process.stdout.write("\x07"); // bell: Ghostty marks a background tab
		} catch {
			/* not a TTY */
		}
	});
	pi.on("input", async () => {
		if (status === "done" || status === "error") setStatus("idle");
	});
	pi.on("session_shutdown", async () => {
		clearInterval(timer);
		removeBeat();
	});
	process.on("exit", removeBeat);
}
