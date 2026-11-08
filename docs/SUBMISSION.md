# Hackathon submission

**Event:** Hermes Agent Plugin Hackathon. The deadline is reported as **2026-11-11 17:00 ET**. Confirm it against the official Nous Research announcement.

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

## Demo script (40 steps condensed)
1. Hermes Mobile: "Create an equipment inspection workflow with troubleshooting instructions and photographs, in English and Hindi, and publish it."
   - Tools: `fieldkit_create_workflow` → `fieldkit_publish_workflow`. Hermes returns the app link.
2. "Make a knowledge pack from this maintenance guide." (`fieldkit_create_knowledge_pack`)
3. Phone: open the link, sign in, then **Offline Packs**:
   - download the workflow;
   - install English→Hindi translation, OCR (English) and speech-to-text.
4. Install to the home screen. Home shows ✔ Offline readiness.
5. Airplane mode. Fully close the app, then reopen it from the home screen.
6. Ask the assistant "Common reasons for equipment vibration". You get an answer, a source and follow-ups.
7. **Translate** "The pump is vibrating." → Hindi (on device). **Dictionary**: "bearing". **Scan text**: photograph a nameplate.
8. Run the workflow:
   - Symptoms → vibration, which reveals the vibration question; enter 9 mm/s.
   - Guard → No. Add a photo, a voice note (transcribe it offline), GPS and a signature.
9. **Results:** local findings (safety guard problem, vibration above alarm level, risk score, recommended action), references, explanations. "Saved locally. Pending synchronization."
10. Close and reopen offline; the record and its results are still there.
11. Reconnect. If the session expired, the banner asks you to sign in, then sync resumes. Show **Synchronised** and **Hermes analysis: pending → completed**.
12. The Results page now shows the Hermes report, issues, actions and follow-ups. Tap **Download report**.
13. Hermes Mobile: "Analyse my latest FieldKit inspection", "What should I do next?", "Compare my last five inspections."
    - Tools: `fieldkit_list_records`, `fieldkit_get_report`, `fieldkit_get_record`, `fieldkit_save_report`, `fieldkit_create_followup`.
14. Airplane mode again; the downloaded Hermes report is still readable.
15. Repeat steps 1–9 quickly with *Classroom observation* (education) and *Crop health survey* (agriculture) to show domain independence.

## Catalog entry (draft — do not open the PR without the owner's go-ahead)
Repository must be public; `sha` must be the full 40-character commit; `version` quoted.
```yaml
# plugin-catalog/fieldkit.yaml
name: fieldkit
repo: https://github.com/Snehal707/fieldkit
sha: "<40-char commit sha>"
version: "0.1.0"
requires_hermes: ">=0.23.0"
description: "Offline mobile field workflows with local findings, knowledge Q&A, translation, OCR and voice; secure sync and Hermes analysis/reports."
network_disclosure: "PWA downloads pinned on-device model files from huggingface.co and cdn.jsdelivr.net only when the user installs a model pack. Backend makes no third-party calls."
```

## Checklist before submitting
- [ ] Confirm the deadline and the submission format (catalog PR, form, or both).
- [ ] Push to a public GitHub repo. Per the project rule, don't add Claude as a contributor.
- [ ] Run `hermes plugins validate .` and `hermes plugins doctor . --ci` on the final commit.
- [ ] Run `npm run build` and commit `dashboard/dist` and `dashboard/app_dist`.
- [ ] With the owner's permission: install on the hosted instance, confirm one real report and one Hermes Mobile conversation, and run the device checklist in TESTING.md.
- [ ] Record the demo video.
