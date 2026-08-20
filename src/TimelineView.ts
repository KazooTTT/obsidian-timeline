import {
	Component,
	ItemView,
	MarkdownRenderer,
	Notice,
	Scope,
	TFile,
	TFolder,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
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
import { ObsidianMarkdownComposer } from './ObsidianMarkdownComposer';
import {
	createExcalidrawPreviewSvg,
	getTimelinePreviewKind,
} from './excalidraw-preview';
import {
	createExcerpt,
	timestampFor,
	type TimelineSort,
} from './timeline-utils';

const EXCALIDRAW_PREVIEW_CACHE_LIMIT = 20;

export class TimelineView extends ItemView {
	private listEl: HTMLElement | null = null;
	private summaryEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	private composerEl: HTMLElement | null = null;
	private composer: ObsidianMarkdownComposer | null = null;
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
	private excalidrawPreviewCache = new Map<
		string,
		{ mtime: number; svg: SVGSVGElement }
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
			},
			{ capture: true },
		);

		const scheduleRefresh = (file?: TFile): void => {
			if (file) {
				this.contentIndex.delete(file.path);
				this.excalidrawPreviewCache.delete(file.path);
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
				this.excalidrawPreviewCache.delete(oldPath);
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

		const createButton = controls.createEl('button', {
			cls: 'vault-timeline__create',
			text: '＋ 新建',
			attr: { 'aria-label': '创建新时间线条目并在旁边打开' },
		});
		createButton.addEventListener('click', () => {
			void this.createEmptyTimelineNote();
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
			text: `Obsidian Live Preview · 保存到 ${TIMELINE_NOTE_FOLDER}/ · 文件名自动使用当前时间`,
		});
		const editorHost = this.composerEl.createDiv({
			cls: 'vault-timeline__composer-editor',
			attr: { 'aria-label': '新笔记内容' },
		});
		this.composer = new ObsidianMarkdownComposer(this.app, editorHost, {
			placeholder: '现在在想什么？支持 Markdown、[[链接]] 和 #标签…',
			contextFile: this.getComposerContextFile(),
			contextPath: normalizePath(`${TIMELINE_NOTE_FOLDER}/未命名.md`),
			onEscape: () => this.closeComposer(),
			onSubmit: () => {
				void this.createTimelineNote();
			},
		});
		this.addChild(this.composer);

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
	}

	private getComposerContextFile(): TFile | null {
		return (
			this.app.vault
				.getMarkdownFiles()
				.find((file) => file.path.startsWith(`${TIMELINE_NOTE_FOLDER}/`)) ??
			this.app.workspace.getActiveFile()
		);
	}

	private closeComposer(): void {
		this.composer?.setValue('');
	}

	private async createTimelineNote(): Promise<void> {
		const content = this.composer?.getValue().trim();
		if (!this.composer || !content) {
			new Notice('请先输入笔记内容。');
			this.composer?.focus();
			return;
		}

		try {
			await this.ensureTimelineFolder();
			const path = this.getAvailableTimelinePath(new Date());
			await this.app.vault.create(path, `${content}\n`);
			this.closeComposer();
			new Notice(`已创建：${path}`);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : '未知错误';
			new Notice(`创建失败：${message}`);
		}
	}

	private async createEmptyTimelineNote(): Promise<void> {
		try {
			await this.ensureTimelineFolder();
			const path = this.getAvailableTimelinePath(new Date());
			const file = await this.app.vault.create(path, '');
			await this.openFile(file, 'split');
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

		const path = titleWrap.createEl('button', {
			cls: 'vault-timeline__path',
			text: getParentFolder(file.path),
			attr: {
				title: `${file.path}\n点击打开原文`,
				'aria-label': `打开 ${file.path}`,
			},
		});
		path.addEventListener('click', () => {
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
		preview.addEventListener('dblclick', () => {
			void this.openFile(file);
		});
		const previewKind = getTimelinePreviewKind(file.path, rawContent);
		if (previewKind === 'excalidraw') {
			this.renderExcalidrawPreview(file, preview, generation);
		} else {
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
		}

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

		if (excerpt.truncated && previewKind === 'markdown') {
			const footer = content.createDiv({ cls: 'vault-timeline__footer' });
			footer.createSpan({
				cls: 'vault-timeline__truncated',
				text: `正文较长，已展示前 ${PREVIEW_CHARACTER_LIMIT} 字`,
			});
		}
	}

	private renderExcalidrawPreview(
		file: TFile,
		preview: HTMLElement,
		generation: number,
	): void {
		preview.addClass('is-excalidraw');
		const cached = this.excalidrawPreviewCache.get(file.path);
		if (cached?.mtime === file.stat.mtime) {
			this.appendExcalidrawSvg(
				file,
				preview,
				cached.svg.cloneNode(true) as SVGSVGElement,
			);
			return;
		}

		this.renderExcalidrawStatus(preview, true);
		void this.loadExcalidrawPreview(file, preview, generation);
	}

	private async loadExcalidrawPreview(
		file: TFile,
		preview: HTMLElement,
		generation: number,
	): Promise<void> {
		const requestedMtime = file.stat.mtime;
		const svg = await createExcalidrawPreviewSvg(file);
		if (
			generation !== this.renderGeneration ||
			!preview.isConnected ||
			file.stat.mtime !== requestedMtime
		) {
			return;
		}

		preview.empty();
		if (svg) {
			this.cacheExcalidrawPreview(file.path, requestedMtime, svg);
			this.appendExcalidrawSvg(file, preview, svg);
			return;
		}
		this.renderExcalidrawStatus(preview, false);
	}

	private cacheExcalidrawPreview(
		path: string,
		mtime: number,
		svg: SVGSVGElement,
	): void {
		this.excalidrawPreviewCache.delete(path);
		this.excalidrawPreviewCache.set(path, {
			mtime,
			svg: svg.cloneNode(true) as SVGSVGElement,
		});
		while (
			this.excalidrawPreviewCache.size > EXCALIDRAW_PREVIEW_CACHE_LIMIT
		) {
			const oldestPath = this.excalidrawPreviewCache.keys().next().value;
			if (!oldestPath) break;
			this.excalidrawPreviewCache.delete(oldestPath);
		}
	}

	private appendExcalidrawSvg(
		file: TFile,
		preview: HTMLElement,
		svg: SVGSVGElement,
	): void {
		svg.addClass('vault-timeline__excalidraw-svg');
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', `${file.basename} 绘图预览`);
		preview.appendChild(svg);
	}

	private renderExcalidrawStatus(
		preview: HTMLElement,
		loading: boolean,
	): void {
		const fallback = preview.createDiv({
			cls: `vault-timeline__excalidraw-fallback${
				loading ? ' is-loading' : ''
			}`,
		});
		const icon = fallback.createDiv({
			cls: 'vault-timeline__excalidraw-icon',
		});
		setIcon(icon, 'pencil');
		const copy = fallback.createDiv();
		copy.createDiv({
			cls: 'vault-timeline__excalidraw-label',
			text: loading ? '正在生成 Excalidraw 预览…' : 'Excalidraw 绘图',
		});
		copy.createDiv({
			cls: 'vault-timeline__excalidraw-description',
			text: loading
				? '时间线其他内容可以继续加载。'
				: '当前无法生成画布预览，请打开原文查看。',
		});
	}

	private async openFile(
		file: TFile,
		location: 'tab' | 'split' | false = false,
	): Promise<void> {
		const leaf = this.app.workspace.getLeaf(location);
		await leaf.openFile(file, {
			active: true,
			state: {
				mode: 'source',
			},
		});
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
