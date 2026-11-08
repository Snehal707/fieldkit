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
`config.yaml`:
```yaml
plugins:
  entries:
    fieldkit:
      settings:
        public_url: https://your-hermes.example.org   # lets Hermes return absolute app links
        auto_analyze: true                           # queue Hermes analysis for every synced record
```

## 3. Load it
- **API routes:** a plugin enabled after the dashboard started is hot-mounted on its first request; Hermes does this itself.
- **Tools and the skill** are picked up by the agent on its next plugin load. A restart of the gateway or agent may be needed, depending on how Hermes runs.
- **Plugin updates:** an already-mounted router only picks up new code after a dashboard restart.
- **Don't restart a shared or hosted instance without its operator's agreement.**

## 4. Phones
1. The phone must reach the dashboard over **HTTPS**, because service workers need a secure context.
2. Open the dashboard → **FieldKit** tab → **Mobile Access**. Scan the QR code, or open `https://<host>/api/plugins/fieldkit/app/`.
3. Sign in to Hermes.
4. In **Offline Packs**, download workflows, then optional models (translation about 110 MB per direction, speech about 41 MB, OCR 1–3 MB per language).
5. Install the app:
   - Android Chrome: menu → **Install app**.
   - iPhone Safari: Share → **Add to Home Screen**.
   - On iOS the installed app has its own storage, separate from Safari. Open it and sign in once from inside it.
6. Check that **Home → Offline readiness** shows ✔ for the first three checks.

## 5. Automatic analysis
After a sync, FieldKit queues a durable `analyze` job.
- **Automatic mode** (`/status` → `analysis_mode: automatic`): a background worker in the dashboard process runs the job with Hermes' own LLM.
- **Deferred mode** (no LLM handle in that process): ask Hermes to "process pending FieldKit jobs", or add a cron job:
  ```bash
  hermes cron create "every 15m" "Call fieldkit_process_pending_jobs and report any FieldKit record that requires review." --name fieldkit-analysis --skill fieldkit
  ```

## Building from source
```bash
npm ci --legacy-peer-deps
npm run build          # PWA → dashboard/app_dist (fails if any binary/WASM would ship), tab → dashboard/dist
```
