// On-demand skill routing over the aas + ecc libraries (newest Claude plugin versions, ~2600 skills, not in the prompt).
// Used when the model declares use_skills in classify_task (task-classifier.ts) and by subagents (subagent-skills.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { type LibrarySource, libraryDirs } from "./lib/skill-library.ts";


type Skill = { name: string; description: string; path: string; hay: string; source: LibrarySource };
let index: Skill[] | undefined;

function frontmatter(text: string, key: string): string {
	const fm = text.match(/^---\n([\s\S]*?)\n---/);
	const line = fm?.[1].match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
	return (line?.[1] ?? "").replace(/^["']|["']$/g, "").trim();
}

function loadIndex(): Skill[] {
	if (index) return index;
	index = [];
	for (const { source, dir } of libraryDirs()) {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry, "SKILL.md");
			if (!existsSync(path)) continue;
			const head = readFileSync(path, "utf8").slice(0, 4000);
			const name = frontmatter(head, "name") || entry;
			const description = frontmatter(head, "description");
			index.push({ name, description, path, source, hay: `${name} ${entry} ${description}`.toLowerCase() });
		}
	}
	return index;
}

function search(keywords: string[], limit: number): Skill[] {
	const terms = keywords.map((k) => k.toLowerCase().trim()).filter((k) => k.length > 1);
	return loadIndex()
		.map((s) => {
			// Breadth first: how many distinct keywords match; name hits break ties.
			let matched = 0;
			let nameHits = 0;
			for (const t of terms) {
				if (s.hay.includes(t)) matched++;
				if (s.name.toLowerCase().includes(t)) nameHits++;
			}
			return { s, score: matched * 10 + nameHits * 3 };
		})
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((r) => r.s);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "find_skills",
		label: "Find skills",
		description:
			"Search the aas + ecc skill libraries (~2600 skills, not listed in the prompt) by English keywords. Returns name, description and SKILL.md path. Call it whenever the user asks, in any wording or language, to pick/find/use/apply skills for the task.",
		parameters: Type.Object({
			keywords: Type.Array(Type.String(), { description: "5-10 English keywords: technologies, domain, activity (e.g. react, accessibility, audit)" }),
			limit: Type.Optional(Type.Number({ description: "Max results, default 12" })),
		}),
		async execute(_id, params) {
			const hits = search(params.keywords, Math.min(params.limit ?? 12, 25));
			const text =
				hits.length === 0
					? `No skills matched: ${params.keywords.join(", ")}. Retry with broader or synonym keywords.`
					: hits.map((s, i) => `${i + 1}. [${s.source}] ${s.name} — ${s.description.slice(0, 220)}\n   ${s.path}`).join("\n");
			return { content: [{ type: "text", text }], details: { count: hits.length } };
		},
	});

}
