/** Snapshot-based undo/redo.
 *
 * Annotation sets are small (tens to hundreds of objects), so keeping whole
 * snapshots is cheaper to reason about than inverting every edit and it makes
 * "undo" correct for compound operations such as multi-select delete. */
export class History<T> {
	private past: T[] = [];
	private future: T[] = [];

	constructor(private readonly limit = 100) {}

	/** Record the state *before* a mutation. Clears the redo stack. */
	push(snapshot: T): void {
		this.past.push(snapshot);
		if (this.past.length > this.limit) this.past.shift();
		this.future.length = 0;
	}

	undo(current: T): T | null {
		const previous = this.past.pop();
		if (previous === undefined) return null;
		this.future.push(current);
		return previous;
	}

	redo(current: T): T | null {
		const next = this.future.pop();
		if (next === undefined) return null;
		this.past.push(current);
		return next;
	}

	get canUndo(): boolean {
		return this.past.length > 0;
	}

	get canRedo(): boolean {
		return this.future.length > 0;
	}

	clear(): void {
		this.past.length = 0;
		this.future.length = 0;
	}
}
