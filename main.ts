import {
  App,
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  RequestUrlParam,
  Setting,
  WorkspaceLeaf,
  request,
} from 'obsidian';
import { EmailView, VIEW_TYPE_EMAIL } from './email-view';
import { OTPView, VIEW_TYPE_OTP } from './otp-view';

interface EpiphanySettings {
  baseUrl: string;
  jwtToken: string | null;
  createSeparateNotes: boolean;
}

const DEFAULT_SETTINGS: EpiphanySettings = {
  baseUrl: 'https://api-v2.epiphanyvoice.app',
  jwtToken: null,
  createSeparateNotes: false,
};

type Upload = {
  id: string;
  userId: string;
  label?: string;
  url: string;
  transcription: string;
  createdAt?: Date;
  createSeparate?: boolean;
  fileName: string;
  vaultPath: string;
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
      await this.fetchNotes();
      await this.updateFiles();
    } catch (err) {
      new Notice(err.message || 'Unknown error');
    }
  }

  async fetchNotes() {
    const url = `${this.settings.baseUrl}/api/uploads/obsidian`;
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
      if (res.length !== 0) {
        res.forEach(async (upload: Upload) => {
          if (upload.vaultPath === this.getVaultPath()) {
            if (upload.createSeparate) {
              await this.app.vault.create(
                `${upload.label}.md`,
                `${upload.transcription} \n [audio](${upload.url})`
              );
              await this.updateNote(upload.id);
            } else {
              await this.modifyFile(upload, upload.fileName);
            }
          }
        });
      } else {
        return;
      }
    } catch (err) {
      new Notice(err.message || 'Unknown error');
    }
  }

  async modifyFile(upload: Upload, fileName: string) {
    const combinedFilePath = fileName;
    let combinedFile = await this.app.vault.getFileByPath(combinedFilePath);

    if (!combinedFile) {
      combinedFile = await this.app.vault.create(combinedFilePath, '');
    }

    let combinedContent = await this.app.vault.read(combinedFile);

    const noteContent = `\n\n ## ${upload.label} \n ${upload.transcription} \n [audio](${upload.url})`;
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
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    } else {
      //@ts-ignore
      return adapter.basePath;
    }
  }

  async updateFiles() {
    if (this.settings.jwtToken && this.settings.jwtToken !== '') {
      const vault_path = this.getVaultPath();
      const vault_name = this.app.vault.getName();
      const files = this.app.vault.getMarkdownFiles().map((file) => {
        return { name: file.name, path: file.path };
      });

      const url = `${this.settings.baseUrl}/api/uploads/obsidian/update-vault`;
      const options: RequestUrlParam = {
        url: url,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.jwtToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files, vault_name, vault_path }),
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
      if (this.settings.jwtToken && this.settings.jwtToken !== '') {
        this.fetchNotes();
      } else if (!this.isLoginOpen) {
        this.openEmailView();
      }
      await this.updateFiles();
      this.registerEvent(
        this.app.vault.on('create', async () => await this.updateFiles())
      );
      this.registerEvent(
        this.app.vault.on('delete', async () => await this.updateFiles())
      );
      this.registerEvent(
        this.app.vault.on('rename', async () => await this.updateFiles())
      );
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

    this.addSettingTab(new EpiphanySettingTab(this.app, this));

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

class EpiphanySettingTab extends PluginSettingTab {
  plugin: EpiphanyPlugin;

  constructor(app: App, plugin: EpiphanyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName('Create separate notes')
      .setDesc('Create separate file for each epiphany note')
      .addToggle((value) =>
        value
          .setValue(this.plugin.settings.createSeparateNotes)
          .onChange(async (value) => {
            this.plugin.settings.createSeparateNotes = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
