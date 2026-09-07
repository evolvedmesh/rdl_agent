/**
 * A stop-gap for OS text-editing shortcuts the GPUIX 0.7 native input does not bind on
 * Linux.
 *
 * The native editor (`gpuix_text_editor`) *has* the actions — `DeleteWordLeft`,
 * `WordLeft`, `SelectAll`, … — but its keymap binds them to the macOS `cmd-*` chords, not
 * the `ctrl-*` / `alt-*` ones a Linux user reaches for. A React `onKeyDown` handler cannot
 * register a GPUI keybinding and there is no `preventDefault`, so the most we can do from
 * here is watch for the unbound chord and rewrite the field value ourselves.
 *
 * Scope of what this actually fixes: **Ctrl/Alt+Backspace deletes the previous word**,
 * and only correctly when the caret is at the end of the field — GPUIX exposes no caret
 * or selection position to JS, so a mid-text caret is assumed-at-end and would clip the
 * wrong word. That is the dominant case in the chat composer (you are appending), so it
 * is worth doing; full parity needs the fix upstream in GPUIX's keymap.
 */
import type { EventPayload } from "@gpuix/react";

/**
 * Handle an unbound word-edit chord. Returns true if it acted (the caller can stop),
 * false to let the native pipeline have the key.
 */
export function handleWordEdit(
	e: EventPayload,
	value: string,
	onChange: (v: string) => void,
): boolean {
	const mod = e.modifiers;
	const wordChord = Boolean(mod?.ctrl || mod?.alt) && !mod?.cmd && !mod?.shift;
	if (!wordChord) return false;

	// Ctrl/Alt+Backspace — delete the word before the caret (assumed end of field).
	if (e.key === "backspace") {
		const next = value.replace(/\s+$/, "").replace(/\S+$/, "");
		if (next !== value) onChange(next);
		return true;
	}

	return false;
}
