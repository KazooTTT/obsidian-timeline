import type { TFile } from 'obsidian';

export type TimelinePreviewKind = 'markdown' | 'excalidraw';

export function getTimelinePreviewKind(
	path: string,
	rawContent: string,
): TimelinePreviewKind {
	const normalizedPath = path.toLocaleLowerCase();
	if (
		normalizedPath.endsWith('.excalidraw.md') ||
		normalizedPath.endsWith('.excalidraw')
	) {
		return 'excalidraw';
	}

	const frontmatter = rawContent.match(
		/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
	)?.[1];
	return frontmatter && /(?:^|\r?\n)\s*excalidraw-plugin\s*:/i.test(frontmatter)
		? 'excalidraw'
		: 'markdown';
}

interface ExcalidrawAutomateApi {
	createSVG(templatePath?: string): Promise<SVGSVGElement>;
	destroy(): void;
}

interface ExcalidrawAutomateGlobal {
	getAPI(view?: unknown): ExcalidrawAutomateApi | null;
}

interface WindowWithExcalidraw extends Window {
	ExcalidrawAutomate?: ExcalidrawAutomateGlobal;
}

export async function createExcalidrawPreviewSvg(
	file: TFile,
): Promise<SVGSVGElement | null> {
	const automate = (window as WindowWithExcalidraw).ExcalidrawAutomate;
	if (!automate?.getAPI) {
		return null;
	}

	let api: ExcalidrawAutomateApi | null = null;
	try {
		api = automate.getAPI();
		if (!api) {
			return null;
		}
		const svg = await api.createSVG(file.path);
		return svg?.tagName.toLocaleLowerCase() === 'svg' ? svg : null;
	} catch (error) {
		console.warn(
			`Vault Timeline could not render Excalidraw preview: ${file.path}`,
			error,
		);
		return null;
	} finally {
		api?.destroy();
	}
}
