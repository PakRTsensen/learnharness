/**
 * Stretch checkpoints for notes imports (issue #6).
 *
 * A notes import used to be one shot: any failure — a 503, a dead model, a
 * restart — threw away every merged chunk and the next import started again
 * from line one. The live instance proved the cost: 557 chunk jobs over 14.4
 * hours, 60.1M input tokens, chunk #1 extracted three times.
 *
 * The fix is a checkpoint unit that does NOT move when the operator tunes the
 * budget. Two sizes, deliberately independent:
 *
 *   stretch — fixed. STRETCH_TOKENS of content, derived from the text alone.
 *             The checkpoint unit: merging a chunk records its stretches.
 *   chunk   — a grouping of consecutive unfolded stretches, sized by the
 *             per-import budget. Pure batching; it decides how much work one
 *             model call carries, never what counts as progress.
 *
 * Changing the chunk size therefore re-batches the remaining work and
 * invalidates nothing. That matters because the live deployment had its
 * budget moved 4096 → 2000000 while runs were recorded at 4096 — under the
 * old whole-file checkpoint every one of those runs discarded the last.
 *
 * Fingerprint = sha256(contentHash + NUL + stretchText). NUL is the separator
 * because it cannot appear in text content, so no two (hash, text) pairs can
 * collide by concatenation. The content hash covers the whole file, so editing
 * any byte invalidates every stretch — a stretch only stays "done" while the
 * file it came from is byte-identical.
 *
 * Rows reuse the existing coverage ledger with chatId = the source id, which
 * means source deletion already purges them (deleteSourcesTraces reads
 * coverage rows by chatId) and the store needs no new file.
 */

import { createHash } from "node:crypto";

import type { CoverageEntry } from "./contracts/graph.ts";

export type { CoverageEntry };

/** A stretch's size in tokens (chars/4, the app-wide estimate). FIXED —
 *  never derived from, and never coupled to, the chunk budget.
 *
 *  Kept BELOW EXTRACTION_CHUNK_TOKENS_FLOOR (500) on purpose: the coarsest
 *  legal chunk budget must still batch at least one whole stretch, otherwise
 *  a user who sets the floor would silently receive chunks twice the size they
 *  asked for. Finer stretches cost nothing — they are checkpoint units, not
 *  model calls — so smaller only improves resume granularity. */
export const STRETCH_TOKENS = 256;

/** One checkpoint unit: the exact text that gets extracted, its fingerprint,
 *  and its size. */
export interface NotesStretch {
	/** sha256(contentHash + NUL + text) — see the module note. */
	fp: string;
	/** The stretch's own text, verbatim (chunks are built from these). */
	text: string;
	/** chars/4, ceil. */
	tokens: number;
}

/** One batch of consecutive stretches: what a single extract → audit → merge
 *  job carries. Purely a batching decision — merging it covers exactly
 *  `stretches`. */
export interface NotesChunk {
	stretches: NotesStretch[];
	/** The stretches joined by "\n" — the exact text the extractor sees. */
	text: string;
	tokens: number;
}

/** The fingerprint of one stretch. The content hash binds it to the file: a
 *  single edited byte changes every fingerprint in that file. */
function stretchFingerprint(contentHash: string, text: string): string {
	const h = createHash("sha256");
	h.update(contentHash);
	h.update("\0");
	h.update(text);
	return h.digest("hex");
}

/**
 * Split the notes text into fixed stretches. Greedy by line, chars/4, and a
 * line is never split (a single over-budget line rides alone — the same law
 * as the chat batcher, so one pathological line cannot fragment a file).
 *
 * Whitespace-only stretches are dropped: they carry nothing to extract, so
 * covering them would be a lie and extracting them would be a wasted call.
 */
export function notesStretches(contentHash: string, text: string): NotesStretch[] {
	if (text.trim().length === 0) return [];
	const out: NotesStretch[] = [];
	let current = "";
	const push = () => {
		if (current.trim().length > 0) {
			out.push({ fp: stretchFingerprint(contentHash, current), text: current, tokens: Math.ceil(current.length / 4) });
		}
		current = "";
	};
	for (const line of text.split("\n")) {
		const candidate = current.length === 0 ? line : `${current}\n${line}`;
		if (current.length > 0 && Math.ceil(candidate.length / 4) > STRETCH_TOKENS) {
			push();
			current = line;
		} else {
			current = candidate;
		}
	}
	push();
	return out;
}

/** The covered-fingerprint set for one source, from the ledger. */
export function coveredStretches(entries: ReadonlyArray<CoverageEntry>, sourceId: string): Set<string> {
	const out = new Set<string>();
	for (const entry of entries) if (entry.chatId === sourceId) out.add(entry.fp);
	return out;
}

/**
 * Group the still-unfolded stretches into chunks of at most `budget` tokens.
 * A stretch that no chunk can hold on its own (budget below one stretch, or a
 * pathological long line) rides alone rather than looping forever.
 */
export function planNotesChunks(uncovered: ReadonlyArray<NotesStretch>, budget: number): NotesChunk[] {
	const chunks: NotesChunk[] = [];
	let pending: NotesStretch[] = [];
	let tokens = 0;
	const flush = () => {
		if (pending.length === 0) return;
		chunks.push({ stretches: pending, text: pending.map((s) => s.text).join("\n"), tokens });
		pending = [];
		tokens = 0;
	};
	for (const stretch of uncovered) {
		if (pending.length > 0 && tokens + stretch.tokens > budget) flush();
		pending.push(stretch);
		tokens += stretch.tokens;
	}
	flush();
	return chunks;
}

/** The ledger rows a merged chunk earns. Written only AFTER every append of
 *  that chunk succeeded — the coverage discipline: "covered" means exactly
 *  that merge happened. */
export function stretchCoverage(sourceId: string, chunk: NotesChunk, foldedAt: string): CoverageEntry[] {
	return chunk.stretches.map((stretch) => ({
		chatId: sourceId,
		fp: stretch.fp,
		tokens: stretch.tokens,
		foldedAt,
	}));
}

/** sha256 of the file's bytes or text — the value that binds fingerprints to
 *  this exact content. */
export function notesContentHash(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}
