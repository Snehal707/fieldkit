# Installing FieldKit

Requires **Hermes Agent ≥ 0.23.0** with the web dashboard.

## 1. Install the plugin
```bash
hermes plugins install Snehal707/fieldkit        # or: copy this repo to $HERMES_HOME/plugins/fieldkit
hermes plugins enable fieldkit
hermes plugins show fieldkit                  # 23 tools, 1 hook, dashboard tab, api: plugin_api.py
```
The repo ships its built front-ends (`dashboard/dist/`, `dashboard/app_dist/`), so no Node.js is needed on the host.
Building yourself is covered in [Building from source](#building-from-source).

## 2. Configure (optional)
No configuration is needed for app links. The first time anyone opens the **FieldKit** dashboard tab or the app over
**https**, FieldKit records that public URL. Proxy headers and path prefixes are respected, https is preferred, and
loopback addresses are ignored. Hermes then returns full, tappable app links.

To set the address explicitly, use the command below. An explicit setting always wins over the detected URL. It is read live, so no restart is needed.
```bash
hermes config set plugins.entries.fieldkit.settings.public_url https://YOUR-DOMAIN
```

Or in `config.yaml`:
```yaml
plugins:
  entries:
    fieldkit:
      settings:
        public_url: https://your-hermes.example.org   # optional; overrides the detected URL
        auto_analyze: true                           # queue Hermes analysis for every synced record
```

## 3. Load it
- **Install and enable** do not need a dashboard restart (verified with Hermes v0.23.0). A plugin enabled after the dashboard started is hot-mounted on its first request; Hermes does this itself.
- **Updates:** the phone app files take effect immediately (installed apps show "Update ready"). Changes to FieldKit's **Python** code (API, tools, analysis) take effect only after Hermes reloads the plugin code, i.e. the next dashboard/gateway restart, because Python keeps an already-loaded plugin in memory.
- **Tools and the skill** load in the next Hermes session.
- **Don't restart a shared or hosted instance without its operator's agreement.**

## 4. Phones
1. The phone must reach the dashboard over **HTTPS**, because service workers need a secure context.
2. Open the dashboard → **FieldKit** tab → **Mobile Access**. Scan the QR code, or open `https://<host>/dashboard-plugins/fieldkit/app_dist/index.html`.
3. Sign in to Hermes. If your session has expired later, the app still opens and offers **Sign in**.
4. In **Offline Packs**, download workflows, then optional models (translation about 110 MB per direction, speech about 41 MB, OCR 1–3 MB per language).
5. Install the app:
   - Android Chrome: menu → **Install app**.
   - iPhone Safari: Share → **Add to Home Screen**.
   - On iOS the installed app has its own storage, separate from Safari. Open it and sign in once from inside it.
6. Check that **Home → Offline readiness** shows ✔ for the first three checks.

**Installed from the old address?** If you added FieldKit to your Home Screen from `/api/plugins/fieldkit/app/`, the app asks you to re-add it. Open the new address in Safari → Share → **Add to Home Screen**, sign in once inside the new icon, then remove the old icon. Records are not lost.

**Storage on iPhone.** Browsers keep FieldKit's records on the device, but by default they may clear data of sites unused for a long time or when the device is almost full ([WebKit storage policy](https://webkit.org/?p=14403)). FieldKit asks for protection; Safari decides by itself and often says no, even for Home Screen apps. That is normal. **Settings → Storage on this device** shows *Protected*, *Standard storage (not protected)* or *Standard storage* (no protection API). Records stay on the phone until Hermes confirms them, so open FieldKit and sync regularly, and use **Export** for an extra backup.

The app header shows the device network, Hermes reachability, records awaiting confirmation and "N not submitted" drafts. Tap the status pill to open **Connection diagnostics**, which runs a live connection test and shows evidence of every request.

## 5. Automatic analysis
After a sync, FieldKit queues a durable `analyze` job.
- **Automatic mode** (`/status` → `analysis_mode: automatic`): a background worker in the dashboard process runs the job with Hermes' own LLM.
- **Deferred mode** (no LLM handle in that process): ask Hermes to "process pending FieldKit jobs", or add a cron job:
  ```bash
  hermes cron create "every 15m" "Call fieldkit_process_pending_jobs and report any FieldKit record that requires review." --name fieldkit-analysis --skill fieldkit
  ```
  Deferred mode and the cron job are not yet verified end to end.

## Photo analysis with a vision model
If your default model can't read images, FieldKit analyses records **text-only** and marks the report "Photos not analysed". To analyse photos with a separate vision model, without changing the gateway's default model, set FieldKit's own model slot. These settings are read live, so no restart is needed:
```bash
hermes config set auxiliary.fieldkit_vision.provider <provider>
hermes config set auxiliary.fieldkit_vision.model <vision-model-id>
hermes config set plugins.entries.fieldkit.settings.vision_task true
```
If `config set` refuses the unknown key, add `--force`.

If that model is unavailable, FieldKit falls back to the default model, then to text-only. After a plugin update, ask Hermes to "process pending FieldKit jobs with `retry_failed: true`" once to re-run jobs that failed before the fix.

## Building from source
```bash
npm ci --legacy-peer-deps
npm run build          # PWA → dashboard/app_dist (fails if any binary/WASM would ship), tab → dashboard/dist
```
