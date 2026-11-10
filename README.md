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

The script then asks you, one at a time:

1. **Region**: a numbered list of Cloud Run regions. Press Enter for `us-central1`, or type a number or a region name.
2. **CPU**: `0.5`, `1`, `2` or `4` vCPU. Press Enter for `1`.
3. **RAM**: only the sizes that work with the CPU you chose. With `0.5` vCPU the maximum is `512Mi`. Press Enter for `512Mi`.
4. A summary, and **Deploy now? [Y/n]**.

To skip the questions, set the values first:

```bash
REGION=europe-west1 CPU=1 MEMORY=512Mi ./deploy.sh
```

Other options: `SERVICE=my-panel` (service name), `MAX_INSTANCES=4` (maximum instances), and `DRY_RUN=1` (print the deploy command without running it).

To update later after you push changes to GitHub, paste the same one-line command again. It re-clones and redeploys.

## Change the password and keys

Set environment variables on the service (this also changes the generated UUID and Trojan password unless you set them):

```bash
gcloud run services update ghanizada-panel --region REGION \
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
deploy.sh        interactive Cloud Run deploy (region, CPU, RAM)
```

## Notes

- Cloud Run caps a request at 60 minutes, so long connections reconnect after that. `--timeout 3600` is already set.
- Cloud Run bills for the time connections are open. Check pricing and Google’s terms of service for your use.
- Change the default password before sharing the URL with anyone.
