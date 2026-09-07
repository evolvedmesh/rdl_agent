/**
 * WatchManager: one recursive watcher per layout root, mapped back to layout IDs.
 *
 * Two things trigger a render — a human saving in an editor, and the agent editing the
 * layout with its own Edit tool. Both now go through here (hot reload): the agent does
 * not have to remember to call `layout_render`, and a mid-turn edit shows up on the page
 * on its own. The arbitration rules are what keep that from turning into a storm of
 * renders:
 *
 *   - debounce hard (3s), so a whole burst of edits — one editor save, or an agent
 *     rewriting five textboxes in one turn — collapses into a single render once the file
 *     goes quiet
 *   - hash the bytes and drop the event if they are unchanged
 *   - `suppress()` is still here, held for the duration of one explicit `layout_render`
 *     call, so that render and the watcher do not both make a live BC round trip for the
 *     same bytes (the render engine's own content-hash dedupe is the backstop)
 *
 * Verified behaviour on Bun/Linux, and the reason `rescanOnDirCreate` exists: a file
 * created in a subdirectory that did not exist when the watch started is *missed*.
 * Pre-existing nested files report fine. That looks exactly like "recursive watch is
 * broken on Linux" until you notice it is a race against watch setup.
 */
import { type FSWatcher, watch } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export type WatchEvent = {
	layoutIds: string[];
	filePath: string;
	contentHash: string;
};

type Registration = { layoutId: string; filePath: string; root: string };

/**
 * 3s, not the old 250ms: the debounce now also has to absorb an agent's multi-edit turn
 * into one render, not just the two or three events one editor emits for a single save.
 * Overridable so the test suite does not have to wait it out for real.
 */
const DEBOUNCE_MS = 3000;

export class WatchManager {
	#watchers = new Map<string, FSWatcher>();
	#registrations = new Map<string, Registration>();
	#timers = new Map<string, ReturnType<typeof setTimeout>>();
	#hashes = new Map<string, string>();
	/**
	 * A refcount, not a flag: an explicit `layout_render` call suppresses its layout for
	 * the duration of the render, and nothing stops two of those from overlapping. A plain
	 * Set here would let the first release() lift a suppression the second caller still
	 * needs, so a concurrent edit would slip through mid-render. The count also means a
	 * caller that releases on both the success path and a `finally` cannot under-flow it.
	 */
	#suppressed = new Map<string, number>();
	#listeners = new Set<(e: WatchEvent) => void>();
	#closed = false;
	#debounceMs: number;

	constructor(
		private readonly onError: (e: unknown) => void = () => {},
		opts: { debounceMs?: number } = {},
	) {
		this.#debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
	}

	on(listener: (e: WatchEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Several layouts commonly live under one root, so watchers are shared per root. */
	register(layoutId: string, filePath: string): void {
		const abs = resolve(filePath);
		const root = dirname(abs);
		this.#registrations.set(layoutId, { layoutId, filePath: abs, root });
		this.#ensureWatcher(root);
	}

	unregister(layoutId: string): void {
		const reg = this.#registrations.get(layoutId);
		if (!reg) return;
		this.#registrations.delete(layoutId);
		const stillUsed = [...this.#registrations.values()].some(
			(r) => r.root === reg.root,
		);
		if (!stillUsed) {
			this.#watchers.get(reg.root)?.close();
			this.#watchers.delete(reg.root);
		}
	}

	/**
	 * Suppress watcher-driven renders for a layout while the agent edits it.
	 * Returns the release function; always call it, including on failure.
	 *
	 * Nestable: two independent callers can each hold a suppression on the same layout,
	 * and releasing one leaves the other's in effect. The release function is idempotent —
	 * calling it twice does not over-decrement — so a caller that releases on both success
	 * and a `finally` cannot double-release by accident.
	 */
	suppress(layoutId: string): () => void {
		this.#suppressed.set(layoutId, (this.#suppressed.get(layoutId) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (this.#suppressed.get(layoutId) ?? 1) - 1;
			if (remaining <= 0) this.#suppressed.delete(layoutId);
			else this.#suppressed.set(layoutId, remaining);
		};
	}

	isSuppressed(layoutId: string): boolean {
		return this.#suppressed.has(layoutId);
	}

	watchedRoots(): string[] {
		return [...this.#watchers.keys()];
	}

	close(): void {
		this.#closed = true;
		for (const t of this.#timers.values()) clearTimeout(t);
		this.#timers.clear();
		for (const w of this.#watchers.values()) w.close();
		this.#watchers.clear();
	}

	#ensureWatcher(root: string): void {
		if (this.#watchers.has(root) || this.#closed) return;
		try {
			const w = watch(root, { recursive: true }, (_event, filename) => {
				if (!filename) return;
				const abs = resolve(root, filename.toString());
				this.#onChange(root, abs);
			});
			w.on("error", (e) => this.onError(e));
			this.#watchers.set(root, w);
		} catch (e) {
			this.onError(e);
		}
	}

	#onChange(root: string, abs: string): void {
		// A newly created directory is not covered by the existing recursive watch, so
		// re-arm on it rather than silently missing every file created inside it.
		if (!abs.includes(".") || abs.endsWith(sep)) this.#ensureWatcher(root);

		const matches = [...this.#registrations.values()].filter(
			(r) => r.filePath === abs,
		);
		if (matches.length === 0) return;

		const existing = this.#timers.get(abs);
		if (existing) clearTimeout(existing);
		this.#timers.set(
			abs,
			setTimeout(() => {
				this.#timers.delete(abs);
				void this.#fire(abs, matches);
			}, this.#debounceMs),
		);
	}

	async #fire(abs: string, matches: Registration[]): Promise<void> {
		const live = matches.filter((m) => !this.#suppressed.has(m.layoutId));
		if (live.length === 0) return;

		try {
			const file = Bun.file(abs);
			if (!(await file.exists())) return;
			const bytes = await file.arrayBuffer();
			const hasher = new Bun.CryptoHasher("sha256");
			hasher.update(new Uint8Array(bytes));
			const contentHash = hasher.digest("hex").slice(0, 16);

			// An editor can emit several events for one save; identical bytes are not a change.
			if (this.#hashes.get(abs) === contentHash) return;
			this.#hashes.set(abs, contentHash);

			const event: WatchEvent = {
				layoutIds: live.map((m) => m.layoutId),
				filePath: abs,
				contentHash,
			};
			for (const l of this.#listeners) {
				try {
					l(event);
				} catch (e) {
					this.onError(e);
				}
			}
		} catch (e) {
			this.onError(e);
		}
	}
}
