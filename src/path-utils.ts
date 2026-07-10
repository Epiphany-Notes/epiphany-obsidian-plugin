// Characters Obsidian and/or host filesystems reject in file & folder names,
// plus Obsidian link-breaking characters (# ^ [ ] |).
const ILLEGAL_NAME_CHARS = /[\\:*?"<>|#^[\]]/g;

const FALLBACK_NAME = 'Epiphany note';

export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/\//g, '-')
		.replace(ILLEGAL_NAME_CHARS, '-')
		.replace(/\s+/g, ' ')
		.replace(/^[. ]+|[. ]+$/g, '')
		.slice(0, 200)
		.trim();
	return cleaned.length ? cleaned : FALLBACK_NAME;
}

export function sanitizePath(path: string): string {
	return path
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0)
		.map((segment) => sanitizeFileName(segment))
		.join('/');
}

export function parentFolders(filePath: string): string[] {
	const segments = filePath.split('/').slice(0, -1);
	return segments.map((_, i) => segments.slice(0, i + 1).join('/'));
}
