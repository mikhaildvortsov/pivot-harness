// Locations of the aas (agentic-awesome-skills) and ecc skill libraries: the newest installed Claude plugin version.
// Shared by skill-router.ts and subagent-skills.ts; not an extension itself (not listed in settings.json).
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LibrarySource = "aas" | "ecc";

const PLUGIN_ROOTS: Array<{ source: LibrarySource; root: string }> = [
	{ source: "aas", root: join(homedir(), ".claude", "plugins", "cache", "agentic-awesome-skills", "agentic-awesome-skills") },
	{ source: "ecc", root: join(homedir(), ".claude", "plugins", "cache", "ecc", "ecc") },
];

export function libraryDirs(): Array<{ source: LibrarySource; dir: string }> {
	const out: Array<{ source: LibrarySource; dir: string }> = [];
	for (const { source, root } of PLUGIN_ROOTS) {
		if (!existsSync(root)) continue;
		const versions = readdirSync(root)
			.filter((v) => existsSync(join(root, v, "skills")))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		const latest = versions.at(-1);
		if (latest) out.push({ source, dir: join(root, latest, "skills") });
	}
	return out;
}

export function isLibrarySkill(path: string): boolean {
	return path.endsWith("SKILL.md") && libraryDirs().some(({ dir }) => path.startsWith(`${dir}/`));
}
