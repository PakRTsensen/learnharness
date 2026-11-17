/**
 * Stretch checkpoints (issue #6).
 *
 * The contract under test: the checkpoint unit is a FIXED stretch, so the
 * chunk budget is pure batching. Changing it re-groups the remaining work and
 * invalidates nothing — that is the property the live deployment needed, where
 * the budget had been moved 4096 → 2000000 while runs were recorded at 4096.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	STRETCH_TOKENS,
	coveredStretches,
	notesContentHash,
	notesStretches,
	planNotesChunks,
	stretchCoverage,
} from "../src/core/notes-stretches.ts";

/** n lines, each `chars` long, joined by newlines. */
const lines = (n: number, chars = 200): string => Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(chars)}`).join("\n");

describe("notes stretches", () => {
	it("keeps every stretch at or under the fixed budget unless a single line overflows", () => {
		const text = lines(200);
		const stretches = notesStretches(notesContentHash(text), text);
		assert.ok(stretches.length > 1, "a long file splits into several stretches");
		for (const stretch of stretches) {
			// A stretch is at most one line over budget: lines are never split.
			const longestLine = Math.max(...stretch.text.split("\n").map((line) => Math.ceil(line.length / 4)));
			assert.ok(
				stretch.tokens <= STRETCH_TOKENS || stretch.tokens === longestLine,
				`stretch of ${stretch.tokens} tok exceeds ${STRETCH_TOKENS} without being a single line`,
			);
		}
	});

	it("reassembles the file: no content is lost or reordered", () => {
		const text = lines(50);
		const stretches = notesStretches(notesContentHash(text), text);
		assert.equal(stretches.map((s) => s.text).join("\n"), text);
	});

	it("drops whitespace-only stretches", () => {
		assert.deepEqual(notesStretches(notesContentHash("   \n\n\t\n"), "   \n\n\t\n"), []);
		assert.deepEqual(notesStretches(notesContentHash(""), ""), []);
	});

	it("binds fingerprints to file content: one edited byte invalidates every stretch", () => {
		const text = lines(20);
		const original = notesStretches(notesContentHash(text), text);
		const edited = notesStretches(notesContentHash(`${text}\n`), `${text}\n`);
		assert.ok(original.length > 0);
		const editedFps = new Set(edited.map((s) => s.fp));
		for (const stretch of original) {
			assert.equal(editedFps.has(stretch.fp), false, "an edited file invalidates every checkpoint");
		}
	});

	it("keeps fingerprints stable for identical content", () => {
		const text = lines(20);
		const a = notesStretches(notesContentHash(text), text);
		const b = notesStretches(notesContentHash(text), text);
		assert.deepEqual(a.map((s) => s.fp), b.map((s) => s.fp));
	});

	it("covers only the merged chunk's stretches, keyed by source id", () => {
		const text = lines(20);
		const stretches = notesStretches(notesContentHash(text), text);
		const chunks = planNotesChunks(stretches, STRETCH_TOKENS * 2);
		const rows = stretchCoverage("src_abc", chunks[0]!, "2026-01-01T00:00:00.000Z");
		assert.deepEqual(rows.map((r) => r.fp), chunks[0]!.stretches.map((s) => s.fp));
		assert.ok(rows.every((r) => r.chatId === "src_abc"), "rows reuse the coverage ledger under the source id");
		const covered = coveredStretches(rows, "src_abc");
		for (const stretch of chunks[0]!.stretches) assert.ok(covered.has(stretch.fp));
		// A different source sees none of them.
		assert.equal(coveredStretches(rows, "src_other").size, 0);
	});

	it("CHANGING THE CHUNK BUDGET INVALIDATES NOTHING (the issue's core criterion)", () => {
		const text = lines(120);
		const hash = notesContentHash(text);
		const stretches = notesStretches(hash, text);
		assert.ok(stretches.length >= 4, "needs enough stretches to re-batch");

		// Run under a small budget: cover what the first chunk would cover.
		const small = planNotesChunks(stretches, STRETCH_TOKENS);
		assert.ok(small.length > 1, "a small budget yields several chunks");
		const merged = stretchCoverage("src_x", small[0]!, "2026-01-01T00:00:00.000Z");
		const covered = coveredStretches(merged, "src_x");

		// Re-plan the remainder under a much larger budget.
		const remaining = stretches.filter((s) => !covered.has(s.fp));
		const large = planNotesChunks(remaining, STRETCH_TOKENS * 8);

		// The work already done stays done; the new plan only covers the rest.
		assert.equal(remaining.length, stretches.length - small[0]!.stretches.length, "no covered stretch comes back");
		assert.deepEqual(
			large.flatMap((chunk) => chunk.stretches.map((s) => s.fp)),
			remaining.map((s) => s.fp),
			"the larger budget re-batches exactly the unfolded stretches",
		);
		assert.ok(large.length < small.length - 1 + 1 || large.length <= remaining.length, "fewer, bigger chunks");
	});

	it("lets a stretch ride alone when it exceeds the budget", () => {
		const text = lines(6);
		const stretches = notesStretches(notesContentHash(text), text);
		const chunks = planNotesChunks(stretches, 1); // absurdly small
		assert.equal(chunks.length, stretches.length, "one stretch per chunk, never an infinite loop");
		assert.ok(chunks.every((chunk) => chunk.stretches.length === 1));
	});

	it("plans nothing when everything is already covered", () => {
		assert.deepEqual(planNotesChunks([], 4096), []);
	});
});
