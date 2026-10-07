import { action, SingletonAction, type KeyAction, type KeyUpEvent, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";

import type { OrcaStore } from "../orca/store.ts";
import { toDataUrl } from "../render/key.ts";
import { renderStatus } from "../render/status.ts";

/** The Neo infobar as a regular key, for decks without an infobar (Stream Deck Mobile, Mini, MK.2…). */
@action({ UUID: "dev.orcadeck.status" })
export class StatusKey extends SingletonAction {
	private readonly keys = new Map<string, { action: KeyAction<never>; last?: string }>();

	constructor(
		private readonly store: OrcaStore,
		private readonly onError: (e: unknown) => void,
	) {
		super();
	}

	override onWillAppear(ev: WillAppearEvent) {
		if (!ev.action.isKey()) return;
		this.keys.set(ev.action.id, { action: ev.action as KeyAction<never> });
		void ev.action.setTitle("");
	}

	override onWillDisappear(ev: WillDisappearEvent) {
		this.keys.delete(ev.action.id);
	}

	/** Brings Orca to the front (or launches it). */
	override onKeyUp(ev: KeyUpEvent) {
		this.store.openOrca().catch((e) => {
			this.onError(e);
			void ev.action.showAlert();
		});
	}

	tick(now: number) {
		if (this.keys.size === 0) return;
		const { store } = this;
		const svg = renderStatus({ connection: store.connection, views: store.views, usage: store.usage, hooksIssue: store.hooksIssue, activeContext: store.activeContext, now });
		for (const key of this.keys.values()) {
			if (key.last === svg) continue;
			key.last = svg;
			void key.action.setImage(toDataUrl(svg)).catch(() => {});
		}
	}
}
