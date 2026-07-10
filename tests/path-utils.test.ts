import { sanitizeFileName, sanitizePath, parentFolders } from '../src/path-utils';

describe('sanitizeFileName', () => {
	it('replaces characters that are illegal in Obsidian/OS file names', () => {
		expect(sanitizeFileName('a\\b:c*d?e"f<g>h|i#j^k[l]m')).toBe(
			'a-b-c-d-e-f-g-h-i-j-k-l-m'
		);
	});

	it('replaces slashes — AI labels never mean folders', () => {
		expect(sanitizeFileName('Ideas/Project X')).toBe('Ideas-Project X');
	});

	it('collapses whitespace runs', () => {
		expect(sanitizeFileName('a   b\t c')).toBe('a b c');
	});

	it('trims leading/trailing dots and spaces', () => {
		expect(sanitizeFileName('  .hidden note. ')).toBe('hidden note');
	});

	it('caps length at 200 characters', () => {
		expect(sanitizeFileName('x'.repeat(300))).toHaveLength(200);
	});

	it('falls back when nothing survives', () => {
		expect(sanitizeFileName('  . ')).toBe('Epiphany note');
		expect(sanitizeFileName('')).toBe('Epiphany note');
	});

	it('keeps replacement dashes rather than failing on separator-only input', () => {
		expect(sanitizeFileName('///')).toBe('---');
	});
});

describe('sanitizePath', () => {
	it('preserves separators and sanitizes each segment', () => {
		expect(sanitizePath('Projects/My: Notes')).toBe('Projects/My- Notes');
	});

	it('drops empty segments from doubled or edge slashes', () => {
		expect(sanitizePath('/a//b/')).toBe('a/b');
	});
});

describe('parentFolders', () => {
	it('returns the cumulative chain of parents', () => {
		expect(parentFolders('a/b/c.md')).toEqual(['a', 'a/b']);
	});

	it('returns empty for root-level files', () => {
		expect(parentFolders('note.md')).toEqual([]);
	});
});
