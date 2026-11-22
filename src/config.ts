// The relay takes over Pi's built-in Anthropic provider: only its streaming is replaced.
// Pi's own model catalog and auth stay untouched, so models keep their normal ids
// (`claude-opus-5-5`, `anthropic/claude-sonnet-5-5`).
export const PROVIDER = "anthropic";
// Pi routes a model to the extension's streamSimple when `model.api === config.api`.
// Every model in Pi's Anthropic catalog uses this api (pi-ai providers/data/anthropic.json).
export const API = "anthropic-messages";
export const OPT_OUT_ENV = "PI_CLAUDE_RELAY";

/** `PI_CLAUDE_RELAY=off|0|false` disables the relay so Pi streams Anthropic directly. */
export function relayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env[OPT_OUT_ENV]?.trim().toLowerCase();
	return !(v === "off" || v === "0" || v === "false");
}

/** Legacy ProviderConfig for pi.registerProvider(PROVIDER, ...): no `models`, no auth fields. */
export function providerConfig(streamSimple: (...args: any[]) => any) {
	return { api: API, streamSimple };
}
