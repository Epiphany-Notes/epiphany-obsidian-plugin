import { ItemView, WorkspaceLeaf, Setting } from 'obsidian';

export const VIEW_TYPE_OTP = "otp-view";

export class OTPView extends ItemView {
    otp = '';

    constructor(leaf: WorkspaceLeaf, onSubmit: (otp: string) => void) {
        super(leaf);
        this.onSubmit = onSubmit;
    }

    onSubmit: (otp: string) => void;

    getViewType() {
        return VIEW_TYPE_OTP;
    }

    getDisplayText() {
        return "Enter OTP";
    }

    async onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: 'Enter the OTP' });

        new Setting(contentEl)
            .setName('One Time Password')
            .addText((text) => text.onChange((value) => (this.otp = value)));

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText('Submit')
                    .setCta()
                    .onClick(() => {
                        this.onSubmit(this.otp);
                        this.onClose();
                    })
            );
    }

    async onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
