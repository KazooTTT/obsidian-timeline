import { Plugin } from 'obsidian';
import {
	TIMELINE_ICON,
	VIEW_TYPE_TIMELINE,
} from './constants';
import {
	openTimelineView,
	TimelineView,
} from './TimelineView';
import type { TimelineSort } from './timeline-utils';

interface TimelineSettings {
	sortBy: TimelineSort;
}

const DEFAULT_SETTINGS: TimelineSettings = {
	sortBy: 'created',
};

export default class TimelinePlugin extends Plugin {
	settings: TimelineSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<TimelineSettings>,
		);

		this.registerView(
			VIEW_TYPE_TIMELINE,
			(leaf) => new TimelineView(leaf, this),
		);

		this.addCommand({
			id: 'open-vault-timeline',
			name: '打开时间线',
			callback: () => {
				void openTimelineView(this.app);
			},
		});

		this.addRibbonIcon(TIMELINE_ICON, '打开时间线', () => {
			void openTimelineView(this.app);
		});
	}

	onunload(): void {
		this.app.workspace
			.getLeavesOfType(VIEW_TYPE_TIMELINE)
			.forEach((leaf) => leaf.detach());
	}

	async setSortBy(sortBy: TimelineSort): Promise<void> {
		this.settings.sortBy = sortBy;
		await this.saveData(this.settings);
	}
}

