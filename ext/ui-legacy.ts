// Old commands, new functionality: typing a built-in command keeps working but opens the harness replacement.
//   /resume → chats panel   /new → new chat   /name [text] → rename the chat
// pi's built-in command table is fixed, so the editor intercepts the submitted line instead of the command registry.
// Also: recalling a command from history (up arrow) puts the cursor at the end and opens its argument suggestions.
import { CustomEditor, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey } from "@earendil-works/pi-tui";
import { GRADIENT_PERIOD, gradientColor, phase } from "./lib/gradients.ts";
import { animate } from "./lib/ui-kit.ts";
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

const LEGACY = /^\/(resume|new|name)(?:\s+(.+))?$/;
// Built-in commands that Pivot does not use: removed from the menus and swallowed when typed.
export const REMOVED = new Set(["llama"]);
const REMOVED_RE = new RegExp(`^/(${[...REMOVED].join("|")})(?:\\s|$)`);

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1") return;

	// pi only has /quit; /exit does the same (in Ghostty the tab then drops to the shell).
	pi.registerCommand("exit", {
		description: "Выйти из pivot в терминал",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	pi.registerCommand("ui-rename", {
		description: "internal: rename the current chat",
		handler: async (_args, ctx) => {
			const name = await ctx.ui.input("Название чата", ctx.sessionManager.getSessionName() ?? "");
			if (name?.trim()) pi.setSessionName(name.trim());
		},
	});

	const run = (cmd: string, arg?: string) => {
		if (cmd === "resume") pi.sendUserMessage("/sessions", { expandPromptTemplates: true });
		else if (cmd === "new") pi.sendUserMessage("/ui-new", { expandPromptTemplates: true });
		else if (arg) pi.setSessionName(arg.trim());
		else pi.sendUserMessage("/ui-rename", { expandPromptTemplates: true });
	};

	let notify: ((m: string) => void) | undefined;
	let paint: { theme: Theme; busy: () => boolean } | undefined;
	let tuiRef: { requestRender(): void } | undefined;
	let lastTyped = 0;
	class LegacyEditor extends CustomEditor {
		/** Top and bottom borders get the active gradient: flowing while the agent works, a calm static wash otherwise. */
		render(width: number): string[] {
			const lines = [...super.render(width)];
			// The character typed a moment ago is drawn faint for ~45 ms and then at full strength: letters "arrive" instead of popping in.
			if (Date.now() - lastTyped < 45) {
				for (let i = 0; i < lines.length; i++) {
					const at = lines[i]!.indexOf(CURSOR_MARKER);
					if (at <= 0) continue;
					const before = lines[i]!.slice(0, at);
					const tail = /(?:\x1b\[[0-9;]*m)*$/.exec(before)?.[0] ?? "";
					const chars = [...before.slice(0, before.length - tail.length)];
					const last = chars.pop();
					if (last === undefined || last === " ") break;
					lines[i] = chars.join("") + "\x1b[2m" + last + "\x1b[22m" + tail + lines[i]!.slice(at);
					break;
				}
			}
			if (!paint) return lines;
			const busy = paint.busy();
			if (tuiRef) animate(tuiRef, true, 55); // the border always shimmers (faster while the agent works)
			const t = Date.now() / 1000;
			const flow = t * (busy ? 1.1 : 0.6);
			const recolor = (line: string) => {
				const plain = line.replace(ANSI, "");
				if (!/^[─ ]+$/.test(plain)) return line;
				const n = [...plain].length;
				return [...plain].map((ch, i) => (ch === " " ? ch : paint!.theme.style(ch === "─" ? "━" : ch, { fg: gradientColor(phase(flow + (i / n) * GRADIENT_PERIOD * 1.7)), bold: false }))).join("");
			};
			const first = lines.findIndex((x) => /^[─ ]+$/.test(x.replace(ANSI, "")));
			let last = -1;
			for (let i = lines.length - 1; i >= 0; i--) if (/^[─ ]+$/.test(lines[i]!.replace(ANSI, ""))) {
				last = i;
				break;
			}
			if (first >= 0) lines[first] = recolor(lines[first]!);
			if (last > first) lines[last] = recolor(lines[last]!);
			return lines;
		}

		handleInput(data: string): void {
			(globalThis as { __pivotActive?: number }).__pivotActive = Date.now(); // wakes the pet
			if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				const text = this.getText().trim();
				if (REMOVED_RE.test(text)) {
					this.setText("");
					notify?.(`${text.split(/\s/)[0]} отключена в Pivot`);
					return;
				}
				const m = LEGACY.exec(text);
				if (m) {
					this.setText("");
					run(m[1]!, m[2]);
					return;
				}
			}
			if ((matchesKey(data, "up") || matchesKey(data, "down")) && !this.isShowingAutocomplete()) {
				const before = this.getText();
				super.handleInput(data);
				const text = this.getText();
				// A history entry was just recalled: jump to its end; for a slash command add a space so its argument suggestions open
				// (up/down then move through the suggestions; Esc closes them and returns to plain history browsing).
				if ((this as unknown as { historyIndex: number }).historyIndex >= 0 && text !== before && text.trim() && !text.includes("\n")) {
					super.handleInput("\x05");
					if (text.startsWith("/") && !/\s/.test(text)) super.handleInput(" ");
				}
				return;
			}
			if (data.length > 0 && !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data)) {
				lastTyped = Date.now();
				setTimeout(() => tuiRef?.requestRender(), 50);
			}
			super.handleInput(data);
		}
	}

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		notify = (m) => ctx.ui.notify(m, "info");
		paint = { theme: ctx.ui.theme, busy: () => !ctx.isIdle() };
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			tuiRef = tui;
			return new LegacyEditor(tui, theme, keybindings);
		});
	});
}
