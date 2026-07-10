// Duplicate check runs against the *current* file content each time
// Vault.process invokes it — catches "API re-sent an upload whose sync
// confirmation failed" no matter where in the note the earlier copy sits.
export function buildAppendedContent(current: string, noteText: string): string {
	const trimmed = noteText.trim();
	if (!trimmed.length || current.includes(trimmed)) {
		return current;
	}
	const separator = current.length === 0 ? '' : '\n\n';
	return `${current}${separator}${noteText}`;
}
