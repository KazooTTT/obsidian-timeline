import {
	Component,
	ItemView,
	MarkdownRenderer,
	Notice,
	Scope,
	TFile,
	TFolder,
	WorkspaceLeaf,
	getAllTags,
	normalizePath,
	type App,
} from 'obsidian';
import {
	INITIAL_BATCH_SIZE,
	PREVIEW_CHARACTER_LIMIT,
	TIMELINE_ICON,
	TIMELINE_NOTE_FOLDER,
	VIEW_TYPE_TIMELINE,
} from './constants';
import type TimelinePlugin from './main';
import {
	createExcerpt,
	timestampFor,
	type TimelineSort,
} from './timeline-utils';

export class TimelineView extends ItemView {
	private listEl: HTMLElement | null = null;
	private summaryEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	private composerEl: HTMLElement | null = null;
	private composerInputEl: HTMLTextAreaElement | null = null;
	private tagSuggestEl: HTMLElement | null = null;
	private tagSuggestions: string[] = [];
	private selectedTagIndex = 0;
	private tagQueryStart = -1;
	private availableTags: string[] = [];
	private loadMoreEl: HTMLButtonElement | null = null;
	private sortedFiles: TFile[] = [];
	private filteredFiles: TFile[] = [];
	private renderedCount = 0;
	private renderGeneration = 0;
	private renderComponents: Component[] = [];
	private loadingGenerations = new Set<number>();
	private refreshTimer: number | null = null;
	private searchTimer: number | null = null;
	private loadObserver: IntersectionObserver | null = null;
	private searchQuery = '';
	private startDate = '';
	private endDate = '';
	private contentIndex = new Map<
		string,
		{ mtime: number; searchableContent: string }
	>();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: TimelinePlugin,
	) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
	}

	getViewType(): string {
		return VIEW_TYPE_TIMELINE;
	}

	getDisplayText(): string {
		return 'Vault 时间线';
	}

	getIcon(): string {
		return TIMELINE_ICON;
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('vault-timeline');

		this.renderHeader(container);
		this.renderComposer(container);
		this.availableTags = this.collectVaultTags();
		this.listEl = container.createDiv({ cls: 'vault-timeline__list' });
		this.loadMoreEl = container.createEl('button', {
			cls: 'vault-timeline__load-more',
			text: '加载更多',
		});
		this.loadMoreEl.addEventListener('click', () => {
			void this.renderNextBatch();
		});
		this.loadObserver = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					void this.renderNextBatch();
				}
			},
			{ root: container, rootMargin: '240px 0px' },
		);
		this.loadObserver.observe(this.loadMoreEl);

		this.scope?.register(['Mod'], 'f', () => {
			this.searchInputEl?.focus();
			this.searchInputEl?.select();
			return false;
		});
		this.scope?.register(['Mod'], 'Enter', () => {
			if (
				document.activeElement !== this.composerInputEl ||
				!this.composerEl
			) {
				return;
			}
			void this.createTimelineNote();
			return false;
		});
		this.registerDomEvent(
			window,
			'keydown',
			(event) => {
				if (
					this.app.workspace.activeLeaf?.view !== this ||
					!(event.metaKey || event.ctrlKey) ||
					event.altKey
				) {
					return;
				}
				if (!event.shiftKey && event.key.toLocaleLowerCase() === 'f') {
					event.preventDefault();
					event.stopImmediatePropagation();
					this.searchInputEl?.focus();
					this.searchInputEl?.select();
					return;
				}
				if (
					event.key === 'Enter' &&
					document.activeElement === this.composerInputEl &&
					!!this.composerEl
				) {
					event.preventDefault();
					event.stopImmediatePropagation();
					void this.createTimelineNote();
				}
			},
			{ capture: true },
		);

		const scheduleRefresh = (file?: TFile): void => {
			if (file) {
				this.contentIndex.delete(file.path);
			}
			if (this.refreshTimer !== null) {
				window.clearTimeout(this.refreshTimer);
			}
			this.refreshTimer = window.setTimeout(() => {
				this.refreshTimer = null;
				void this.refresh();
			}, 300);
		};

		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile) scheduleRefresh(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) scheduleRefresh(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				this.contentIndex.delete(oldPath);
				if (file instanceof TFile) scheduleRefresh(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile) scheduleRefresh(file);
			}),
		);

		await this.refresh();
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
		}
		if (this.searchTimer !== null) {
			window.clearTimeout(this.searchTimer);
		}
		this.loadObserver?.disconnect();
		this.clearRenderComponents();
	}

	private renderHeader(container: HTMLElement): void {
		const header = container.createDiv({ cls: 'vault-timeline__header' });
		const heading = header.createDiv({ cls: 'vault-timeline__heading' });
		heading.createEl('h2', { text: 'Vault 时间线' });
		this.summaryEl = heading.createDiv({ cls: 'vault-timeline__summary' });

		const controls = header.createDiv({ cls: 'vault-timeline__controls' });
		const search = controls.createEl('input', {
			cls: 'vault-timeline__search',
			attr: {
				type: 'search',
				placeholder: '搜索标题、路径或正文',
				'aria-label': '搜索时间线',
			},
		});
		this.searchInputEl = search;
		search.addEventListener('input', () => {
			this.searchQuery = search.value.trim().toLocaleLowerCase();
			if (this.searchTimer !== null) {
				window.clearTimeout(this.searchTimer);
			}
			this.searchTimer = window.setTimeout(() => {
				this.searchTimer = null;
				void this.applyFilters();
			}, 250);
		});

		const range = controls.createDiv({ cls: 'vault-timeline__range' });
		const startInput = this.createDateInput(range, '开始日期', (value) => {
			this.startDate = value;
			void this.applyFilters();
		});
		range.createSpan({ text: '至' });
		const endInput = this.createDateInput(range, '结束日期', (value) => {
			this.endDate = value;
			void this.applyFilters();
		});
		const clearRange = range.createEl('button', {
			cls: 'vault-timeline__clear-range',
			text: '清除时间',
		});
		clearRange.addEventListener('click', () => {
			startInput.value = '';
			endInput.value = '';
			this.startDate = '';
			this.endDate = '';
			void this.applyFilters();
		});

		const sorter = controls.createDiv({ cls: 'vault-timeline__sorter' });
		sorter.createSpan({ text: '排序' });
		const select = sorter.createEl('select', {
			attr: { 'aria-label': '时间线排序方式' },
		});
		select.createEl('option', { text: '创建时间', value: 'created' });
		select.createEl('option', { text: '更新时间', value: 'modified' });
		select.value = this.plugin.settings.sortBy;
		select.addEventListener('change', () => {
			const sortBy = select.value as TimelineSort;
			void this.plugin.setSortBy(sortBy);
			void this.refresh();
		});
	}

	private renderComposer(container: HTMLElement): void {
		this.composerEl = container.createDiv({
			cls: 'vault-timeline__composer',
		});
		this.composerEl.createDiv({
			cls: 'vault-timeline__composer-hint',
			text: `保存到 ${TIMELINE_NOTE_FOLDER}/ · 文件名自动使用当前时间`,
		});
		this.composerInputEl = this.composerEl.createEl('textarea', {
			cls: 'vault-timeline__composer-input',
			attr: {
				placeholder: '现在在想什么？支持 Markdown…',
				'aria-label': '新笔记内容',
			},
		});
		this.tagSuggestEl = this.composerEl.createDiv({
			cls: 'vault-timeline__tag-suggestions is-hidden',
			attr: { role: 'listbox', 'aria-label': '标签建议' },
		});

		const actions = this.composerEl.createDiv({
			cls: 'vault-timeline__composer-actions',
		});
		const cancelButton = actions.createEl('button', { text: '取消' });
		const saveButton = actions.createEl('button', {
			cls: 'mod-cta',
			text: '保存',
		});
		cancelButton.addEventListener('click', () => this.closeComposer());
		saveButton.addEventListener('click', () => {
			void this.createTimelineNote();
		});
		this.composerInputEl.addEventListener('input', () => {
			this.updateTagSuggestions();
		});
		this.composerInputEl.addEventListener('focus', () => {
			this.availableTags = this.collectVaultTags();
		});
		this.composerInputEl.addEventListener('keydown', (event) => {
			if (this.handleTagSuggestionKeydown(event)) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				this.closeComposer();
			}
		});
	}

	private closeComposer(): void {
		if (!this.composerInputEl) {
			return;
		}
		this.composerInputEl.value = '';
		this.hideTagSuggestions();
	}

	private collectVaultTags(): string[] {
		const tags = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			for (const tag of getAllTags(cache) ?? []) {
				tags.add(tag.startsWith('#') ? tag : `#${tag}`);
			}
		}
		return [...tags].sort((left, right) => left.localeCompare(right));
	}

	private updateTagSuggestions(): void {
		const input = this.composerInputEl;
		if (!input) return;

		const cursor = input.selectionStart;
		const match = input.value.slice(0, cursor).match(/(?:^|\s)(#[^\s#]*)$/);
		if (!match?.[1]) {
			this.hideTagSuggestions();
			return;
		}

		const query = match[1].slice(1).toLocaleLowerCase();
		this.tagQueryStart = cursor - match[1].length;
		this.tagSuggestions = this.availableTags
			.filter((tag) => tag.slice(1).toLocaleLowerCase().includes(query))
			.sort((left, right) => {
				const leftStarts = left.slice(1).toLocaleLowerCase().startsWith(query);
				const rightStarts = right.slice(1).toLocaleLowerCase().startsWith(query);
				return Number(rightStarts) - Number(leftStarts);
			})
			.slice(0, 10);
		this.selectedTagIndex = 0;
		this.renderTagSuggestions();
	}

	private renderTagSuggestions(): void {
		const container = this.tagSuggestEl;
		if (!container || this.tagSuggestions.length === 0) {
			this.hideTagSuggestions();
			return;
		}

		container.empty();
		container.removeClass('is-hidden');
		this.tagSuggestions.forEach((tag, index) => {
			const button = container.createEl('button', {
				cls: `vault-timeline__tag-suggestion${
					index === this.selectedTagIndex ? ' is-selected' : ''
				}`,
				text: tag,
				attr: { role: 'option' },
			});
			button.addEventListener('mousedown', (event) => {
				event.preventDefault();
				this.insertTag(tag);
			});
		});
	}

	private handleTagSuggestionKeydown(event: KeyboardEvent): boolean {
		if (this.tagSuggestEl?.hasClass('is-hidden') || !this.tagSuggestions.length) {
			return false;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const direction = event.key === 'ArrowDown' ? 1 : -1;
			this.selectedTagIndex =
				(this.selectedTagIndex + direction + this.tagSuggestions.length) %
				this.tagSuggestions.length;
			this.renderTagSuggestions();
			return true;
		}
		if (
			event.key === 'Enter' &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey
		) {
			event.preventDefault();
			const tag = this.tagSuggestions[this.selectedTagIndex];
			if (tag) this.insertTag(tag);
			return true;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			this.hideTagSuggestions();
			return true;
		}
		return false;
	}

	private insertTag(tag: string): void {
		const input = this.composerInputEl;
		if (!input || this.tagQueryStart < 0) return;

		const cursor = input.selectionStart;
		input.setRangeText(`${tag} `, this.tagQueryStart, cursor, 'end');
		this.hideTagSuggestions();
		input.focus();
	}

	private hideTagSuggestions(): void {
		this.tagSuggestEl?.addClass('is-hidden');
		this.tagSuggestions = [];
		this.tagQueryStart = -1;
	}

	private async createTimelineNote(): Promise<void> {
		const input = this.composerInputEl;
		const content = input?.value.trim();
		if (!input || !content) {
			new Notice('请先输入笔记内容。');
			input?.focus();
			return;
		}

		try {
			await this.ensureTimelineFolder();
			const path = this.getAvailableTimelinePath(new Date());
			await this.app.vault.create(path, `${content}\n`);
			input.value = '';
			this.closeComposer();
			new Notice(`已创建：${path}`);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : '未知错误';
			new Notice(`创建失败：${message}`);
		}
	}

	private async ensureTimelineFolder(): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(
			TIMELINE_NOTE_FOLDER,
		);
		if (existing instanceof TFolder) {
			return;
		}
		if (existing) {
			throw new Error(
				`${TIMELINE_NOTE_FOLDER} 已存在，但它不是文件夹。`,
			);
		}
		await this.app.vault.createFolder(TIMELINE_NOTE_FOLDER);
	}

	private getAvailableTimelinePath(date: Date): string {
		const baseName = formatFilenameDate(date);
		let suffix = 1;
		let path = normalizePath(
			`${TIMELINE_NOTE_FOLDER}/${baseName}.md`,
		);
		while (this.app.vault.getAbstractFileByPath(path)) {
			suffix += 1;
			path = normalizePath(
				`${TIMELINE_NOTE_FOLDER}/${baseName} (${suffix}).md`,
			);
		}
		return path;
	}

	private createDateInput(
		parent: HTMLElement,
		label: string,
		onChange: (value: string) => void,
	): HTMLInputElement {
		const input = parent.createEl('input', {
			attr: {
				type: 'date',
				'aria-label': label,
				title: label,
			},
		});
		input.addEventListener('change', () => onChange(input.value));
		return input;
	}

	private async refresh(): Promise<void> {
		const sortBy = this.plugin.settings.sortBy;
		this.sortedFiles = this.app.vault
			.getMarkdownFiles()
			.sort(
				(left, right) =>
					timestampFor(right.stat, sortBy) -
						timestampFor(left.stat, sortBy) ||
					left.path.localeCompare(right.path),
			);

		await this.applyFilters();
	}

	private async applyFilters(): Promise<void> {
		if (!this.listEl || !this.loadMoreEl) {
			return;
		}

		const generation = ++this.renderGeneration;
		const startTimestamp = this.startDate
			? new Date(`${this.startDate}T00:00:00`).getTime()
			: Number.NEGATIVE_INFINITY;
		const endTimestamp = this.endDate
			? new Date(`${this.endDate}T23:59:59.999`).getTime()
			: Number.POSITIVE_INFINITY;
		const sortBy = this.plugin.settings.sortBy;
		let candidates = this.sortedFiles.filter((file) => {
			const timestamp = timestampFor(file.stat, sortBy);
			return timestamp >= startTimestamp && timestamp <= endTimestamp;
		});

		if (this.searchQuery) {
			this.summaryEl?.setText(`正在搜索 ${candidates.length} 篇 Markdown…`);
			candidates = await this.filterByKeyword(
				candidates,
				this.searchQuery,
				generation,
			);
			if (generation !== this.renderGeneration) {
				return;
			}
		}

		this.filteredFiles = candidates;
		this.renderedCount = 0;
		this.clearRenderComponents();
		this.listEl.empty();

		if (this.summaryEl) {
			const filterLabel =
				candidates.length === this.sortedFiles.length
					? `${candidates.length} 篇 Markdown`
					: `${candidates.length} / ${this.sortedFiles.length} 篇 Markdown`;
			this.summaryEl.setText(
				`${filterLabel} · ${
					sortBy === 'created' ? '按创建时间' : '按更新时间'
				}`,
			);
		}

		if (candidates.length === 0) {
			this.listEl.createDiv({
				cls: 'vault-timeline__empty',
				text:
					this.sortedFiles.length === 0
						? 'Vault 中还没有 Markdown 文件。'
						: '没有符合当前筛选条件的笔记。',
			});
		}

		await this.renderNextBatch(generation);
	}

	private async renderNextBatch(
		expectedGeneration = this.renderGeneration,
	): Promise<void> {
		if (
			!this.listEl ||
			!this.loadMoreEl ||
			expectedGeneration !== this.renderGeneration ||
			this.loadingGenerations.has(expectedGeneration)
		) {
			return;
		}

		this.loadingGenerations.add(expectedGeneration);
		const nextFiles = this.filteredFiles.slice(
			this.renderedCount,
			this.renderedCount + INITIAL_BATCH_SIZE,
		);
		this.renderedCount += nextFiles.length;
		try {
			for (const file of nextFiles) {
				if (expectedGeneration !== this.renderGeneration) {
					return;
				}
				await this.renderFile(file, this.listEl, expectedGeneration);
			}
		} finally {
			this.loadingGenerations.delete(expectedGeneration);
		}

		if (expectedGeneration !== this.renderGeneration) {
			return;
		}
		const remaining = this.filteredFiles.length - this.renderedCount;
		this.loadMoreEl.toggle(remaining > 0);
		this.loadMoreEl.setText(
			remaining > 0 ? `继续加载（还剩 ${remaining} 篇）` : '已加载全部',
		);
	}

	private async filterByKeyword(
		files: TFile[],
		query: string,
		generation: number,
	): Promise<TFile[]> {
		const matches: TFile[] = [];
		for (let index = 0; index < files.length; index += 20) {
			if (generation !== this.renderGeneration) {
				return [];
			}
			const batch = files.slice(index, index + 20);
			const results = await Promise.all(
				batch.map(async (file) => {
					const identity = `${file.basename}\n${file.path}`.toLocaleLowerCase();
					if (identity.includes(query)) {
						return true;
					}
					const readMtime = file.stat.mtime;
					const cached = this.contentIndex.get(file.path);
					if (cached?.mtime === readMtime) {
						return cached.searchableContent.includes(query);
					}

					const searchableContent = (
						await this.app.vault.cachedRead(file)
					).toLocaleLowerCase();
					if (
						generation !== this.renderGeneration ||
						file.stat.mtime !== readMtime
					) {
						return false;
					}
					this.contentIndex.set(file.path, {
						mtime: readMtime,
						searchableContent,
					});
					return searchableContent.includes(query);
				}),
			);
			if (generation !== this.renderGeneration) {
				return [];
			}
			results.forEach((matched, resultIndex) => {
				const file = batch[resultIndex];
				if (matched && file) matches.push(file);
			});
		}
		return matches;
	}

	private async renderFile(
		file: TFile,
		parent: HTMLElement,
		generation: number,
	): Promise<void> {
		const rawContent = await this.app.vault.cachedRead(file);
		if (generation !== this.renderGeneration) {
			return;
		}

		const card = parent.createEl('article', { cls: 'vault-timeline__item' });
		card.createDiv({ cls: 'vault-timeline__dot' });

		const content = card.createDiv({ cls: 'vault-timeline__card' });
		const top = content.createDiv({ cls: 'vault-timeline__card-header' });
		const titleWrap = top.createDiv({ cls: 'vault-timeline__title-wrap' });
		const title = titleWrap.createEl('button', {
			cls: 'vault-timeline__title',
			text: file.basename,
			attr: { title: `打开 ${file.path}` },
		});
		title.addEventListener('click', () => {
			void this.openFile(file);
		});

		const activeTimestamp = timestampFor(file.stat, this.plugin.settings.sortBy);
		const time = titleWrap.createEl('time', {
			cls: 'vault-timeline__time',
			text: formatDateTime(activeTimestamp),
		});
		time.dateTime = new Date(activeTimestamp).toISOString();
		time.title = `创建：${formatDateTime(file.stat.ctime)}\n更新：${formatDateTime(
			file.stat.mtime,
		)}`;

		const actions = top.createDiv({ cls: 'vault-timeline__actions' });
		const copyButton = actions.createEl('button', {
			cls: 'vault-timeline__action',
			text: '复制',
			attr: { 'aria-label': `复制 ${file.basename} 的正文` },
		});
		const openButton = actions.createEl('button', {
			cls: 'vault-timeline__action',
			text: '打开原文',
			attr: { 'aria-label': `打开原文 ${file.basename}` },
		});

		const excerpt = createExcerpt(rawContent, PREVIEW_CHARACTER_LIMIT);
		const preview = content.createDiv({ cls: 'vault-timeline__preview' });
		const component = new Component();
		this.addChild(component);
		this.renderComponents.push(component);
		await MarkdownRenderer.render(
			this.app,
			excerpt.content || '*空笔记*',
			preview,
			file.path,
			component,
		);

		copyButton.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(rawContent);
				new Notice(`已复制：${file.basename}`);
			} catch {
				new Notice('复制失败，请检查剪贴板权限。');
			}
		});
		openButton.addEventListener('click', () => {
			void this.openFile(file);
		});

		const footer = content.createDiv({ cls: 'vault-timeline__footer' });
		const pathButton = footer.createEl('button', {
			cls: 'vault-timeline__path',
			text: getParentFolder(file.path),
			attr: {
				title: `${file.path}\n点击打开原文`,
				'aria-label': `打开 ${file.path}`,
			},
		});
		pathButton.addEventListener('click', () => {
			void this.openFile(file);
		});

		if (excerpt.truncated) {
			footer.createSpan({
				cls: 'vault-timeline__truncated',
				text: `正文较长，已展示前 ${PREVIEW_CHARACTER_LIMIT} 字`,
			});
		}
	}

	private async openFile(file: TFile): Promise<void> {
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	private clearRenderComponents(): void {
		for (const component of this.renderComponents) {
			this.removeChild(component);
		}
		this.renderComponents = [];
	}
}

function formatDateTime(timestamp: number): string {
	return new Intl.DateTimeFormat('zh-CN', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(new Date(timestamp));
}

function getParentFolder(path: string): string {
	const separatorIndex = path.lastIndexOf('/');
	return separatorIndex === -1 ? 'Vault 根目录' : path.slice(0, separatorIndex);
}

function formatFilenameDate(date: Date): string {
	const parts = new Intl.DateTimeFormat('sv-SE', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	})
		.formatToParts(date)
		.reduce<Record<string, string>>((result, part) => {
			if (part.type !== 'literal') result[part.type] = part.value;
			return result;
		}, {});
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}-${parts.minute}-${parts.second}`;
}

export async function openTimelineView(app: App): Promise<void> {
	let leaf = app.workspace.getLeavesOfType(VIEW_TYPE_TIMELINE)[0];
	if (!leaf) {
		leaf = app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_TIMELINE,
			active: true,
		});
	}
	await app.workspace.revealLeaf(leaf);
}
