export type TimelineSort = 'created' | 'modified';

export interface TimelineTimestamps {
	ctime: number;
	mtime: number;
}

export interface TimelineExcerpt {
	content: string;
	truncated: boolean;
}

export function timestampFor(
	item: TimelineTimestamps,
	sortBy: TimelineSort,
): number {
	return sortBy === 'created' ? item.ctime : item.mtime;
}

export function stripFrontmatter(content: string): string {
	const normalized = content.replace(/^\uFEFF/, '');
	if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
		return normalized.trim();
	}

	const end = normalized.match(/\r?\n---\r?\n/);
	if (!end || end.index === undefined) {
		return normalized.trim();
	}

	return normalized.slice(end.index + end[0].length).trim();
}

export function createExcerpt(
	content: string,
	limit: number,
): TimelineExcerpt {
	const body = stripFrontmatter(content);
	if (body.length <= limit) {
		return { content: body, truncated: false };
	}

	const candidate = body.slice(0, limit);
	const lastBreak = Math.max(
		candidate.lastIndexOf('\n'),
		candidate.lastIndexOf(' '),
	);
	const cutAt = lastBreak >= Math.floor(limit * 0.65) ? lastBreak : limit;
	let excerpt = candidate.slice(0, cutAt).trimEnd();

	const fenceCount = excerpt.match(/^```/gm)?.length ?? 0;
	if (fenceCount % 2 === 1) {
		excerpt += '\n```';
	}

	return { content: `${excerpt}\n\n…`, truncated: true };
}

