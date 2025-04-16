import {
  App,
  Modal,
  Notice,
  Plugin,
  RequestUrlParam,
  WorkspaceLeaf,
  moment,
  request,
} from 'obsidian';
import { EmailView, VIEW_TYPE_EMAIL } from './email-view';
import { OTPView, VIEW_TYPE_OTP } from './otp-view';

interface EpiphanySettings {
  baseUrl: string;
  jwtToken: string | null;
  vaultId: string | null;
  vaultName: string | null;
}

const DEFAULT_SETTINGS: EpiphanySettings = {
  baseUrl: 'https://api-v2.epiphanyvoice.app',
  jwtToken: null,
  vaultId: null,
  vaultName: null,
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
};

export default class EpiphanyPlugin extends Plugin {
  settings: EpiphanySettings;
  private authRequestId: string | null = null;
  private isLoginOpen = false;

  async openEmailView() {
    this.isLoginOpen = true;
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_EMAIL,
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async openOTPView() {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_OTP,
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async handleEmailSubmit(email: string) {
    const url = `${this.settings.baseUrl}/api/auth/login`;
    const options: RequestUrlParam = {
      url: url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    };

    try {
      const response = await request(options);
      const res = JSON.parse(response);

      if (res.error) {
        throw new Error(res.message);
      }
      this.authRequestId = res.auth_request_id;
      new Notice('OTP sent to your email.');
      this.openOTPView();
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_EMAIL);
    } catch (err) {
      new Notice(err.message || 'Unknown error');
    }
  }

  async handleOTPSubmit(otp: string) {
    if (!this.authRequestId) {
      new Notice('No auth request ID found. Please start the process again.');
      return;
    }

    const url = `${this.settings.baseUrl}/api/auth/verify-code`;
    const options: RequestUrlParam = {
      url: url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ auth_request_id: this.authRequestId, code: otp }),
    };

    try {
      const response = await request(options);
      const res = JSON.parse(response);

      if (res.error) {
        throw new Error(res.message);
      }

      this.settings.jwtToken = res.jwt_token;
      await this.saveSettings();

      this.app.workspace.detachLeavesOfType(VIEW_TYPE_OTP);
      this.isLoginOpen = false;
      new Notice('Login successful!');
      if (!this.settings.vaultId && !this.settings.vaultName) {
        await this.syncVault();
      }
    } catch (err) {
      new Notice(err.message || 'Unknown error');
    }
  }

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
        if (uploads && uploads.length > 0) {
          for (const upload of uploads) {
            const typeKey =
              upload.typeId ??
              (upload.createSeparate
                ? ObsidianTypeKey.NEW
                : ObsidianTypeKey.EXISTING);

            const fileData = {
              name: '',
              createNew: false,
            };

            switch (typeKey) {
              case ObsidianTypeKey.DAILY_APPEND: {
                const dailyOptions =
                  (this.app as any)?.internalPlugins?.plugins?.['daily-notes']
                    ?.instance?.options ?? {};

                const { format, folder } = dailyOptions;

                const now = moment();
                const dailyFileName = now.format(
                  (format as string) ?? 'YYYY-MM-DD'
                );

                const dailyFolder: string = (folder as string) ?? '';

                const dailyFolderFormatted = dailyFolder
                  ? dailyFolder.endsWith('/')
                    ? dailyFolder
                    : dailyFolder + '/'
                  : '';

                const fullPath = dailyFolderFormatted + dailyFileName + '.md';

                const dailyNoteFile = await this.app.vault.getFileByPath(
                  fullPath
                );

                fileData.createNew = !dailyNoteFile;
                fileData.name = fullPath;
                break;
              }
              case ObsidianTypeKey.EXISTING: {
                fileData.createNew = false;
                fileData.name = 'Epiphany notes.md';
                break;
              }
              case ObsidianTypeKey.NEW: {
                const combinedFilePath = `${upload.label}.md`;
                const combinedFile = await this.app.vault.getFileByPath(
                  combinedFilePath
                );
                const path = combinedFile
                  ? `${upload.label} - ${upload.syncId}.md`
                  : `${upload.label}.md`;

                fileData.createNew = true;
                fileData.name = path;
                break;
              }
              default: {
                new Notice('Not able to sync the new epiphany', 5000);
                throw new Error(`Unknown type key: '${typeKey}'`);
              }
            }

            if (fileData.createNew) {
              await this.app.vault.create(
                fileData.name,
                `${upload.transcription} ${
                  upload.includeAudioAttachment
                    ? `\n [audio](${upload.url})`
                    : ''
                }`
              );

              await this.updateNote(upload.id);
            } else {
              await this.modifyFile(upload, fileData.name);
            }
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

  async modifyFile(upload: Upload, fileName: string) {
    const combinedFilePath = fileName;
    let combinedFile = await this.app.vault.getFileByPath(combinedFilePath);

    if (!combinedFile) {
      combinedFile = await this.app.vault.create(combinedFilePath, '');
    }

    let combinedContent = await this.app.vault.read(combinedFile);

    const noteContent = `\n\n ## ${upload.label} \n ${upload.transcription} ${
      upload.includeAudioAttachment ? `\n [audio](${upload.url})` : ''
    }`;
    combinedContent += noteContent;
    await this.updateNote(upload.id);

    await this.app.vault.modify(combinedFile, combinedContent);
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
    } else if (!this.isLoginOpen) {
      this.openEmailView();
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
    } else if (!this.isLoginOpen) {
      this.openEmailView();
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
      } else if (!this.isLoginOpen) {
        this.openEmailView();
      }
    });

    this.registerView(
      VIEW_TYPE_EMAIL,
      (leaf: WorkspaceLeaf) =>
        new EmailView(leaf, (email) => this.handleEmailSubmit(email))
    );

    this.registerView(
      VIEW_TYPE_OTP,
      (leaf: WorkspaceLeaf) =>
        new OTPView(leaf, (otp) => this.handleOTPSubmit(otp))
    );

    this.addCommand({
      id: 'open-email-view',
      name: 'Enter Email',
      callback: () => this.openEmailView(),
    });

    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.jwtToken && this.settings.jwtToken !== '') {
          this.fetchNotes();
        } else if (!this.isLoginOpen) {
          this.openEmailView();
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
