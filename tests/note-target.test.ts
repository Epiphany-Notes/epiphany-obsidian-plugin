import { ObsidianTypeKey, resolveTargetPath, TargetInput } from '../src/note-target';

const base = (over: Partial<TargetInput> = {}): TargetInput => ({
	typeKey: ObsidianTypeKey.NEW,
	label: 'My Note',
	syncId: 'sync-1',
	fileName: undefined,
	dailyFileName: '2026-07-09',
	dailyFolder: '',
	markdownFiles: [],
	fileExists: () => false,
	...over,
});

describe('daily-append', () => {
	it('joins the daily folder and preformatted date', () => {
		expect(
			resolveTargetPath(base({ typeKey: ObsidianTypeKey.DAILY_APPEND, dailyFolder: 'Journal' }))
		).toBe('Journal/2026-07-09.md');
	});

	it('handles no daily folder', () => {
		expect(resolveTargetPath(base({ typeKey: ObsidianTypeKey.DAILY_APPEND }))).toBe(
			'2026-07-09.md'
		);
	});

	it('tolerates a trailing slash on the configured folder', () => {
		expect(
			resolveTargetPath(base({ typeKey: ObsidianTypeKey.DAILY_APPEND, dailyFolder: 'Journal/' }))
		).toBe('Journal/2026-07-09.md');
	});
});

describe('existing', () => {
	it('finds a note by basename anywhere in the vault', () => {
		const files = [{ path: 'Folder/Notes.md', basename: 'Notes' }];
		expect(
			resolveTargetPath(
				base({ typeKey: ObsidianTypeKey.EXISTING, fileName: 'Notes', markdownFiles: files })
			)
		).toBe('Folder/Notes.md');
	});

	it('prefers root-level matches, then lexicographic path order (deterministic across devices)', () => {
		const files = [
			{ path: 'Zed/Notes.md', basename: 'Notes' },
			{ path: 'Alpha/Notes.md', basename: 'Notes' },
			{ path: 'Notes.md', basename: 'Notes' },
		];
		expect(
			resolveTargetPath(
				base({ typeKey: ObsidianTypeKey.EXISTING, fileName: 'Notes', markdownFiles: files })
			)
		).toBe('Notes.md');

		expect(
			resolveTargetPath(
				base({
					typeKey: ObsidianTypeKey.EXISTING,
					fileName: 'Notes',
					markdownFiles: files.slice(0, 2),
				})
			)
		).toBe('Alpha/Notes.md');
	});

	it('strips a user-typed .md extension', () => {
		expect(resolveTargetPath(base({ typeKey: ObsidianTypeKey.EXISTING, fileName: 'Notes.md' }))).toBe(
			'Notes.md'
		);
	});

	it('treats fileName containing / as an exact path and skips the search', () => {
		const files = [{ path: 'Elsewhere/Notes.md', basename: 'Notes' }];
		expect(
			resolveTargetPath(
				base({
					typeKey: ObsidianTypeKey.EXISTING,
					fileName: 'Projects/Notes',
					markdownFiles: files,
				})
			)
		).toBe('Projects/Notes.md');
	});

	it('defaults to "Epiphany notes" when fileName is empty', () => {
		expect(resolveTargetPath(base({ typeKey: ObsidianTypeKey.EXISTING, fileName: '' }))).toBe(
			'Epiphany notes.md'
		);
	});
});

describe('new', () => {
	it('uses the sanitized label', () => {
		expect(resolveTargetPath(base({ label: 'Ideas: Project/X' }))).toBe('Ideas- Project-X.md');
	});

	it('suffixes syncId on collision', () => {
		expect(resolveTargetPath(base({ fileExists: (p) => p === 'My Note.md' }))).toBe(
			'My Note - sync-1.md'
		);
	});

	it('falls back when the label is missing', () => {
		expect(resolveTargetPath(base({ label: undefined }))).toBe('Epiphany note.md');
	});
});

describe('unknown type', () => {
	it('throws', () => {
		expect(() => resolveTargetPath(base({ typeKey: 'nonsense' }))).toThrow(
			"Unknown type key: 'nonsense'"
		);
	});
});
