# Hackathon submission

**Event:** Hermes Agent Plugin Hackathon. The deadline is reported as **Nov 11 2026, 5 PM ET**. Confirm it against the official Nous Research announcement before submitting.

## Pitch (short)
FieldKit makes Hermes useful where there is no internet. You ask Hermes Mobile for a workflow, an equipment
inspection for example. Hermes generates, validates and publishes it, and hands you a link. On the phone, FieldKit
runs that workflow fully offline:
- branching questions, photos, GPS, voice notes and signatures;
- instant local findings;
- an assistant grounded in downloaded knowledge;
- a dictionary, sentence translation, OCR and speech-to-text, all on the device.

Back online, records sync securely and idempotently through the plugin API. Hermes then analyses them with its own
LLM, writes structured reports and follow-ups, and answers questions about them in Hermes Mobile. The phone keeps
downloaded reports for the next offline shift. It's one plugin, with unlimited workflows and knowledge domains.

## Demo script (3–4 minutes)
Steps 1–9 are the core demo. Step 10 is optional. Verified by the owner on a real iPhone with the hosted Hermes and the Hermes mobile app (0.2.4): every step, including OCR, translation, speech-to-text, photos, voice notes, signatures, the AI report, offline reports and the Hermes Mobile conversation.

1. **Create and publish (Hermes Mobile).** "Create an equipment inspection workflow with troubleshooting instructions and photographs, in English and Hindi, and publish it."
   - Tools: `fieldkit_create_workflow` → `fieldkit_publish_workflow`. Hermes returns a tappable app link.
2. **Download on the phone.** Open the link over HTTPS and sign in. In **Offline Packs**, download the workflow, then the translation, OCR (English) and speech-to-text packs.
3. **Install and go offline.** Share → **Add to Home Screen**, then sign in once inside the installed app. Turn on airplane mode, with Wi-Fi and mobile data both off. Reopen FieldKit from the home screen.
4. **Inspect offline.**
   - Symptoms → vibration, which reveals the vibration question; enter 9 mm/s.
   - Guard → No. Add a photo, a voice note, GPS and a signature.
   - Ask the assistant "Common reasons for equipment vibration". You get an answer, a source and follow-ups.
   - **Translate** "The pump is vibrating." → Hindi. **Scan text**: photograph a nameplate.
5. **Local results.** Show local findings (safety guard problem, vibration above alarm level, risk score, recommended action), references and explanations, with the label "Saved locally. Pending synchronization." The header shows **1 awaiting confirmation**.
6. **Close and reopen offline.** Fully close the app and reopen it. The record and its results are still there.
7. **Reconnect.** Turn the network back on. Sync runs automatically with no user action. In the verified run, the record was received 41 s after completion, with all 11 answers and the photo uploaded.
8. **AI report.** The report is generated automatically (GLM 5.3, text-only fallback), and photos are analysed through the `fieldkit_vision` model slot. Show the report on the phone, in the FieldKit dashboard tab, and in Hermes Mobile. Tap **Download report**.
   - Tools: `fieldkit_list_records`, `fieldkit_get_report`, `fieldkit_get_record`.
9. **Follow up in Hermes Mobile.** "Analyse my latest FieldKit inspection", "What should I do next?", and create a follow-up.
   - Tools: `fieldkit_save_report`, `fieldkit_create_followup`.
10. **Offline again (optional).** Turn on airplane mode. The downloaded Hermes report is still readable. Optionally repeat steps 1–5 with *Classroom observation* (education) or *Crop health survey* (agriculture) to show domain independence.

## Catalog entry (draft — do not open the PR without the owner's go-ahead)
Repository must be public; `sha` must be the full 40-character commit; `version` quoted.
```yaml
# plugin-catalog/fieldkit.yaml
name: fieldkit
repo: https://github.com/Snehal707/fieldkit
sha: "<40-char commit sha>"
version: "0.1.7"
requires_hermes: ">=0.23.0"
description: "Offline mobile field workflows with local findings, knowledge Q&A, translation, OCR and voice; secure sync and Hermes analysis/reports."
network_disclosure: "PWA downloads pinned on-device model files from huggingface.co and cdn.jsdelivr.net only when the user installs a model pack. Backend makes no third-party calls."
```

## Known limitations
- The small OPUS-MT model mistranslates some technical terms (for example "bearing" → "bear").
- Whisper tiny's Hindi accuracy is limited.
- iOS PWAs have separate storage from Safari. Sign in once inside the installed app.
- Uploads run while the app is open. There is no background upload from a closed app.
- Hermes OAuth sessions last 15 minutes. Sync pauses and asks you to sign in; nothing is lost.

## Checklist before submitting
- [ ] Confirm the deadline (reported as Nov 11 2026, 5 PM ET) and the submission format (catalog PR, form, or both) against the official announcement.
- [ ] Push to the public GitHub repo at https://github.com/Snehal707/fieldkit.
- [ ] Run `hermes plugins validate .` and `hermes plugins doctor . --ci` on the final commit. Both pass on v0.2.4 (security scan safe; doctor: 23 tools, 1 hook). Re-run on the exact commit you submit.
- [ ] Run `npm run build` and commit `dashboard/dist` and `dashboard/app_dist`.
- [x] Real iPhone + hosted Hermes + Hermes mobile app: everything checked and working (owner, 0.2.4).
- [x] Hosted dashboard tab: all sections working (owner, 0.2.4).
- [ ] Optional: Android Chrome; scheduled analysis (cron).
- [ ] Record the demo video (3–4 minutes).
- [ ] Open the catalog PR only with the owner's go-ahead.
