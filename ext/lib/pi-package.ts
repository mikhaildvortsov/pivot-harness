// Locates the installed pi package (version, root, real cli path). Shared by journal.ts and self-check.ts.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export function piPackage(): { version: string; root: string; cli: string } | undefined {
	let cli: string;
	try {
		cli = realpathSync(process.argv[1] ?? "");
	} catch {
		return undefined;
	}
	let dir = dirname(cli);
	for (let i = 0; i < 6 && dir !== dirname(dir); i++, dir = dirname(dir)) {
		const pkg = join(dir, "package.json");
		if (!existsSync(pkg)) continue;
		const json = JSON.parse(readFileSync(pkg, "utf8"));
		if (json.name === "@earendil-works/pi-coding-agent") return { version: json.version, root: dir, cli };
	}
	return undefined;
}
