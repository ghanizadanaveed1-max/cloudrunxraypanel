# Cloud Run Xray Panel

VLESS, VMess and Trojan over WebSocket on Google Cloud Run, with a private web panel that shows every config and a QR code for each.

- Open the Cloud Run URL in Chrome, sign in, and see all config details.
- Default panel password: **Ghanizada**
- **User management**: add users with their own keys, traffic limit, expiry date and a subscription link (see below).
- Tunnel endpoints: `/vless`, `/vmess`, `/trojan` (WebSocket, TLS on port 443)

## Deploy (Google Cloud Shell)

Open [Cloud Shell](https://shell.cloud.google.com), paste this one command, and press Enter:

```bash
rm -rf cloudrunxraypanel && \
git clone https://github.com/ghanizadanaveed1-max/cloudrunxraypanel.git && \
cd cloudrunxraypanel && \
chmod +x deploy.sh && \
sed -i 's/us-central1/us-east1/g' deploy.sh && \
./deploy.sh
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

## User management

Open the **Users** tab after signing in.

- **Add user**: each user gets their own UUID, Trojan password and subscription link.
- **Traffic limit** (GB, 0 = unlimited) and **expiry date**. When a user runs out of traffic or expires, they are removed from Xray automatically (within about 20 seconds). Extend the date or reset traffic to bring them back.
- **Enable / disable**, **reset traffic**, **new keys & link** (old ones stop working), **delete**, notes, search and status filter.
- **Configs** shows a QR code and link per protocol, plus a **Subscription** link (`/sub/<token>`). Paste it into v2rayNG, Hiddify, NekoBox or Streisand as a subscription; the app then shows usage and expiry and refreshes it by itself.
- **Export / Import backup** saves and restores the user list as a JSON file.

Adding, removing, disabling or expiring a user restarts Xray for about a second, so active connections reconnect. Editing only a name or note does not.

Traffic is counted by Xray per user (uplink + downlink, all three protocols together). The main account on the *My configs* tab is not limited.

### Keeping users after a restart

Cloud Run wipes the disk when an instance stops. To keep the user list and traffic counters, give the panel a Cloud Storage bucket:

```bash
gsutil mb -l us-east1 gs://YOUR_BUCKET
# allow the Cloud Run service account to read/write it
gsutil iam ch serviceAccount:$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')-compute@developer.gserviceaccount.com:objectAdmin gs://YOUR_BUCKET
gcloud run services update ghanizada-panel --region REGION --update-env-vars GCS_BUCKET=YOUR_BUCKET
```

Or deploy with it from the start: `GCS_BUCKET=YOUR_BUCKET ./deploy.sh`. Without a bucket the panel still works, but a yellow warning on the Users tab reminds you to use **Export backup**.

Run a **single instance** (`MAX_INSTANCES=1`, now the default in `deploy.sh`). Each instance counts traffic on its own, so several instances would give wrong totals. If you deployed earlier with 4: `gcloud run services update ghanizada-panel --region REGION --max-instances 1`.

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
| `GCS_BUCKET` | Cloud Storage bucket that stores the user list | none (local disk) |
| `GCS_OBJECT` | File name inside the bucket | `users.json` |
| `DATA_DIR` | Local folder for the user list | system temp |

## Client settings

Address = your Cloud Run host, port 443, TLS on, SNI and Host = the same host, network = ws, path = `/vless`, `/vmess` or `/trojan`.
Works with v2rayNG, NekoBox, Hiddify, Streisand, Shadowrocket and v2rayN.

## Files

```
server.js        panel, login, user management API, subscriptions, QR API, WebSocket passthrough, Xray launcher
public/          web panel (index.html, style.css, app.js)
Dockerfile       Node + Xray-core
deploy.sh        interactive Cloud Run deploy (region, CPU, RAM)
```

## Notes

- Cloud Run caps a request at 60 minutes, so long connections reconnect after that. `--timeout 3600` is already set.
- Cloud Run bills for the time connections are open. Check pricing and Google’s terms of service for your use.
- Change the default password before sharing the URL with anyone.
