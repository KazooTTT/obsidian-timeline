/*!
 * Embedded editor construction adapted from work by Matthew Meyers and Fevol:
 * https://gist.github.com/Fevol/caa478ce303e69eabede7b12b2323838
 * @license MIT
 *
 * Copyright 2024 Matthew Meyers, Fevol
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {
	Component,
	Scope,
	getAllTags,
	type App,
	type Editor,
	type MarkdownFileInfo,
	type TFile,
} from 'obsidian';
import { Prec, type Extension } from '@codemirror/state';
import {
	EditorView,
	keymap,
	placeholder,
	type ViewUpdate,
} from '@codemirror/view';

interface ComposerOptions {
	placeholder: string;
	contextFile: TFile | null;
	contextPath: string;
	onEscape: () => void;
	onSubmit: () => void;
}

interface EditorWithCodeMirror extends Editor {
	cm: EditorView;
}

interface EmbeddedEditorOwner extends MarkdownFileInfo {
	containerEl: HTMLElement;
	editMode?: InternalMarkdownEditor;
	getMode: () => 'source';
	getViewType: () => 'markdown';
	onMarkdownScroll: () => void;
	path: string;
}

interface InternalMarkdownEditor extends Component {
	app: App;
	activeCM: EditorView;
	editor: EditorWithCodeMirror;
	editorEl: HTMLElement;
	owner: EmbeddedEditorOwner;
	buildLocalExtensions(): Extension[];
	destroy(): void;
	onUpdate(update: ViewUpdate, changed: boolean): void;
	set(value: string): void;
}

type InternalMarkdownEditorConstructor = new (
	app: App,
	containerEl: HTMLElement,
	owner: EmbeddedEditorOwner,
) => InternalMarkdownEditor;

interface InternalWidgetEditorView {
	editable: boolean;
	editMode?: object;
	showEditor(): void;
	unload(): void;
}

interface AppWithEmbedRegistry extends App {
	embedRegistry: {
		embedByExtension: {
			md: (
				context: { app: App; containerEl: HTMLElement },
				file: TFile | null,
				subpath: string,
			) => InternalWidgetEditorView;
		};
	};
}

/**
 * A small adapter around Obsidian's own embedded Live Preview editor.
 *
 * Obsidian does not expose a public constructor for this editor, so we resolve
 * the implementation from its built-in Markdown embed. If that internal seam
 * changes, the composer falls back to a textarea instead of breaking the view.
 */
export class ObsidianMarkdownComposer extends Component {
	private nativeEditor: InternalMarkdownEditor | null = null;
	private fallbackInput: HTMLTextAreaElement | null = null;
	private fallbackSuggestEl: HTMLElement | null = null;
	private fallbackSuggestions: string[] = [];
	private fallbackTagStart = -1;
	private selectedFallbackTag = 0;
	private availableTags: string[] = [];

	constructor(
		private appRef: App,
		containerEl: HTMLElement,
		private options: ComposerOptions,
	) {
		super();
		const nativeHost = document.createElement('div');
		nativeHost.addClass('vault-timeline__composer-native-host');

		try {
			this.nativeEditor = this.createNativeEditor(nativeHost);
			containerEl.appendChild(nativeHost);
			this.addChild(this.nativeEditor);
			containerEl.addClass('is-native');
		} catch (error) {
			nativeHost.remove();
			containerEl.empty();
			console.warn(
				'Vault Timeline could not initialize the Obsidian Markdown editor.',
				error,
			);
			containerEl.addClass('is-fallback');
			this.fallbackInput = containerEl.createEl('textarea', {
				cls: 'vault-timeline__composer-fallback',
				attr: {
					placeholder: options.placeholder,
					'aria-label': '新笔记内容',
				},
			});
			this.fallbackSuggestEl = containerEl.createDiv({
				cls: 'vault-timeline__fallback-suggestions is-hidden',
				attr: { role: 'listbox', 'aria-label': '标签建议' },
			});
			this.availableTags = this.collectVaultTags();
			this.registerDomEvent(this.fallbackInput, 'input', () => {
				this.updateFallbackTagSuggestions();
			});
			this.registerDomEvent(this.fallbackInput, 'focus', () => {
				this.availableTags = this.collectVaultTags();
			});
			this.registerDomEvent(this.fallbackInput, 'blur', () => {
				window.setTimeout(() => {
					if (!containerEl.contains(document.activeElement)) {
						this.hideFallbackTagSuggestions();
					}
				}, 0);
			});
			this.registerDomEvent(this.fallbackInput, 'keydown', (event) => {
				if (this.handleFallbackTagKeydown(event)) {
					return;
				}
				if (
					event.key === 'Enter' &&
					(event.metaKey || event.ctrlKey)
				) {
					event.preventDefault();
					this.options.onSubmit();
				} else if (event.key === 'Escape') {
					event.preventDefault();
					this.options.onEscape();
				}
			});
		}
	}

	getValue(): string {
		return (
			this.nativeEditor?.editor.cm.state.doc.toString() ??
			this.fallbackInput?.value ??
			''
		);
	}

	setValue(value: string): void {
		if (this.nativeEditor) {
			this.nativeEditor.set(value);
		} else if (this.fallbackInput) {
			this.fallbackInput.value = value;
			this.hideFallbackTagSuggestions();
		}
	}

	focus(): void {
		if (this.nativeEditor) {
			this.nativeEditor.editor.focus();
		} else {
			this.fallbackInput?.focus();
		}
	}

	hasFocus(): boolean {
		return (
			this.nativeEditor?.activeCM.hasFocus ??
			document.activeElement === this.fallbackInput
		);
	}

	private createNativeEditor(containerEl: HTMLElement): InternalMarkdownEditor {
		const BaseEditor = resolveMarkdownEditor(
			this.appRef,
			this.options.contextFile,
		);
		const options = this.options;

		class TimelineComposerEditor extends BaseEditor {
			private composerScope: Scope | null = null;
			private previousActiveEditor: MarkdownFileInfo | null = null;
			private ownsActiveEditor = false;

			constructor(app: App, container: HTMLElement) {
				const owner: EmbeddedEditorOwner = {
					app,
					containerEl: container,
					hoverPopover: null,
					file: options.contextFile,
					getMode: () => 'source',
					getViewType: () => 'markdown',
					onMarkdownScroll: () => undefined,
					path: options.contextPath,
				};
				super(app, container, owner);

				try {
					this.composerScope = new Scope(app.scope);
					this.composerScope.register(['Mod'], 'Enter', () => true);
					this.owner.editMode = this;
					this.owner.editor = this.editor;
					this.set('');

					this.registerDomEvent(
						this.editor.cm.contentDOM,
						'focusin',
						() => this.activateEditorContext(),
					);
					this.registerDomEvent(
						this.editor.cm.contentDOM,
						'focusout',
						() => this.deactivateEditorContext(),
					);
				} catch (error) {
					this.unload();
					throw error;
				}
			}

			buildLocalExtensions(): Extension[] {
				const extensions = super.buildLocalExtensions();
				extensions.push(placeholder(options.placeholder));
				extensions.push(
					Prec.highest(
						keymap.of([
							{
								key: 'Mod-Enter',
								run: () => {
									options.onSubmit();
									return true;
								},
							},
							{
								key: 'Escape',
								run: () => {
									options.onEscape();
									return true;
								},
							},
						]),
					),
				);
				return extensions;
			}

			onunload(): void {
				this.deactivateEditorContext();
				super.onunload();
			}

			private activateEditorContext(): void {
				if (this.ownsActiveEditor || !this.composerScope) {
					return;
				}
				this.previousActiveEditor = this.app.workspace.activeEditor;
				this.app.keymap.pushScope(this.composerScope);
				this.app.workspace.activeEditor = this.owner;
				this.ownsActiveEditor = true;
			}

			private deactivateEditorContext(): void {
				if (!this.ownsActiveEditor || !this.composerScope) {
					return;
				}
				this.app.keymap.popScope(this.composerScope);
				if (this.app.workspace.activeEditor === this.owner) {
					this.app.workspace.activeEditor = this.previousActiveEditor;
				}
				this.previousActiveEditor = null;
				this.ownsActiveEditor = false;
			}
		}

		return new TimelineComposerEditor(this.appRef, containerEl);
	}

	private collectVaultTags(): string[] {
		const tags = new Set<string>();
		for (const file of this.appRef.vault.getMarkdownFiles()) {
			const cache = this.appRef.metadataCache.getFileCache(file);
			for (const tag of cache ? getAllTags(cache) ?? [] : []) {
				tags.add(tag.startsWith('#') ? tag : `#${tag}`);
			}
		}
		return [...tags].sort((left, right) => left.localeCompare(right));
	}

	private updateFallbackTagSuggestions(): void {
		const input = this.fallbackInput;
		if (!input) return;

		const cursor = input.selectionStart;
		const match = input.value.slice(0, cursor).match(/(?:^|\s)(#[^\s#]*)$/);
		if (!match?.[1]) {
			this.hideFallbackTagSuggestions();
			return;
		}

		const query = match[1].slice(1).toLocaleLowerCase();
		this.fallbackTagStart = cursor - match[1].length;
		this.fallbackSuggestions = this.availableTags
			.filter((tag) => tag.slice(1).toLocaleLowerCase().includes(query))
			.sort((left, right) => {
				const leftStarts = left.slice(1).toLocaleLowerCase().startsWith(query);
				const rightStarts = right.slice(1).toLocaleLowerCase().startsWith(query);
				return Number(rightStarts) - Number(leftStarts);
			})
			.slice(0, 10);
		this.selectedFallbackTag = 0;
		this.renderFallbackTagSuggestions();
	}

	private renderFallbackTagSuggestions(): void {
		const container = this.fallbackSuggestEl;
		if (!container || this.fallbackSuggestions.length === 0) {
			this.hideFallbackTagSuggestions();
			return;
		}

		container.empty();
		container.removeClass('is-hidden');
		this.fallbackSuggestions.forEach((tag, index) => {
			const button = container.createEl('button', {
				cls: `vault-timeline__fallback-suggestion${
					index === this.selectedFallbackTag ? ' is-selected' : ''
				}`,
				text: tag,
				attr: { role: 'option' },
			});
			button.addEventListener('mousedown', (event) => {
				event.preventDefault();
				this.insertFallbackTag(tag);
			});
		});
	}

	private handleFallbackTagKeydown(event: KeyboardEvent): boolean {
		if (
			this.fallbackSuggestEl?.hasClass('is-hidden') ||
			this.fallbackSuggestions.length === 0
		) {
			return false;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const direction = event.key === 'ArrowDown' ? 1 : -1;
			this.selectedFallbackTag =
				(this.selectedFallbackTag +
					direction +
					this.fallbackSuggestions.length) %
				this.fallbackSuggestions.length;
			this.renderFallbackTagSuggestions();
			return true;
		}
		if (
			event.key === 'Enter' &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey
		) {
			event.preventDefault();
			const tag = this.fallbackSuggestions[this.selectedFallbackTag];
			if (tag) this.insertFallbackTag(tag);
			return true;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			this.hideFallbackTagSuggestions();
			return true;
		}
		return false;
	}

	private insertFallbackTag(tag: string): void {
		const input = this.fallbackInput;
		if (!input || this.fallbackTagStart < 0) return;
		input.setRangeText(
			`${tag} `,
			this.fallbackTagStart,
			input.selectionStart,
			'end',
		);
		this.hideFallbackTagSuggestions();
		input.focus();
	}

	private hideFallbackTagSuggestions(): void {
		this.fallbackSuggestEl?.addClass('is-hidden');
		this.fallbackSuggestions = [];
		this.fallbackTagStart = -1;
	}
}

function resolveMarkdownEditor(
	app: App,
	contextFile: TFile | null,
): InternalMarkdownEditorConstructor {
	const internalApp = app as AppWithEmbedRegistry;
	const factory = internalApp.embedRegistry?.embedByExtension?.md;
	if (!factory) {
		throw new Error('Obsidian Markdown embed factory is unavailable.');
	}

	const widget = factory(
		{ app, containerEl: document.createElement('div') },
		contextFile,
		'',
	);
	try {
		widget.editable = true;
		widget.showEditor();
		if (!widget.editMode) {
			throw new Error('Obsidian did not create an editable Markdown embed.');
		}

		const prototype = Object.getPrototypeOf(
			Object.getPrototypeOf(widget.editMode),
		);
		const constructor = prototype?.constructor as
			| InternalMarkdownEditorConstructor
			| undefined;
		if (!constructor) {
			throw new Error('Obsidian Markdown editor constructor is unavailable.');
		}
		return constructor;
	} finally {
		widget.unload();
	}
}
