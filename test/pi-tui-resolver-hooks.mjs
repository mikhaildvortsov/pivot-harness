// pi extensions import @earendil-works/* packages and typebox that are only installed inside the pi CLI. Tests resolve them from there.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BASE = "/Users/dvortsovmikhail/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/";

// Packages a bare specifier maps to inside the pi CLI install.
const PACKAGES = {
	typebox: "typebox/build/index.mjs",
};

// @earendil-works/<pkg> and its subpaths (@earendil-works/pi-ai/compat) live inside the pi CLI install.
function piPackagePath(spec) {
	const [scope, pkg, ...rest] = spec.split("/");
	if (scope !== "@earendil-works" || !pkg) return undefined;
	return BASE + `${scope}/${pkg}/dist/${rest.length ? `${rest.join("/")}.js` : "index.js"}`;
}

export async function resolve(spec, ctx, next) {
	try {
		return await next(spec, ctx);
	} catch (error) {
		const piPath = piPackagePath(spec);
		if (piPath && existsSync(piPath)) return { url: pathToFileURL(piPath).href, shortCircuit: true, format: "module" };
		const pkg = PACKAGES[spec];
		if (pkg) {
			const path = BASE + pkg;
			if (existsSync(path)) return { url: pathToFileURL(path).href, shortCircuit: true, format: "module" };
		}
		throw error;
	}
}
