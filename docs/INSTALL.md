# Installing FieldKit (0.3.1)

Requires **Hermes Agent ≥ 0.23.0** with the web dashboard.

## 1. Install the plugin
```bash
hermes plugins install Snehal707/fieldkit        # or: copy this repo to $HERMES_HOME/plugins/fieldkit
hermes plugins enable fieldkit
hermes plugins show fieldkit                     # 12 tools, 0 hooks, dashboard tab, api: plugin_api.py
```
The repo ships its built front-ends (`dashboard/dist/`, `dashboard/app_dist/`), so no Node.js is needed on the host.
To build them yourself, see [Building from source](#building-from-source).

## 2. Configure (optional)
No setting is needed for phone links. When a signed-in user opens the **FieldKit** dashboard tab or the app, FieldKit
records the address they used. https is preferred and loopback addresses are ignored. Hermes then returns full, tappable
links.

To set the address explicitly, use the command below. An explicit setting always wins over the recorded address. It is
read live, so no restart is needed.
```bash
hermes config set plugins.entries.fieldkit.settings.public_url https://YOUR-DOMAIN
```

Or in `config.yaml`:
```yaml
plugins:
  entries:
    fieldkit:
      settings:
        public_url: https://your-hermes.example.org   # optional
```

`public_url` is the only FieldKit setting.

## 3. Load it
- **Install and enable** do not need a dashboard restart. A plugin enabled after the dashboard started is mounted on its
  first request (verified with Hermes v0.23.0).
- **Updates:** after `hermes plugins update fieldkit`, restart **both** the Hermes dashboard and any running Hermes
  gateway. A running gateway keeps the old plugin code loaded. The phone app files update on their own: an installed app
  shows **Update ready**.
- **Tools and skills** load in the next Hermes session.
- **Do not restart a shared or hosted instance** without its operator's agreement.

## 4. Phones
1. The phone must reach the dashboard over **HTTPS**, because service workers need a secure context.
2. Open the dashboard → **FieldKit** tab → **Mobile Access**. Scan the QR code, or open
   `https://<host>/dashboard-plugins/fieldkit/app_dist/index.html`.
3. Sign in to Hermes. If your session expires later, the app still opens and offers **Sign in**.
4. Set up a workspace (section 5), open its link on the phone, and tap **Download everything for offline**.
5. Optional, in **Offline Packs**: English → Hindi and Hindi → English translation (about 110 MB each), and OCR for
   English (about 3 MB) and Hindi (about 1.4 MB).
6. Install the app:
   - Android Chrome: menu → **Install app**.
   - iPhone Safari: Share → **Add to Home Screen**.
   - On iOS the installed app has its own storage, separate from Safari. Open it and sign in once from inside it.
7. Check **Home → Offline readiness**: the first three checks should be marked as ready.

**Installed from the old address?** If you added FieldKit to your Home Screen from `/api/plugins/fieldkit/app/`, the app
asks you to re-add it. Open the new address in Safari → Share → **Add to Home Screen**, sign in once inside the new icon,
then remove the old icon. Records are not lost.

**Storage on iPhone.** Browsers keep FieldKit's data on the device, but by default they may clear the data of sites that
have not been used for a long time, or when the device is almost full
([WebKit storage policy](https://webkit.org/?p=14403)). FieldKit asks for protection; Safari decides, and may say no even for
Home Screen apps. **Settings → Storage on this device** shows what the browser allows. Entries stay on the phone until
Hermes confirms them, so open FieldKit and sync regularly, and use **Export data** (Settings → Backup & recovery) for an
extra backup.

The app header shows the device network, Hermes reachability, entries awaiting confirmation and unsubmitted drafts. Tap
the status pill to open **Connection diagnostics**, which runs a live connection test and shows what each request got back.

## 5. Set up a workspace
In Hermes (Mobile, chat or dashboard), say: "Set up FieldKit for my work."
1. Hermes asks what the workspace is for, which languages you use (English or Hindi), and what each entry records.
2. It shows you a summary of the forms and their questions.
3. It publishes only after you approve, and returns an app link.
4. Open the link on your phone and tap **Download everything for offline**.

To change the workspace later, ask in chat, for example "add a question about the door seal" or "remove the GPS field".
Hermes shows the changes and asks before it publishes. To undo the last update, ask "Undo my last workspace update". The
phone shows **Update available** for each new version.

The synthetic example forms in `tests/fixtures/forms` (Equipment inspection, Classroom observation, Crop health survey)
are for tests. `tests/fixtures/seed.py` publishes them as starter workspaces on a test Hermes. They are not part of the
plugin.

## 6. Photos and voice notes
Your Hermes agent reads photos and voice notes with its own tools, when you ask. FieldKit does not analyse them.
- **Photos** need Hermes' vision tool. With a text-only main model, configure a vision model in Hermes' own
  `config.yaml`, under `auxiliary.vision`. Use the provider and model keys from Hermes' documentation, for example:
  ```yaml
  auxiliary:
    vision:
      provider: <provider>
      model: <vision-model-id>
  ```
- **Voice notes** need Hermes' speech-to-text tool.

## Building from source
```bash
npm ci --legacy-peer-deps
npm run build          # PWA → dashboard/app_dist (fails if any binary or WASM file would ship), tab → dashboard/dist
npm run typecheck
```
