import { test } from "node:test";
import assert from "node:assert/strict";
import { providerConfig, relayEnabled, API, PROVIDER, OPT_OUT_ENV } from "../src/config.ts";

test("relay takes over pi's built-in anthropic provider and api (S4: no relay-specific prefix)", () => {
	assert.equal(PROVIDER, "anthropic");
	assert.equal(API, "anthropic-messages");
	assert.equal(OPT_OUT_ENV, "PI_CLAUDE_RELAY");
});

test("provider config overrides only streaming: api + streamSimple, nothing that replaces Pi's catalog or auth", () => {
	const stream = () => ({}) as any;
	const c = providerConfig(stream) as Record<string, unknown>;
	assert.deepEqual(Object.keys(c).sort(), ["api", "streamSimple"]);
	assert.equal(c.api, "anthropic-messages");
	assert.equal(c.streamSimple, stream);
});

test("relayEnabled: PI_CLAUDE_RELAY=off|0|false (any case, trimmed) disables; anything else keeps it on", () => {
	for (const v of ["off", "OFF", "Off", "0", "false", "FALSE", " off "]) assert.equal(relayEnabled({ PI_CLAUDE_RELAY: v }), false, v);
	for (const v of [undefined, "", "on", "1", "true", "relay"]) assert.equal(relayEnabled({ PI_CLAUDE_RELAY: v }), true, String(v));
	assert.equal(relayEnabled({}), true);
});
