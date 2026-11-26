// Fallback for Anthropic (subscription) when its quota ends or the API is unreachable: GPT-6.1 Sol on the ChatGPT subscription (provider openai-codex),
// reasoning "high" (the model supports minimal..max, not off).
export const FALLBACK = { provider: "openai-codex", id: "gpt-6.1-sol", label: "GPT-6.1 Sol", thinking: "high" as const };
/** Quota/limit, overload and access-blocked errors of the Anthropic API (a region/VPN block answers 403). */
const UNAVAILABLE = /usage limit|limit (reached|exceeded)|rate.?limit|quota|exceeded your|out of (extra )?usage|credit balance|insufficient|overloaded|at capacity|\b(429|529|403)\b|not allowed|blocked before it reached|resets? (at|in)\b/i;
export const anthropicUnavailable = (text: string | undefined) => !!text && UNAVAILABLE.test(text);
