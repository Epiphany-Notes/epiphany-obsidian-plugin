import { sanitizeFileName, sanitizePath } from './path-utils';

export enum ObsidianTypeKey {
	DAILY_APPEND = 'daily-append',
	EXISTING = 'existing',
	NEW = 'new',
}

export type VaultFileRef = { path: string; basename: string };

export type TargetInput = {
	typeKey: string;
	label?: string;
	syncId: string;
	fileName?: string;
	// Destination-configured folder (NEW/EXISTING only; daily-append's
	// location is governed by the user's daily-notes plugin config).
	folderPath?: string;
	dailyFileName: string;
	dailyFolder: string;
	markdownFiles: VaultFileRef[];
	fileExists: (path: string) => boolean;
};

// Root-level notes first, then lexicographic — both devices of a two-device
// vault must resolve the SAME file or appends split across copies.
function compareByRootThenPath(a: VaultFileRef, b: VaultFileRef): number {
	const aRoot = !a.path.includes('/');
	const bRoot = !b.path.includes('/');
	if (aRoot !== bRoot) {
		return aRoot ? -1 : 1;
	}
	return a.path.localeCompare(b.path);
}

export function resolveTargetPath(input: TargetInput): string {
	switch (input.typeKey) {
		case ObsidianTypeKey.DAILY_APPEND: {
			// The folder comes from the user's daily-notes plugin config — do
			// not sanitize it, or we'd write next to (not into) their real
			// daily note.
			const folder = input.dailyFolder
				? input.dailyFolder.endsWith('/')
					? input.dailyFolder
					: input.dailyFolder + '/'
				: '';
			return folder + input.dailyFileName + '.md';
		}
		case ObsidianTypeKey.EXISTING: {
			const raw = (input.fileName ?? '').trim() || 'Epiphany notes';
			const stripped = raw.endsWith('.md') ? raw.slice(0, -3) : raw;
			const folder = (input.folderPath ?? '').trim();
			if (folder.length) {
				// Destination pins the folder — exact path, no basename
				// search. A slash-y fileName (legacy de-facto folder trick)
				// composes by joining underneath it.
				return sanitizePath(folder + '/' + stripped) + '.md';
			}
			if (stripped.includes('/')) {
				// Explicit path (users rely on this as a de-facto folder
				// feature) — no basename search.
				return sanitizePath(stripped) + '.md';
			}
			const target = sanitizeFileName(stripped);
			const matches = input.markdownFiles
				.filter((f) => f.basename === target)
				.sort(compareByRootThenPath);
			return matches.length ? matches[0].path : target + '.md';
		}
		case ObsidianTypeKey.NEW: {
			const baseName = sanitizeFileName(input.label ?? '');
			const folder = (input.folderPath ?? '').trim();
			const prefix = folder.length ? sanitizePath(folder) + '/' : '';
			const primary = prefix + baseName + '.md';
			return input.fileExists(primary)
				? `${prefix}${baseName} - ${input.syncId}.md`
				: primary;
		}
		default: {
			throw new Error(`Unknown type key: '${input.typeKey}'`);
		}
	}
}
