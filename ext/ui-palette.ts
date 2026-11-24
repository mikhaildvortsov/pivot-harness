// Command palette (alt+k / /palette): one fuzzy list of panels, slash commands, skills and themes.
// enter runs an action, puts a command into the editor for you to finish, or switches the theme right away.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Panel, panelOptions, type Row } from "./lib/panel.ts";
import { REMOVED } from "./ui-legacy.ts";
import { KEYS, keyLabel } from "./lib/ui-kit.ts";

// Built-in commands that ui-legacy.ts redirects to the chats panel: kept in the slash menu (with a new description), left out of the palette, which has its own "Чаты" row.
const HIDDEN = new Set(["resume", "new", "name"]);
// My panel commands already have their own palette rows.
const OWN_PANELS = new Set(["sessions", "subagents", "checks", "palette"]);

type Item = { group: string; name: string; desc: string; run: (ctx: any, panel: Panel) => void };

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1") return;

	const open = async (ctx: any) => {
		if (ctx.mode !== "tui") return;
		const dispatch = (cmd: string) => (c: any, p: Panel) => {
			p.close();
			pi.sendUserMessage(cmd, { expandPromptTemplates: true });
		};
		const items: Item[] = [
			{ group: "панель", name: `Чаты (сессии)`, desc: keyLabel(KEYS.sessions[0]), run: dispatch("/sessions") },
			{ group: "панель", name: `Подагенты`, desc: keyLabel(KEYS.swarm[0]), run: dispatch("/subagents") },
			{ group: "панель", name: `Проверки`, desc: keyLabel(KEYS.checks[0]), run: dispatch("/checks") },
		];
		const seen = new Set<string>();
		for (const c of pi.getCommands()) {
			if (seen.has(c.name) || c.name.startsWith("ui-") || REMOVED.has(c.name) || HIDDEN.has(c.name) || OWN_PANELS.has(c.name)) continue;
			seen.add(c.name);
			const skill = c.source === "skill" || c.name.startsWith("skill:");
			items.push({
				group: skill ? "skill" : "команда",
				name: `/${c.name}`,
				desc: c.description ?? "",
				run: (cx, p) => {
					p.close();
					cx.ui.setEditorText(`/${c.name} `);
				},
			});
		}
		for (const t of ctx.ui.getAllThemes() as Array<{ name: string }>)
			items.push({ group: "тема", name: `Тема: ${t.name}`, desc: "", run: (cx) => void cx.ui.setTheme(t.name) });

		await ctx.ui.custom(
			(tui: any, theme: any, _kb: any, done: () => void) => {
				const rows = (): Row[] =>
					items.map((it) => ({
						key: it.group + it.name,
						label: `${it.name} ${it.desc} ${it.group}`,
						data: it,
						render: (w: number) =>
							theme.fg(it.group === "панель" ? "accent" : it.group === "тема" ? "mdLink" : it.group === "skill" ? "success" : "muted", it.group.padEnd(8)) +
							theme.fg("text", it.name) +
							(it.desc ? theme.fg("dim", "  " + it.desc.replace(/\s+/g, " ").slice(0, Math.max(10, w - 14 - it.name.length))) : ""),
					}));
				return new Panel(tui, theme, () => done(), {
					title: "Палитра команд",
					hint: "печатайте для поиска · enter выполнить · esc закрыть",
					filterable: true,
					rows,
					empty: "ничего не найдено",
					onSelect: (row, p) => {
						const it = row.data as Item;
						it.run(ctx, p);
						if (it.group === "тема") p.close();
					},
				});
			},
			panelOptions("center"),
		);
	};

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: current.triggerCharacters,
			shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
			applyCompletion: (...a) => current.applyCompletion(...a),
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const r = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				if (!r || !lines[cursorLine]?.trimStart().startsWith("/") || /\s/.test(lines[cursorLine]!.trimStart())) return r;
				const NOTE: Record<string, string> = { resume: "панель чатов", new: "новый чат (панель чатов)", name: "переименовать чат" };
				return {
					...r,
					items: r.items
						.filter((i) => {
							const n = i.value.replace(/^\//, "");
							return !n.startsWith("ui-") && !REMOVED.has(n);
						})
						.map((i) => {
							const n = i.value.replace(/^\//, "");
							return HIDDEN.has(n) ? { ...i, description: NOTE[n] } : i;
						}),
				};
			},
		}));
	});

	for (const key of KEYS.palette) pi.registerShortcut(key as never, { description: "Палитра команд", handler: open });
	pi.registerCommand("palette", { description: "Палитра команд: панели, команды, skills, темы", handler: async (_a, ctx) => open(ctx) });
}
