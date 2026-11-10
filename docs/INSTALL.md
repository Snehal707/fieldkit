# Installing FieldKit

Requires **Hermes Agent ≥ 0.23.0** with the web dashboard.

## 1. Install the plugin
```bash
hermes plugins install Snehal707/fieldkit        # or: copy this repo to $HERMES_HOME/plugins/fieldkit
hermes plugins enable fieldkit
hermes plugins show fieldkit                  # 20 tools, 1 hook, dashboard tab, api: plugin_api.py
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
        auto_analyze: true                           # run queued questions in the background
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
4. In **Offline Packs**, download workflows, then optional models (translation about 110 MB per direction, English speech about 64 MB, OCR 1–3 MB per language, and the **Question understanding — English and Hindi** pack, about 118 MB).
5. Install the app:
   - Android Chrome: menu → **Install app**.
   - iPhone Safari: Share → **Add to Home Screen**.
   - On iOS the installed app has its own storage, separate from Safari. Open it and sign in once from inside it.
6. Check that **Home → Offline readiness** shows ✔ for the first three checks.

**Installed from the old address?** If you added FieldKit to your Home Screen from `/api/plugins/fieldkit/app/`, the app asks you to re-add it. Open the new address in Safari → Share → **Add to Home Screen**, sign in once inside the new icon, then remove the old icon. Records are not lost.

**Storage on iPhone.** Browsers keep FieldKit's records on the device, but by default they may clear data of sites unused for a long time or when the device is almost full ([WebKit storage policy](https://webkit.org/?p=14403)). FieldKit asks for protection; Safari decides by itself and often says no, even for Home Screen apps. That is normal. **Settings → Storage on this device** shows *Protected*, *Standard storage (not protected)* or *Standard storage* (no protection API). Records stay on the phone until Hermes confirms them, so open FieldKit and sync regularly, and use **Export** for an extra backup.

The app header shows the device network, Hermes reachability, records awaiting confirmation and "N not submitted" drafts. Tap the status pill to open **Connection diagnostics**, which runs a live connection test and shows evidence of every request.

## 5. Questions about visits
Saving or syncing a visit never starts AI work. Syncing only uploads. Hermes works when you ask:
- **A question about a visit** (asked on the phone) is answered after the visit syncs.
- **A question in Hermes chat** (`fieldkit_ask_about_record`) is answered at once.

Older workspaces may contain `report_policy.after_sync`; it is accepted and ignored.

Answers use Hermes' main model. Check which main model your Hermes uses. On a local test install without a configured main model, Hermes fell back to a free model that was rate-limited. In local test runs with `openai/gpt-5.4-mini` via Nous, answers came back in 32–37 s. If the provider rate-limits a request (HTTP 429 with `retry_after`), FieldKit waits as long as it is told, and the question stays queued rather than failed.

- **Automatic mode** (`/status` → `analysis_mode: automatic`): a background worker in the dashboard process answers queued questions with Hermes' own LLM.
- **Deferred mode** (no LLM handle in that process): questions wait until Hermes processes them. Ask Hermes to "process pending FieldKit jobs".

## 6. Build your workspace
A workspace is your job turned into an offline kit: workflows, decision guides, knowledge and sources. Hermes builds it.
1. In Hermes (Mobile, chat or dashboard), ask: "Set up FieldKit for my work."
2. Hermes asks what the workspace is for, then 5–8 follow-up questions chosen for that purpose. It shows you a brief to confirm, and builds the workspace straight away. There is no up-front web research. Your own rules are labelled "Your procedure". Checking a rule against official sources is optional. A source check uses Hermes' own `web_search` and `web_extract` tools, so it needs web search configured in Hermes.
3. Hermes publishes the workspace only after you approve it. It then returns an app link.
4. Open the link on your phone (it opens `#/workspace/<id>`) and tap **Download everything for offline**.
5. In **Offline Packs**, install the optional **Question understanding — English and Hindi** pack (about 118 MB). Without it, the Workspace Assistant uses basic word search.

The bundled examples are starter workspaces, labelled synthetic. In local tests on a local test Hermes, a build took about 2.5 minutes on average. Workspace builds are not yet verified on the owner's iPhone or the hosted Hermes.

To change the workspace later, ask Hermes in chat, for example "add a question…" or "change our rule". Hermes shows what changed and asks before it publishes. To undo the last update, ask "Undo my last workspace update." The phone shows **Update available** for each new version.

## Photo analysis with a vision model
To send photos to a separate vision model when answering questions about a visit, without changing the gateway's default model, set FieldKit's own model slot. These settings are read live, so no restart is needed:
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
