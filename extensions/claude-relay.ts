// pi-claude-relay: relays Pi's built-in `anthropic` provider through the official `claude` CLI.
// Set PI_CLAUDE_RELAY=off to use Pi's direct Anthropic streaming instead.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piAi from "@earendil-works/pi-ai";
import { join } from "node:path";
import { adoptProvider, registerRelay } from "../src/register.ts";

export default function (pi: ExtensionAPI) {
	const provider = registerRelay(pi, { piAi: piAi as any, configDir: join(getAgentDir(), "claude-relay"), settingsFile: join(getAgentDir(), "claude-relay-settings.json") });
	// Pi runs this factory again on every /reload and /new: close the previous provider's claude processes and keep one exit listener.
	adoptProvider(provider);
}
