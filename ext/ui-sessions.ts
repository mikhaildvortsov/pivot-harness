// Sessions panel (IDE-style chat switcher): alt+s or /sessions opens a side panel with the project's chats.
// enter switches, ctrl+n starts a new chat, ctrl+r renames the current one, ctrl+a toggles "all projects". Cost is deliberately not shown.
import { type ExtensionAPI, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Panel, panelOptions, type Row } from "./lib/panel.ts";
import { focusTab, inGhostty, liveBeats, openNewTab, openTab, type Beat } from "./lib/tabs.ts";
import { fmtAge, KEYS, pulse, spinnerFrame } from "./lib/ui-kit.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1") return;

	// Commands run with a command-capable context, which the panel cannot hold: it dispatches these by name.
	pi.registerCommand("ui-switch", {
		description: "internal: switch to a session file (used by the sessions panel)",
		handler: async (args, ctx) => {
			const path = decodeURIComponent(args.trim());
			if (path) await ctx.switchSession(path);
		},
	});
	pi.registerCommand("ui-new", {
		description: "internal: start a new session (used by the sessions panel)",
		handler: async (_a, ctx) => {
			await ctx.newSession();
		},
	});

	const open = async (ctx: Parameters<Parameters<typeof pi.registerShortcut>[1]["handler"]>[0]) => {
		if (ctx.mode !== "tui") return;
		let all = false;
		let infos: SessionInfo[] = [];
		let loading = true;
		const load = async (tui?: { requestRender(): void }) => {
			loading = true;
			infos = (all ? await SessionManager.listAll() : await SessionManager.list(ctx.cwd)).sort((a, b) => b.modified.getTime() - a.modified.getTime());
			loading = false;
			tui?.requestRender();
		};
		const current = ctx.sessionManager.getSessionFile();
		// Chats open in other tabs (Ghostty tab mode): live status from their heartbeat files, refreshed about once a second.
		let beats: Beat[] = [];
		let beatsAt = 0;
		const tabOf = (path: string): Beat | undefined => {
			if (Date.now() - beatsAt > 1000) {
				beats = liveBeats(false);
				beatsAt = Date.now();
			}
			return beats.find((b) => b.session === path);
		};
		const switchHere = (s: SessionInfo, p: Panel) => {
			if (s.path === current) return p.close();
			if (!ctx.isIdle()) return ctx.ui.notify("Агент ещё работает: дождитесь конца задачи, потом переключайте чат.", "warning");
			p.close();
			pi.sendUserMessage(`/ui-switch ${encodeURIComponent(s.path)}`, { expandPromptTemplates: true });
		};
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				void load(tui);
				const rows = (): Row[] =>
					infos.map((s) => {
						const isCurrent = s.path === current;
						const title = s.name || s.firstMessage.replace(/\s+/g, " ").trim() || "(пустой чат)";
						return {
							key: s.path,
							label: `${s.name ?? ""} ${s.firstMessage} ${s.cwd}`,
							data: s,
							render: (_w: number, sel: boolean) => {
								const tab = isCurrent ? undefined : tabOf(s.path);
								const mark = isCurrent
									? ctx.isIdle() ? theme.fg("success", "●") : pulse(theme)
									: tab
										? tab.status === "working" ? theme.fg("accent", spinnerFrame()) : tab.status === "done" ? theme.fg("success", "✓") : tab.status === "error" ? theme.fg("error", "✗") : theme.fg("accent", "○")
										: theme.fg("borderMuted", "○");
								const proj = all ? theme.fg("mdLink", ` ${s.cwd.split("/").pop()}`) : "";
								const meta = ` · ${tab ? "вкладка" : fmtAge(s.modified)}${s.parentSessionPath ? " ⑂" : ""}`;
								const room = Math.max(8, _w - 3 - meta.length - (all ? (s.cwd.split("/").pop()?.length ?? 0) + 1 : 0));
								return `${mark} ${theme.fg(isCurrent || sel ? "text" : "muted", title.slice(0, room))}${proj}${theme.fg("dim", meta)}`;
							},
						};
					});
				return new Panel(tui, theme, () => done(), {
					title: all ? "Чаты · все проекты" : "Чаты",
					hint: inGhostty() ? "enter вкладка · tab здесь · ^N новый · ^R имя · ^A все" : "enter открыть · ^N новый · ^R имя · ^A все проекты",
					filterable: true,
					rows,
					empty: loading ? "загрузка…" : "Чатов пока нет",
					animated: () => loading || !ctx.isIdle(),
					onSelect: (row, p) => {
						const s = row.data as SessionInfo;
						if (s.path === current) return p.close();
						if (inGhostty()) {
							// Tab mode: jump to the tab that already has this chat, otherwise open it in a new tab.
							const tab = tabOf(s.path);
							p.close();
							if (tab && focusTab(tab.tty)) return;
							if (openTab(s.cwd || ctx.cwd, s.path)) return;
							ctx.ui.notify("Не удалось открыть вкладку Ghostty: переключаю чат здесь.", "warning");
						}
						switchHere(s, p);
					},
					onKey: (data, row, p) => {
						if (matchesKey(data, "tab") && row) {
							switchHere(row.data as SessionInfo, p); // open in this tab
							return true;
						}
						if (matchesKey(data, "ctrl+n")) {
							if (!ctx.isIdle()) return ctx.ui.notify("Агент ещё работает: дождитесь конца задачи.", "warning"), true;
							p.close();
							pi.sendUserMessage("/ui-new", { expandPromptTemplates: true });
							return true;
						}
						if (matchesKey(data, "ctrl+r")) {
							p.close();
							void ctx.ui.input("Название чата", ctx.sessionManager.getSessionName() ?? "").then((name) => name?.trim() && pi.setSessionName(name.trim()));
							return true;
						}
						if (matchesKey(data, "ctrl+a")) {
							all = !all;
							void load(tui);
							return true;
						}
						return false;
					},
				});
			},
			panelOptions("right", 40),
		);
	};

	const newTab = async (ctx: { mode: string; cwd: string; ui: { notify(m: string, t?: "info" | "warning" | "error"): void } }) => {
		if (ctx.mode !== "tui") return;
		if (!inGhostty() || !openNewTab(ctx.cwd)) ctx.ui.notify("Новая вкладка работает в Ghostty на macOS. Остальные терминалы: откройте вкладку вручную и запустите pivot.", "warning");
	};
	for (const key of KEYS.newtab) pi.registerShortcut(key as never, { description: "Новая вкладка с чатом", handler: newTab as never });
	pi.registerCommand("tab", { description: "Новая вкладка с чатом в этой папке", handler: async (_a, ctx) => newTab(ctx as never) });
	for (const key of KEYS.sessions) pi.registerShortcut(key as never, { description: "Панель чатов (сессий)", handler: open });
	pi.registerCommand("sessions", { description: "Панель чатов: переключение между сессиями", handler: async (_a, ctx) => open(ctx) });
}
