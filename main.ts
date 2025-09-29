import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  RequestUrlParam,
  Setting,
  moment,
  request,
} from 'obsidian';

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

enum ObsidianTypeKey {
  DAILY_APPEND = 'daily-append',
  EXISTING = 'existing',
  NEW = 'new',
}

type Upload = {
  id: string;
  userId: string;
  syncId: any;
  label?: string;
  url: string;
  transcription: string;
  createdAt?: Date;
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

  async fetchNotes() {
    const vaultName = this.settings.vaultName;
    if (vaultName) {
      const url = `${this.settings.baseUrl}/api/uploads/obsidian?vaultName=${vaultName}`;
      const options: RequestUrlParam = {
        url: url,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.jwtToken}`,
          'ngrok-skip-browser-warning': '69420',
        },
      };

      try {
        const response = await request(options);
        const res = JSON.parse(response);

        if (res.error) {
          throw new Error(res.message);
        }

        const uploads = res as Array<Upload>;
        if (uploads && uploads.length) {
          for (const upload of uploads) {
            const typeKey =
              upload.typeId ??
              (upload.createSeparate
                ? ObsidianTypeKey.NEW
                : ObsidianTypeKey.EXISTING);

            const fileData = {
              path: '',
            };

            switch (typeKey) {
              case ObsidianTypeKey.DAILY_APPEND: {
                let dailyFormat = DEFAULT_DAILY_FORMAT;

                const { format, folder } =
                  (this.app as any)?.internalPlugins?.plugins?.['daily-notes']
                    ?.instance?.options ?? {};

                if (format) {
                  const isValidFormat = !UNSUPPORTED_DAILY_FORMAT_CHARS.some(
                    (char) => (format as string).includes(char)
                  );

                  if (isValidFormat) {
                    dailyFormat = format;
                  }
                }

                const now = moment();
                const dailyFileName = now.format(dailyFormat);

                const dailyFolder: string = (folder as string) ?? '';

                const dailyFolderFormatted =
                  dailyFolder && !dailyFolder.endsWith('/')
                    ? dailyFolder + '/'
                    : dailyFolder;

                fileData.path = dailyFolderFormatted + dailyFileName + '.md';
                break;
              }
              case ObsidianTypeKey.EXISTING: {
                fileData.path = 'Epiphany notes.md';
                break;
              }
              case ObsidianTypeKey.NEW: {
                const combinedFilePath = `${upload.label}.md`;
                const combinedFile =
                  this.app.vault.getFileByPath(combinedFilePath);
                const path = combinedFile
                  ? `${upload.label} - ${upload.syncId}.md`
                  : `${upload.label}.md`;

                fileData.path = path;
                break;
              }
              default: {
                new Notice('Not able to sync the new epiphany', 5000);
                throw new Error(`Unknown type key: '${typeKey}'`);
              }
            }

            await this.createOrModifyFile(upload, fileData.path);
          }

          const single = uploads.length === 1;
          new Notice(
            single
              ? 'New epiphany synced'
              : `${uploads.length} new epiphanies synced`,
            5000
          );
        } else {
          return;
        }
      } catch (err) {
        new Notice(err.message || 'Unknown error');
      }
    }
  }

  private getNoteTextFromUpload(upload: Upload): string {
    const label = upload.includeTitle ? `${upload.label}\n` : '';
    const transcription = upload.transcription ?? 'N/A';
    const audioFile = upload.includeAudioAttachment
      ? `\n [audio](${upload.url})`
      : '';

    return label + transcription + audioFile;
  }

  async createOrModifyFile(upload: Upload, filePath: string) {
    const noteText = this.getNoteTextFromUpload(upload);

    const existingFile = this.app.vault.getFileByPath(filePath);
    if (existingFile) {
      const existingContent = await this.app.vault.read(existingFile);
      const combinedContent = `${existingContent}\n\n${noteText}`;

      await this.app.vault.modify(existingFile, combinedContent);
    } else {
      await this.app.vault.create(filePath, noteText);
    }

    await this.updateNote(upload.id);
  }

  async updateNote(id: string) {
    const url = `${this.settings.baseUrl}/api/uploads/obsidian/sync/${id}`;
    const options: RequestUrlParam = {
      url: url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.jwtToken}`,
        'Content-Type': 'application/json',
      },
    };

    try {
      const response = await request(options);
      const res = JSON.parse(response);

      if (res.error) {
        throw new Error(res.message);
      }
    } catch (err) {
      new Notice(err.message || 'Unknown error');
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
        headers: {
          Authorization: `Bearer ${this.settings.jwtToken}`,
          'Content-Type': 'application/json',
        },
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
        new Notice(err.message || 'Unknown error');
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
        headers: {
          Authorization: `Bearer ${this.settings.jwtToken}`,
          'Content-Type': 'application/json',
        },
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
        new Notice(err.message || 'Unknown error');
      }
    }
  }

  async onload() {
    await this.loadSettings();
    this.app.workspace.onLayoutReady(async () => {
      if (!this.settings.vaultId && !this.settings.vaultName) {
        await this.syncVault();
      }

      if (this.settings.jwtToken && this.settings.jwtToken !== '') {
        this.fetchNotes();
        let combinedFile = await this.app.vault.getFileByPath(
          'Epiphany notes.md'
        );

        if (!combinedFile) {
          combinedFile = await this.app.vault.create('Epiphany notes.md', '');
        }
      }
    });

    this.addSettingTab(new EpiphanySettingTab(this.app, this));

    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.jwtToken && this.settings.jwtToken !== '') {
          this.fetchNotes();
        }
      }, 0.1 * 60 * 1000)
    );
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
      new Notice(err.message || 'Unknown error');
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
      if (err?.status === 400) {
        new Notice('Password is incorrect.');
      } else {
        new Notice(err?.message || 'Unknown error');
      }
    }

    if (!this.plugin.settings.vaultId && !this.plugin.settings.vaultName) {
      await this.plugin.syncVault();
    }
  }
}
