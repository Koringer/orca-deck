import { action, SingletonAction, type FeedbackPayload, type NeoInfobarAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";

import type { OrcaStore } from "../orca/store.ts";
import { INFOBAR_LAYOUT, renderInfobar } from "../render/infobar.ts";

@action({ UUID: "dev.orcadeck.infobar" })
export class OrcaInfobar extends SingletonAction {
	private readonly bars = new Map<string, { action: NeoInfobarAction<never>; last?: string }>();

	constructor(private readonly store: OrcaStore) {
		super();
	}

	override async onWillAppear(ev: WillAppearEvent) {
		if (!ev.action.isNeoInfobar()) return;
		await ev.action.setFeedbackLayout(INFOBAR_LAYOUT);
		this.bars.set(ev.action.id, { action: ev.action as NeoInfobarAction<never> });
	}

	override onWillDisappear(ev: WillDisappearEvent) {
		this.bars.delete(ev.action.id);
	}

	tick(now: number) {
		if (this.bars.size === 0) return;
		const { store } = this;
		const feedback = renderInfobar({ connection: store.connection, views: store.views, hidden: store.hiddenCount(), usage: store.usage, hooksIssue: store.hooksIssue, activeContext: store.activeContext, now });
		const serialized = JSON.stringify(feedback);
		for (const bar of this.bars.values()) {
			if (bar.last === serialized) continue;
			bar.last = serialized;
			void bar.action.setFeedback(feedback as FeedbackPayload).catch(() => {});
		}
	}
}
