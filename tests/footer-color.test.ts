import { test } from "node:test";
import assert from "node:assert/strict";
import { paint, plain, utilizationColor } from "../src/footer-color.ts";

const fake = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };

test("paint colors only the segments that carry a color", () => {
	const segs = [{ text: "Claude " }, { text: "5h 14%", color: "success" as const }, { text: " · " }, { text: "7d 91%", color: "error" as const }];
	assert.equal(paint(segs, fake), "Claude <success>5h 14%</success> · <error>7d 91%</error>");
	assert.equal(plain(segs), "Claude 5h 14% · 7d 91%");
});

test("without a usable theme the text is plain; a throwing theme never throws", () => {
	const segs = [{ text: "✓", color: "success" as const }, { text: " Claude relay" }];
	assert.equal(paint(segs), "✓ Claude relay");
	assert.equal(paint(segs, undefined), "✓ Claude relay");
	assert.equal(paint(segs, {} as any), "✓ Claude relay");
	assert.equal(paint(segs, { fg() { throw new Error("boom"); } }), "✓ Claude relay");
	assert.equal(paint(segs, { fg: () => 42 } as any), "✓ Claude relay");
});

test("utilization thresholds match Pi's footer: >90 error, >70 warning, else success", () => {
	assert.equal(utilizationColor(0.5), "success");
	assert.equal(utilizationColor(0.7), "success");
	assert.equal(utilizationColor(0.71), "warning");
	assert.equal(utilizationColor(0.9), "warning");
	assert.equal(utilizationColor(0.91), "error");
});
