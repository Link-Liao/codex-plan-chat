# Codex Plan Chat

A small, single-user chat page that runs on a self-hosted Ubuntu VM and uses Codex app-server with an OAuth access token authorized for ChatGPT plan usage. It is intended for personal, noncommercial use by the server owner.

## What it does

- Serves a Chinese prompt-and-reply page.
- Uses the official Codex app-server with a ChatGPT plan OAuth session.
- Keeps the app on `127.0.0.1` and uses an SSH local tunnel, so the initial IP-only deployment needs no domain or public HTTP endpoint.
- Requires a Basic Auth password and limits prompts to 4,000 characters.
- Runs each turn in a read-only sandbox with approval disabled; no Codex tools are exposed from the web request.

This starter is intended for one owner. Do not give the URL, Basic Auth password, credential file, or VM access to other people.

## Local sign-in and VM credentials

The official self-hosted VM path completes OAuth locally because the loopback callback returns to the computer running the browser. Run `npm run auth` on the same account and workspace that will use the VM. The script validates the ID token and requested ChatGPT plan scope, then writes `data/credentials.json` and a stable VM host ID. The `data/` directory is ignored by Git.

Transfer those two files to `/var/lib/codex-plan-chat/data/` over SSH/SCP. Do not paste their contents into chat, commit them, or place them in the web root. The VM refreshes tokens and retains the replacement refresh token.

## VM deployment outline

1. Install Node.js 22 or newer and the official Codex CLI on Ubuntu 24.04.
2. Copy this repository to `/opt/codex-plan-chat` and install the systemd unit from `deploy/codex-plan-chat.service`.
3. Create `/etc/codex-plan-chat.env` with `APP_PASSWORD` (a long random value), `DATA_DIR=/var/lib/codex-plan-chat/data`, `PORT=8080`, and optionally `CODEX_MODEL`.
4. Create a locked-down `codex-chat` service account. Give it read access to the app and write access only to its data directory.
5. Start `codex-plan-chat.service`. The app binds only to `127.0.0.1:8080`.
6. From the owner’s PC, open an SSH tunnel: `ssh -i <private-key> -N -L 8080:127.0.0.1:8080 ubuntu@<server-ip>`. Visit `http://127.0.0.1:8080` in the same PC browser. The browser asks for username `codex` and the `APP_PASSWORD`.

The SSH tunnel encrypts browser traffic end to end to the VM and avoids sending a Basic Auth password over public plain HTTP. No domain is needed for this verification setup. For a permanent public URL, add a domain and HTTPS, keep authentication, and restrict SSH to trusted source IPs.

## Security

- The app is bound to localhost and must stay behind the SSH tunnel, HTTPS, or a tightly IP-restricted private path.
- OAuth tokens belong only in the server's protected `data/credentials.json`; never commit or paste them.
- The server limits prompt length and runs Codex with a read-only sandbox and no tools.
- ChatGPT plan usage is subject to account eligibility, consent, model access, and plan limits.
- OpenAI's self-hosted VM documentation says host-specific usage attribution and revocation for transferred sessions are not yet available. Revoke the app's access in the authorized ChatGPT account if you later retire the VM.

## License

MIT. See [LICENSE](LICENSE).

