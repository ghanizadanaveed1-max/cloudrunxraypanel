# Cloud Run Xray Panel

VLESS, VMess and Trojan over WebSocket on Google Cloud Run, with a private web panel that shows every config and a QR code for each.

- Open the Cloud Run URL in Chrome, sign in, and see all config details.
- Default panel password: **Ghanizada**
- Tunnel endpoints: `/vless`, `/vmess`, `/trojan` (WebSocket, TLS on port 443)

## Deploy (Google Cloud Shell)

Open [Cloud Shell](https://shell.cloud.google.com), paste this one command, and press Enter:

```bash
cd ~ && rm -rf cloudrunxraypanel && git clone https://github.com/ghanizadananaveed1-max/cloudrunxraypanel.git && cd cloudrunxraypanel && chmod +x deploy.sh && ./deploy.sh
```

When it finishes, copy the **Service URL** it prints, open it in Chrome and sign in with `Ghanizada`. Then scan a QR code or copy a link into your client.

If Cloud Shell asks which project to use, run this first and then paste the command above:

```bash
gcloud config set project YOUR_PROJECT_ID
```

Optional region or service name:

```bash
REGION=europe-west1 SERVICE=my-panel ./deploy.sh
```

To update later after you push changes to GitHub, paste the same one-line command again. It re-clones and redeploys.

## Change the password and keys

Set environment variables on the service (this also changes the generated UUID and Trojan password unless you set them):

```bash
gcloud run services update ghanizada-panel --region us-central1 \
  --update-env-vars PANEL_PASSWORD=NewStrongPassword
```

| Variable | Purpose | Default |
|---|---|---|
| `PANEL_PASSWORD` | Panel login | `Ghanizada` |
| `UUID` | VLESS / VMess user ID | derived from the password |
| `TROJAN_PASSWORD` | Trojan password | derived from the password |
| `PUBLIC_HOST` | Force the host shown in links | request host |
| `ADDRESS` | Connect address (domain or IP) used in links | same as host |
| `REMARK` | Name prefix in clients | `CloudRun` |

## Client settings

Address = your Cloud Run host, port 443, TLS on, SNI and Host = the same host, network = ws, path = `/vless`, `/vmess` or `/trojan`.
Works with v2rayNG, NekoBox, Hiddify, Streisand, Shadowrocket and v2rayN.

## Files

```
server.js        panel, login, QR API, WebSocket passthrough, Xray launcher
public/          web panel (index.html, style.css, app.js)
Dockerfile       Node + Xray-core
deploy.sh        one-command Cloud Run deploy
```

## Notes

- Cloud Run caps a request at 60 minutes, so long connections reconnect after that. `--timeout 3600` is already set.
- Cloud Run bills for the time connections are open. Check pricing and Google’s terms of service for your use.
- Change the default password before sharing the URL with anyone.
