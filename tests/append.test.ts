import { buildAppendedContent } from '../src/append';

describe('buildAppendedContent', () => {
	it('appends with a blank-line separator', () => {
		expect(buildAppendedContent('existing', 'new note')).toBe('existing\n\nnew note');
	});

	it('appends without separator to an empty file', () => {
		expect(buildAppendedContent('', 'new note')).toBe('new note');
	});

	it('returns current unchanged when the note already exists at the END', () => {
		const current = 'a\n\nnew note';
		expect(buildAppendedContent(current, 'new note')).toBe(current);
	});

	it('returns current unchanged when the note exists in the MIDDLE (redelivery after later appends)', () => {
		const current = 'a\n\nnew note\n\nb';
		expect(buildAppendedContent(current, 'new note')).toBe(current);
	});

	it('ignores surrounding whitespace when matching duplicates', () => {
		const current = 'a\n\nnew note';
		expect(buildAppendedContent(current, '  new note  ')).toBe(current);
	});

	it('returns current unchanged for empty note text', () => {
		expect(buildAppendedContent('a', '   ')).toBe('a');
	});
});
