import { action, SingletonAction, type KeyAction, type KeyDownEvent, type KeyUpEvent, type WillAppearEvent, type WillDisappearEvent, type DidReceiveSettingsEvent } from "@elgato/streamdeck";

import type { OrcaStore } from "../orca/store.ts";
import { renderKey, toDataUrl } from "../render/key.ts";

type KeySettings = {
	/** Neo page this key lives on (1-based); keys on page 2 continue the slot numbering after page 1. */
	page?: number;
};

type Instance = {
	action: KeyAction<KeySettings>;
	slot: number;
	lastImage?: string;
	downAt?: number;
	/** Long press already fired for the current press. */
	fired?: boolean;
};

@action({ UUID: "dev.orcadeck.worktree" })
export class WorktreeKey extends SingletonAction<KeySettings> {
	private readonly instances = new Map<string, Instance>();

	constructor(
		private readonly store: OrcaStore,
		private readonly onError: (e: unknown) => void,
	) {
		super();
	}

	override onWillAppear(ev: WillAppearEvent<KeySettings>) {
		if (!ev.action.isKey()) return;
		this.mount(ev.action, ev.payload.settings);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>) {
		if (!ev.action.isKey()) return;
		this.unmount(ev.action.id);
		this.mount(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<KeySettings>) {
		this.unmount(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<KeySettings>) {
		const inst = this.instances.get(ev.action.id);
		if (inst) {
			inst.downAt = Date.now();
			inst.fired = false;
			this.store.touch(inst.slot);
		}
	}

	override onKeyUp(ev: KeyUpEvent<KeySettings>) {
		const inst = this.instances.get(ev.action.id);
		if (!inst || inst.downAt === undefined) return;
		const fired = inst.fired;
		inst.downAt = undefined;
		inst.fired = false;
		if (fired) return;

		if (this.store.connection !== "ok") return this.run(inst, this.store.openOrca());
		const slot = this.store.slot(inst.slot);
		if (slot.pending && slot.pending.kind !== "dirty") return;
		this.run(inst, slot.kind === "empty" ? this.store.createInSlot(inst.slot) : this.store.focusWorktree(inst.slot));
	}

	/** Called by the plugin's animation ticker. */
	tick(now: number) {
		const holdMs = this.store.config.holdMs;
		for (const inst of this.instances.values()) {
			let hold: number | null = null;
			if (inst.downAt !== undefined && !inst.fired && this.store.connection === "ok") {
				hold = (now - inst.downAt) / holdMs;
				if (hold >= 1) {
					inst.fired = true;
					hold = null;
					this.run(inst, this.store.replaceSlot(inst.slot));
				}
			}

			const svg = renderKey({ connection: this.store.connection, slot: this.store.slot(inst.slot), now, hold });
			if (svg !== inst.lastImage) {
				inst.lastImage = svg;
				void inst.action.setImage(toDataUrl(svg)).catch(() => {});
			}
		}
	}

	private mount(keyAction: KeyAction<KeySettings>, settings: KeySettings) {
		const coords = keyAction.coordinates;
		if (!coords) return; // inside a multi-action
		const columns = keyAction.device.size.columns;
		const perPage = columns * keyAction.device.size.rows;
		const page = Math.max(1, Math.floor(settings.page ?? 1));
		const slot = (page - 1) * perPage + coords.row * columns + coords.column;
		this.instances.set(keyAction.id, { action: keyAction, slot });
		this.store.registerSlot(slot);
		void keyAction.setTitle("");
	}

	private unmount(id: string) {
		const inst = this.instances.get(id);
		if (!inst) return;
		this.instances.delete(id);
		if (![...this.instances.values()].some((i) => i.slot === inst.slot)) this.store.unregisterSlot(inst.slot);
	}

	private run(inst: Instance, p: Promise<unknown>) {
		p.catch((e) => {
			this.onError(e);
			void inst.action.showAlert();
		});
	}
}
