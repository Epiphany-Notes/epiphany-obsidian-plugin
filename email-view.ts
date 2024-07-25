import { ItemView, WorkspaceLeaf, Setting } from 'obsidian';

export const VIEW_TYPE_EMAIL = "email-view";

export class EmailView extends ItemView {
    email = '';

    constructor(leaf: WorkspaceLeaf, onSubmit: (email: string) => void) {
        super(leaf);
        this.onSubmit = onSubmit;
    }

    onSubmit: (email: string) => void;

    getViewType() {
        return VIEW_TYPE_EMAIL;
    }

    getDisplayText() {
        return "Login to epiphany account";
    }

    async onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: 'Enter your Email' });

        new Setting(contentEl)
            .setName('Email')
            .addText((text) => text.onChange((value) => (this.email = value)));

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText('Submit')
                    .setCta()
                    .onClick(() => {
                        this.onSubmit(this.email);
                        this.onClose();
                    })
            );
    }

    async onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
