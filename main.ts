import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	RequestUrlParam,
	Setting,
	TFile,
	moment,
	normalizePath,
	request,
} from 'obsidian';

import { buildAppendedContent } from './src/append';
import { ObsidianTypeKey, resolveTargetPath } from './src/note-target';
import { parentFolders } from './src/path-utils';


interface EpiphanySettings {
	baseUrl: string;
	jwtToken: string | null;
	vaultId: string | null;
	vaultName: string | null;

	// settings page
	email: string | null;
}

const DEFAULT_SETTINGS: EpiphanySettings = {
	baseUrl: 'https://api-v2.epiphanyvoice.app',
	jwtToken: null,
	vaultId: null,
	vaultName: null,
	email: null,
};

type Upload = {
	id: string;
	userId: string;
	syncId: any;
	label?: string;
	url: string;
	transcription: string;
	createdAt?: string;
	createSeparate?: boolean;
	typeId?: ObsidianTypeKey;
	fileName: string;
	vaultPath: string;
	includeAudioAttachment: boolean;
	includeTitle: boolean;
};

const DEFAULT_DAILY_FORMAT = 'YYYY-MM-DD';
const UNSUPPORTED_DAILY_FORMAT_CHARS = ['/', '\\', ':'];

export default class EpiphanyPlugin extends Plugin {
	settings: EpiphanySettings;

	// SSE connection state
	private eventSource: EventSource | null = null;
	private sseConnected = false;
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private reconnectDelay = 1000;
	private pollingInterval: number | null = null;
	private isFetching = false;
	private lastFetchAt = 0;
	private static readonly FETCH_DEBOUNCE_MS = 5000;

	private static isHttpStatus(err: unknown, code: number): boolean {
		return typeof err === 'object' && err !== null && (err as { status?: number }).status === code;
	}


	// --- Common headers helper ---

	private getHeaders(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.settings.jwtToken}`,
			'X-Plugin-Version': this.manifest.version,
			'ngrok-skip-browser-warning': '69420',
		};
	}

	// --- Core sync methods ---

	async fetchNotes(opts: { force?: boolean } = {}) {
		if (this.isFetching) return;
		if (!opts.force) {
			const now = Date.now();
			if (now - this.lastFetchAt < EpiphanyPlugin.FETCH_DEBOUNCE_MS) return;
		}
		this.isFetching = true;
		this.lastFetchAt = Date.now();
		try {
			const vaultName = this.settings.vaultName;
			if (vaultName) {
				const url = `${this.settings.baseUrl}/api/uploads/obsidian?vaultName=${encodeURIComponent(vaultName)}`;
				const options: RequestUrlParam = {
					url: url,
					method: 'GET',
					headers: this.getHeaders(),
				};

				let syncedCount = 0;
				try {
					const response = await request(options);
					const res = JSON.parse(response);

					if (res.error) {
						throw new Error(res.message);
					}

					const uploads = res as Array<Upload>;
					if (uploads && uploads.length) {
						for (const upload of uploads) {
							try {
								const success = await this.syncSingleUpload(upload);
								if (success) syncedCount++;
							} catch (err) {
								// Isolate per-upload failures: free the server-side
								// claim so the record retries, then keep going — one
								// bad record must not strand the rest of the batch
								// in `syncingAt` limbo.
								this.reportSyncError(
									upload.id,
									(err as Error)?.message ?? String(err)
								).catch(() => { });
							}
						}

						if (syncedCount > 0) {
							new Notice(
								syncedCount === 1
									? 'New epiphany synced'
									: `${syncedCount} new epiphanies synced`,
								5000
							);
						}
					}
				} catch (err) {
					if (EpiphanyPlugin.isHttpStatus(err, 429)) return;
					// Only show generic error if no notes synced at all
					if (syncedCount === 0) {
						new Notice('Epiphany: Something went wrong, please try again later.', 5000);
					}
				}
			}
		} finally {
			this.isFetching = false;
		}
	}

	private async syncSingleUpload(upload: Upload): Promise<boolean> {
		const typeKey =
			upload.typeId ??
			(upload.createSeparate ? ObsidianTypeKey.NEW : ObsidianTypeKey.EXISTING);

		let dailyFormat = DEFAULT_DAILY_FORMAT;
		const { format, folder } =
			(this.app as any)?.internalPlugins?.plugins?.['daily-notes']?.instance
				?.options ?? {};
		if (format) {
			const isValidFormat = !UNSUPPORTED_DAILY_FORMAT_CHARS.some((char) =>
				(format as string).includes(char)
			);
			if (isValidFormat) {
				dailyFormat = format;
			}
		}
		// 2.10: Use recording date instead of current date
		const recordedAt = upload.createdAt ? moment(upload.createdAt) : moment();

		const targetPath = normalizePath(
			resolveTargetPath({
				typeKey,
				label: upload.label,
				syncId: upload.syncId,
				fileName: upload.fileName,
				dailyFileName: recordedAt.format(dailyFormat),
				dailyFolder: (folder as string) ?? '',
				markdownFiles: this.app.vault
					.getMarkdownFiles()
					.map((f) => ({ path: f.path, basename: f.basename })),
				fileExists: (p) => this.app.vault.getFileByPath(p) !== null,
			})
		);

		return await this.createOrModifyFile(upload, targetPath);
	}

	// --- 2.12: Markdown readability improvements ---

	private getNoteTextFromUpload(upload: Upload): string {
		const label = upload.includeTitle ? `${upload.label}\n` : '';
		const transcription = upload.transcription ?? 'N/A';
		const audioFile = upload.includeAudioAttachment
			? `\n [audio](${upload.url})`
			: '';

		return label + transcription + audioFile;
	}

	// --- 2.4 & 2.5: File write with duplicate protection and retry ---

	async createOrModifyFile(upload: Upload, filePath: string): Promise<boolean> {
		const existingFile = this.app.vault.getFileByPath(filePath);
		const noteText = this.getNoteTextFromUpload(upload);

		try {
			await this.writeToVault(existingFile, filePath, noteText);
		} catch (err) {
			// Retry once after 1 second
			try {
				await new Promise(resolve => setTimeout(resolve, 1000));
				// Re-resolve file state after delay
				const retryFile = this.app.vault.getFileByPath(filePath);
				const retryNoteText = this.getNoteTextFromUpload(upload);
				await this.writeToVault(retryFile, filePath, retryNoteText);
			} catch (retryErr) {
				new Notice('Epiphany: Something went wrong, please try again later.', 5000);
				// Report error to API (fire-and-forget)
				this.reportSyncError(upload.id, (retryErr as Error).message).catch(() => { });
				// Don't call updateNote — record stays unsynced for retry on next fetch
				return false;
			}
		}

		await this.updateNote(upload.id);
		return true;
	}

	private async ensureFolderChain(filePath: string) {
		for (const folder of parentFolders(filePath)) {
			if (this.app.vault.getFolderByPath(folder)) continue;
			try {
				await this.app.vault.createFolder(folder);
			} catch (err) {
				// Race: the folder appeared between check and create (other
				// device via Obsidian Sync, or the daily-notes plugin). Only
				// rethrow if it's still genuinely missing.
				if (!this.app.vault.getFolderByPath(folder)) throw err;
			}
		}
	}

	private async writeToVault(existingFile: TFile | null, filePath: string, noteText: string) {
		const appendNote = (current: string) => buildAppendedContent(current, noteText);

		if (existingFile) {
			// Vault knows about the file — atomic read+write, serialised against
			// other vault.process calls. If the append is a duplicate, the same
			// reference comes back and Obsidian skips the disk write.
			await this.app.vault.process(existingFile, appendNote);
			return;
		}

		// Vault cache doesn't have a TFile. Check the filesystem directly — sync
		// may have written the file before Obsidian's watcher picked it up.
		if (await this.app.vault.adapter.exists(filePath)) {
			// adapter.process is also documented as atomic; safer than adapter.write here.
			await this.app.vault.adapter.process(filePath, appendNote);
			return;
		}

		// Genuinely new file. Parent folders must exist first — `vault.create`
		// does NOT create them and throws instead (unsynced daily-notes folders,
		// path-style fileNames).
		await this.ensureFolderChain(filePath);
		await this.app.vault.create(filePath, noteText);
	}

	// --- Sync confirmation ---

	async updateNote(id: string) {
		const url = `${this.settings.baseUrl}/api/uploads/obsidian/sync/${id}`;
		const options: RequestUrlParam = {
			url: url,
			method: 'POST',
			headers: this.getHeaders(),
		};

		try {
			const response = await request(options);
			const res = JSON.parse(response);

			if (res.error) {
				throw new Error(res.message);
			}
		} catch (err) {
			// Silently fail — sync confirmation errors are retried on next fetch
		}
	}

	getVaultPath() {
		const adapter = this.app.vault.adapter;
		//@ts-ignore
		return adapter.basePath;
	}

	syncVault = async (vaultName?: string) => {
		if (this.settings.jwtToken && this.settings.jwtToken !== '') {
			const vault_path = this.getVaultPath();
			const vault_name = vaultName || this.app.vault.getName();

			const url = `${this.settings.baseUrl}/api/uploads/obsidian/sync-vault`;
			const options: RequestUrlParam = {
				url: url,
				method: 'POST',
				headers: this.getHeaders(),
				body: JSON.stringify({ vault_name, vault_path }),
			};

			try {
				const response = await request(options);
				const res = JSON.parse(response);

				if (res.error) {
					throw new Error(res.message);
				}
				if (res.isUnique) {
					this.settings.vaultId = res.id;
					this.settings.vaultName = vault_name;
					await this.saveSettings();
				} else {
					new VaultConflictModal(
						this.app,
						vault_name,
						res.id,
						this.saveModalResults,
						this.syncVault
					).open();
				}
			} catch (err) {
				if (EpiphanyPlugin.isHttpStatus(err, 429)) return;
				new Notice('Epiphany: Something went wrong, please try again later.', 5000);
			}
		}
	};

	saveModalResults = async (vaultName: string, vaultId: string) => {
		this.settings.vaultId = vaultId;
		this.settings.vaultName = vaultName;
		await this.saveSettings();
	};

	async updateFiles() {
		if (this.settings.jwtToken && this.settings.jwtToken !== '') {
			const vault_path = this.getVaultPath();
			const vault_name = this.settings.vaultName;

			const url = `${this.settings.baseUrl}/api/uploads/obsidian/update-vault`;
			const options: RequestUrlParam = {
				url: url,
				method: 'POST',
				headers: this.getHeaders(),
				body: JSON.stringify({
					vault_name,
					vault_path,
					vault_id: this.settings.vaultId,
				}),
			};

			try {
				const response = await request(options);
				const res = JSON.parse(response);

				if (res.error) {
					throw new Error(res.message);
				}
			} catch (err) {
				// Silently fail — vault update errors are non-critical
			}
		}
	}

	// --- 2.8: Error reporting to API ---

	private async reportSyncError(uploadId: string, error: string) {
		try {
			await request({
				url: `${this.settings.baseUrl}/api/uploads/obsidian/sync-error`,
				method: 'POST',
				headers: this.getHeaders(),
				body: JSON.stringify({ uploadId, error, pluginVersion: this.manifest.version }),
			});
		} catch {
			// Silently ignore — error reporting should never block sync
		}
	}

	// --- 2.9: Version check & update warning ---

	private async checkForUpdates() {
		try {
			const response = await request({
				url: `${this.settings.baseUrl}/api/uploads/obsidian/latest-version`,
				method: 'GET',
				headers: this.getHeaders(),
			});
			const { latestVersion } = JSON.parse(response);

			if (latestVersion && this.isVersionLessThan(this.manifest.version, latestVersion)) {
				new Notice(
					`A new version of Epiphany is available (v${latestVersion}). Please update in Settings > Community Plugins.`,
					0 // persistent notice
				);
			}
		} catch {
			// Silently ignore — version check should never block plugin startup
		}
	}

	private isVersionLessThan(current: string, target: string): boolean {
		const [cMajor, cMinor, cPatch] = current.split('.').map(Number);
		const [tMajor, tMinor, tPatch] = target.split('.').map(Number);
		if (cMajor !== tMajor) return cMajor < tMajor;
		if (cMinor !== tMinor) return cMinor < tMinor;
		return cPatch < tPatch;
	}

	// --- 2.1: SSE Connection Manager ---

	initSseConnection = async () => {
		if (!this.settings.jwtToken) return;

		try {
			// Get ticket
			const ticketResponse = await request({
				url: `${this.settings.baseUrl}/api/sse/ticket`,
				method: 'POST',
				headers: this.getHeaders(),
			});
			const { ticket } = JSON.parse(ticketResponse);

			this.reconnectDelay = 1000;

			// Open EventSource
			this.eventSource = new EventSource(
				`${this.settings.baseUrl}/api/sse/sync?ticket=${ticket}`
			);

			this.eventSource.addEventListener('connected', () => {
				this.sseConnected = true;
				this.stopPolling();
				this.fetchNotes({ force: true }).catch(() => { });
			});

			this.eventSource.addEventListener('sync-ready', () => {
				this.fetchNotes({ force: true }).catch(() => { });
			});

			this.eventSource.onerror = () => {
				this.closeSseConnection();
				this.startReconnection();
				this.startPolling(); // Fallback
			};
		} catch (err) {
			if (EpiphanyPlugin.isHttpStatus(err, 401)) {
				new Notice('Epiphany: Session expired. Please re-authenticate in settings.');
				return; // Don't reconnect on auth failure
			}
			if (EpiphanyPlugin.isHttpStatus(err, 429)) {
				this.reconnectDelay = 30000;
			}
			this.startReconnection();
			this.startPolling();
		}
	};

	private closeSseConnection() {
		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
		}
		this.sseConnected = false;
	}

	// --- 2.2: Reconnection with exponential backoff ---

	private startReconnection() {
		if (this.reconnectTimeout) return; // Already reconnecting

		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			this.initSseConnection().catch(() => { });
		}, this.reconnectDelay);

		// Exponential backoff: 1s -> 2s -> 4s -> 8s -> 16s -> 30s cap
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
	}

	private stopReconnection() {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
	}

	// --- 2.3: Fallback adaptive polling ---

	private startPolling() {
		if (this.pollingInterval !== null) return; // Already polling

		const poll = () => {
			if (this.sseConnected) return; // SSE reconnected
			if (this.settings.jwtToken) {
				this.fetchNotes().catch(() => { });
			}
		};

		// Poll at 60s interval
		this.pollingInterval = window.setInterval(() => {
			poll();
		}, 60 * 1000);
		this.registerInterval(this.pollingInterval);
	}

	private stopPolling() {
		if (this.pollingInterval !== null) {
			window.clearInterval(this.pollingInterval);
			this.pollingInterval = null;
		}
	}

	// --- Lifecycle ---

	async onload() {
		await this.loadSettings();
		this.app.workspace.onLayoutReady(async () => {
			if (!this.settings.vaultId && !this.settings.vaultName) {
				await this.syncVault();
			}

			if (this.settings.jwtToken && this.settings.jwtToken !== '') {
				this.fetchNotes().catch(() => { }); // Immediate fetch on load
				this.initSseConnection().catch(() => { }); // Start SSE
				this.checkForUpdates().catch(() => { }); // Version check
			}
		});

		this.addSettingTab(new EpiphanySettingTab(this.app, this));

		// Visibility change handler — fetch on focus
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (!document.hidden && this.settings.jwtToken) {
				this.fetchNotes().catch(() => { });
			}
		});
	}

	onunload() {
		this.closeSseConnection();
		this.stopReconnection();
		this.stopPolling();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class VaultConflictModal extends Modal {
	vaultName: string;
	resId: string;
	saveResults: (vaultName: string, vaultId: string) => Promise<void>;
	syncVault: (vaultName: string) => Promise<void>;

	constructor(
		app: App,
		vaultName: string,
		resId: string,
		saveResults: (vaultName: string, vaultId: string) => Promise<void>,
		syncVault: (vaultName: string) => Promise<void>
	) {
		super(app);
		this.vaultName = vaultName;
		this.resId = resId;
		this.saveResults = saveResults;
		this.syncVault = syncVault;
	}

	onOpen() {
		const { contentEl } = this;

		const style = document.createElement('style');
		style.textContent = `
      button{
      cursor: pointer;
      margin: 5px
      }
    `;
		contentEl.appendChild(style);

		contentEl.createEl('h2', { text: 'Epiphany vault conflict detected' });

		contentEl.createEl('p', {
			text: `While trying to sync your vault, we found a vault with the name "${this.vaultName}" already existing.`,
		});

		const option1 = contentEl.createEl('button', {
			text: 'Sync with existing vault',
		});
		option1.onclick = async () => {
			new Notice('Syncing with existing vault...');
			this.saveResults(this.vaultName, this.resId);
			this.close();
		};

		const option2 = contentEl.createEl('button', {
			text: 'Create new vault with different name',
		});
		option2.onclick = () => {
			this.showVaultNameInput();
		};
	}

	showVaultNameInput() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Create new vault' });

		const input = contentEl.createEl('input', {
			type: 'text',
			placeholder: 'Enter new vault name',
		});

		const submitBtn = contentEl.createEl('button', { text: 'Create vault' });
		submitBtn.onclick = () => {
			const newName = input.value;
			if (newName) {
				new Notice(`Creating vault with name: ${newName}`);
				this.syncVault(newName);
				this.close();
			} else {
				new Notice('Please enter a valid vault name.');
			}
		};
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class EpiphanySettingTab extends PluginSettingTab {
	private plugin: EpiphanyPlugin;
	private email: string;
	private authRequestId: string | null = null;
	private otp: string | null = null;

	constructor(app: App, plugin: EpiphanyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.email = plugin.settings.email ?? '';
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Email')
			.setDesc('Enter your Epiphany account email address.')
			.addText((text) =>
				text
					.setPlaceholder('Enter email')
					.setValue(this.email)
					.onChange(async (value) => {
						this.email = value;
					})
			)
			.addButton((button) => {
				button.setButtonText('Send authorization email').onClick(async () => {
					await this.handleEmailSubmit(this.email);
					this.refreshScreen();
				});
			});

		if (this.authRequestId) {
			new Setting(containerEl)
				.setName('One Time Password')
				.setDesc('Please check your inbox.')
				.addText((text) =>
					text
						.setPlaceholder('Enter code')
						.setValue(this.otp ?? '')
						.onChange((value) => {
							this.otp = value;
						})
				)
				.addButton((button) => {
					button.setButtonText('Verify').onClick(async () => {
						await this.handleOTPSubmit(this.otp);
						this.refreshScreen();
					});
				});
		}
	}

	private refreshScreen() {
		this.display();
	}

	private async handleEmailSubmit(emailAddress: string | null) {
		this.authRequestId = null;

		if (!emailAddress) {
			new Notice('No email found. Please enter email address.');
			return;
		}

		new Notice('Sending email...');

		const url = `${this.plugin.settings.baseUrl}/api/auth/login`;
		const options: RequestUrlParam = {
			url: url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Plugin-Version': this.plugin.manifest.version,
			},
			body: JSON.stringify({ email: emailAddress }),
		};

		try {
			const response = await request(options);
			const res = JSON.parse(response);

			if (res.error) {
				throw new Error(res.message);
			}
			this.authRequestId = res.auth_request_id;

			// update email
			this.plugin.settings.email = emailAddress;
			await this.plugin.saveSettings();

			new Notice('OTP sent to your email.');
		} catch (err) {
			new Notice('Epiphany: Something went wrong, please try again later.', 5000);
		}
	}

	private async handleOTPSubmit(code: string | null) {
		if (!this.authRequestId) {
			new Notice('No auth request ID found. Please start the process again.');
			return;
		}

		if (!code) {
			new Notice('Please enter code.');
			return;
		}

		new Notice('Verifying...');

		const url = `${this.plugin.settings.baseUrl}/api/auth/verify-code`;
		const options: RequestUrlParam = {
			url: url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Plugin-Version': this.plugin.manifest.version,
			},
			body: JSON.stringify({ auth_request_id: this.authRequestId, code: code }),
		};

		try {
			const response = await request(options);
			const res = JSON.parse(response);

			if (res.error) {
				throw new Error(res.message);
			}

			this.plugin.settings.jwtToken = res.jwt_token;
			await this.plugin.saveSettings();

			this.authRequestId = null;
			this.otp = null;

			new Notice('Login successful!');
		} catch (err) {
			if ((err as any)?.status === 400) {
				new Notice('Password is incorrect.');
			} else {
				new Notice('Epiphany: Something went wrong, please try again later.', 5000);
			}
		}

		if (!this.plugin.settings.vaultId && !this.plugin.settings.vaultName) {
			await this.plugin.syncVault();
		}

		// 2.6: Initialize SSE connection after successful auth
		if (this.plugin.settings.jwtToken) {
			this.plugin.initSseConnection().catch(() => { });
		}
	}
}
