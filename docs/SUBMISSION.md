# Hackathon submission (0.3.2)

**Event:** Hermes Agent Plugin Hackathon. The deadline is reported as **Nov 11 2026, 5 PM ET**. Confirm it against the official Nous Research announcement before submitting.

## Pitch (short)
**Record offline. Sync when back online. Ask your Hermes agent about what you recorded.**

FieldKit is an offline observation collection and synchronisation plugin for Hermes. Hermes sets up the forms for your work
in a short chat. You fill them in on your phone with no internet: questions, choices, photos, voice notes, GPS and
signatures. When you are back online, entries sync securely and idempotently. Syncing only uploads. Hermes then reads the
entries and their photos and voice notes with its own tools, when you ask.

FieldKit never calls a model. It is not an assistant, a research tool or a decision system.

- Workspaces are set up, changed and undone by chat. Hermes publishes only after you approve.
- Each entry keeps the form version it was made with, so old entries stay readable after a change.
- The phone app works offline and can be installed on the home screen. Optional offline OCR and English ↔ Hindi translation.
- One plugin, with unlimited workspaces.

## Demo script (3–4 minutes)
Steps 1–7 are the core demo. Step 8 is optional.

**What is verified.** On a local test Hermes v0.23.1 (2026-11-11, commit 5d77969): a final audit of 40 real chat
conversations, which built 39 workspaces, and 1,272 synced entries with 1,599 files, all matching on Hermes. Earlier, on
v0.23.0 (2026-11-10), with real conversations: setting up a workspace, editing it and undoing an edit by chat, and asking
about a synced visit with a photo. **Real iPhone (owner):** the owner tested everything on a real iPhone with the hosted Hermes and the Hermes Agent mobile
app (iOS), and it all works. The hosted Hermes was also checked on commit 5d77969: all 12 tools, workspace links and
existing data.

1. **Set up for my work (Hermes Mobile or chat).** "Set up FieldKit for my work." Hermes asks what you record, shows a summary
   of the forms, and publishes after you approve. It returns a tappable app link.
   - Tools: `fieldkit_workspace_format` → `fieldkit_draft_workspace` → `fieldkit_publish_workspace`.
2. **Download on the phone.** Open the link over HTTPS and sign in. Tap **Download everything for offline**. In **Offline Packs**, install the translation and OCR packs if you want them.
3. **Install and go offline.** Share → **Add to Home Screen**, then sign in once inside the installed app. Turn on airplane mode, with Wi-Fi and mobile data both off. Reopen FieldKit from the home screen.
4. **Record offline.** Fill in the form. Add a photo, a voice note, GPS and a signature.
   - Optional: **Extract text** on the photo (OCR). **Translate** a sentence, English → Hindi.
5. **Save and sync.** The result shows **Saved locally. Pending synchronization.** Turn the network back on. Sync runs by itself and only uploads. Nothing is processed.
6. **Ask your Hermes agent in chat.** For example: "What do the photos from my latest visit show?" Hermes lists the entries (`fieldkit_list_records`), reads one (`fieldkit_get_record`), opens its photos and voice notes (`fieldkit_get_attachment`), and looks at them with its own vision and speech-to-text tools. FieldKit makes no model call.
7. **Edit and undo by chat.** "Add a question 'Door seal intact?'." Hermes changes only that, shows the change, and asks "Publish these changes?" before publishing. The phone shows **Update available**. The old entry keeps its answers.
   - Tools: `fieldkit_draft_workspace`, `fieldkit_publish_workspace`.
   - Then: "Undo my last workspace update." The earlier version is published again as a new version (`fieldkit_undo_workspace_update`).
8. **Another kind of work (optional).** Repeat step 1 for a different job, for example a classroom observation. The same tools build it.

## Catalog entry (draft, do not open the PR without the owner's go-ahead)
Repository must be public; `sha` must be the full 40-character commit; `version` quoted.
```yaml
# plugin-catalog/fieldkit.yaml
name: fieldkit
repo: https://github.com/Snehal707/fieldkit
sha: "<40-char commit sha>"
version: "0.3.2"
requires_hermes: ">=0.23.0"
description: "Offline observation forms set up by Hermes in a short chat (questions, choices, photos, voice notes, GPS, signatures; English and Hindi), with secure, idempotent sync; your Hermes agent reads the synced entries with its own tools when you ask."
network_disclosure: "The phone app downloads pinned on-device model files (translation and OCR) from huggingface.co and cdn.jsdelivr.net only when the user installs one of those packs. The backend makes no third-party calls and no model calls."
```

## Tool list (12)
- Entries: `fieldkit_list_records`, `fieldkit_get_record`, `fieldkit_get_attachment`
- Sync: `fieldkit_get_sync_status`, `fieldkit_resolve_conflict`
- Phone: `fieldkit_get_app_link`
- Workspaces: `fieldkit_workspace_format`, `fieldkit_draft_workspace`, `fieldkit_publish_workspace`, `fieldkit_undo_workspace_update`, `fieldkit_get_workspace`, `fieldkit_list_workspaces`

Skills: `fieldkit` (find and read entries) and `fieldkit-workspace-builder` (set up, change and undo workspaces).

## Known limitations
- Photos and voice notes are read only by the user's Hermes agent, with its own vision and speech-to-text tools. Those tools must be configured in Hermes.
- The small translation model mistranslates some technical terms (for example "bearing" → "bear").
- OCR cannot read blurred, dark or handwritten text, and says so.
- Phone languages are English and Hindi.
- iOS PWAs have separate storage from Safari. Sign in once inside the installed app.
- Uploads run while the app is open. There is no background upload from a closed app.
- Hermes OAuth sessions last 15 minutes. Sync pauses and asks you to sign in; nothing is lost.
- Approval steps rely on Hermes asking before it publishes. FieldKit cannot see whether the user replied in between.

## Checklist before submitting
- [ ] Confirm the deadline (reported as Nov 11 2026, 5 PM ET) and the submission format (catalog PR, form, or both) against the official announcement.
- [ ] Push to the public GitHub repo at https://github.com/Snehal707/fieldkit.
- [ ] Run `hermes plugins validate .` and `hermes plugins doctor . --ci` on the final commit. Both passed on 0.3.2 with Hermes v0.23.1 on a local test Hermes (12 tools, 0 hooks). Re-run on the exact commit you submit.
- [ ] Run the Python, TypeScript and Playwright suites on the final commit (see [docs/TESTING.md](TESTING.md)).
- [ ] Run `npm run build` and commit `dashboard/dist` and `dashboard/app_dist`.
- [x] Real iPhone + hosted Hermes + Hermes mobile app: offline recording, sync, media and Saved Records (owner, 0.2.4).
- [x] Everything on the owner's iPhone with the hosted Hermes and the Hermes Agent mobile app (iOS) (owner, 2026-11-11).
- [x] Hosted Hermes on commit 5d77969: 12 tools, workspace links and existing data checked (owner, 2026-11-11).
- [ ] Record the demo video (3–4 minutes).
- [ ] Open the catalog PR only with the owner's go-ahead.
