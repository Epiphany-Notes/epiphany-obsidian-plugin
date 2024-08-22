# Epiphany Plugin

**Epiphany Plugin** is a plugin that allows you to synchronize your voice notes recorded in the Epiphany Voice app directly into your vault. This plugin ensures your voice notes are seamlessly integrated into your knowledge base by importing transcriptions and audio links from the Epiphany service.

## Features

- **Voice Note Synchronization**: Automatically sync voice notes and their transcriptions from the Epiphany Voice app into your vault.
- **Email and OTP Authentication**: Securely log in to the Epiphany service using email and OTP authentication.
- **Vault Conflict Management**: Resolve conflicts if a vault with the same name already exists on the Epiphany service.
- **Automatic Fetching**: Periodically fetch new voice notes from the Epiphany service and update your vault.

## Usage

### Authentication

#### Open Email View
Start by entering your email address to authenticate with the Epiphany service.

- Use the command palette or the provided command in the settings tab to open the email view.

#### Receive OTP
After submitting your email, you'll receive an OTP in your inbox.

#### Enter OTP
Open the OTP view and enter the OTP you received to complete the authentication process.

### Voice Note Synchronization

#### First-Time Sync
After authentication, the plugin will automatically sync your vault with voice notes stored in the Epiphany service.

- The notes will be fetched and stored in your vault according to the plugin settings.
- If there is a conflict with an existing vault name, you will be prompted to either sync with the existing vault or create a new one.

#### Periodic Fetching
The plugin will periodically check for new voice notes on the Epiphany service and update your vault. You can also manually trigger a sync via the command palette.

### Vault Conflict Resolution

If a vault with the same name already exists on the Epiphany service, a modal will appear with two options:

- **Sync with Existing Vault**: Choose this option if the vault on your device matches the one on the service.
- **Create New Vault with Different Name**: Choose this option to create a new vault with a unique name to avoid conflicts.
