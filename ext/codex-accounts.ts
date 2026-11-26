// Two ChatGPT subscription accounts for GPT-6.1 Sol (provider openai-codex). pi keeps one login per provider in auth.json, so the second account is kept
// as a saved slot and swapped in on demand:
//   pi auth login openai-codex        (sign in with account A in the browser)   →  /codex-account save a
//   pi auth login openai-codex        (sign in with account B)                  →  /codex-account save b
//   /codex-account use a|b|next       swaps the login (the current one is written back to its slot first, so refreshed tokens are not lost) and reloads
//   /codex-account                    shows the slots; tokens are never printed
// When Sol hits its usage limit, quota-fallback.ts asks for `/codex-account next`; with no other slot it tells you which account to sign in.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER = "openai-codex";
const AUTH = join(homedir(), ".pi", "agent", "auth.json");
const DIR = join(homedir(), ".pi", "agent", "state", "codex-accounts");
const CURRENT = join(DIR, "current");
const slotFile = (name: string) => join(DIR, `${name.replace(/[^\w.-]/g, "_")}.json`);

const readAuth = (): Record<string, unknown> => {
	try {
		return JSON.parse(readFileSync(AUTH, "utf8"));
	} catch {
		return {};
	}
};
const writeSecret = (file: string, text: string) => {
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
};
const slots = () => (existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : []);
const current = () => (existsSync(CURRENT) ? readFileSync(CURRENT, "utf8").trim() : "");

/** Writes the login that pi holds right now back into the slot it came from (pi refreshes tokens in auth.json). */
const stash = () => {
	const cur = current();
	const cred = readAuth()[PROVIDER];
	if (cur && cred) writeSecret(slotFile(cur), JSON.stringify(cred));
};

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR === "1") return;
	pi.registerCommand("codex-account", {
		description: "Два аккаунта ChatGPT для GPT-6.1 Sol: save <имя> | use <имя|next> | список",
		handler: async (args, ctx) => {
			const [cmd = "", rawName = ""] = args.trim().split(/\s+/);
			mkdirSync(DIR, { recursive: true, mode: 0o700 });
			const say = (m: string, l: "info" | "warning" | "error" = "info") => ctx.ui.notify(m, l);

			if (cmd === "save" && rawName) {
				const cred = readAuth()[PROVIDER];
				if (!cred) return say(`Нет входа ${PROVIDER}. Сначала выполните в терминале: pi auth login ${PROVIDER}`, "error");
				writeSecret(slotFile(rawName), JSON.stringify(cred));
				writeSecret(CURRENT, rawName);
				return say(`Аккаунт «${rawName}» сохранён и выбран. Слоты: ${slots().join(", ")}`);
			}
			if (cmd === "use" && rawName) {
				const all = slots();
				const cur = current();
				const target = rawName === "next" ? (all.filter((n) => n !== cur)[0] ?? "") : rawName;
				if (!target || !existsSync(slotFile(target))) {
					return say(rawName === "next" ? `Другого аккаунта нет. Войдите вторым и сохраните: pi auth login ${PROVIDER}, затем /codex-account save <имя>` : `Нет слота «${rawName}». Есть: ${all.join(", ") || "—"}`, "warning");
				}
				if (target === cur) return say(`Аккаунт «${target}» уже выбран`);
				stash();
				const auth = readAuth();
				auth[PROVIDER] = JSON.parse(readFileSync(slotFile(target), "utf8"));
				writeSecret(AUTH, JSON.stringify(auth, null, 2));
				writeSecret(CURRENT, target);
				say(`Аккаунт ChatGPT: «${cur || "?"}» → «${target}». Перезагружаю.`);
				await ctx.reload(); // the old ctx is retired after this; nothing else is done with it
				return;
			}
			const all = slots();
			const cur = current();
			say(all.length ? `Аккаунты ChatGPT: ${all.map((n) => (n === cur ? `${n} (текущий)` : n)).join(", ")}` : `Аккаунтов нет. Войдите: pi auth login ${PROVIDER}, затем /codex-account save <имя>`);
		},
	});
}
