import assert from 'node:assert/strict';
import test from 'node:test';
import { getTimelinePreviewKind } from '../src/excalidraw-preview.ts';

const EXCALIDRAW_DOCUMENT = `---
title: 信息源流程图
excalidraw-plugin: parsed
---

==⚠ Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Drawing
\`\`\`compressed-json
fixture
\`\`\`
`;

test('routes an Excalidraw Markdown document away from MarkdownRenderer', () => {
	assert.equal(
		getTimelinePreviewKind(
			'00-Inbox/信息源流程图.excalidraw.md',
			EXCALIDRAW_DOCUMENT,
		),
		'excalidraw',
	);
});

test('keeps an ordinary Markdown document on the Markdown renderer', () => {
	assert.equal(
		getTimelinePreviewKind('Notes/example.md', '# Excalidraw Data structures'),
		'markdown',
	);
});
