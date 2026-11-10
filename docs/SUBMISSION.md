# Hackathon submission

**Event:** Hermes Agent Plugin Hackathon. The deadline is reported as **Nov 11 2026, 5 PM ET**. Confirm it against the official Nous Research announcement before submitting.

## Pitch (short)
**Observe anywhere. Understand more when connected. Act better next time.**

FieldKit is an offline fieldwork platform powered by Hermes. It is not an offline Google or an AI diagnosis tool. The
phone records and applies your own rules offline. Hermes answers questions about a visit and writes reports when you ask.
Saving data is the default; Hermes helps only when you ask.

FieldKit makes Hermes useful where there is no internet. In 0.2.6, Hermes first builds a **workspace** for your actual
job: it interviews you about the decisions, records, rules and escalation for your work, and builds the workspace
straight away. Your own rules are labelled "Your procedure". Each item is labelled by how well it is evidenced. The
workspace is published only after you approve it, and the phone downloads it for offline use. On the phone, FieldKit
then helps you decide with no internet:
- decision guides that ask only for what is missing;
- the Workspace Assistant, which answers from your procedures, rules, the workspace, your records and reports, with citations, in English and Hindi;
- an "On this phone" summary of your records;
- branching questions, photos, GPS, voice notes and signatures;
- instant local findings, a dictionary, sentence translation, OCR and speech-to-text, all on the device.

Back online, records sync securely and idempotently through the plugin API. Syncing starts no AI work. A question a user
asked on a visit is answered by Hermes from that visit's evidence, and the answer returns to the phone. When the user asks
for a report, Hermes writes a **decision-focused report**: a decision, why, what is uncertain, ordered next actions with a way to
verify each, and checks for the next inspection. Those checks are asked on the next inspection, and verified outcomes
help the workspace improve, after you confirm each change. It's one plugin, with unlimited workflows and knowledge domains.

## Demo script (3–4 minutes)
Steps 1–9 are the core demo. Step 10 is optional.

**What is verified.** The owner verified 0.2.4 on a real iPhone with the hosted Hermes and the Hermes mobile app: every
step of the earlier demo, including OCR, translation, speech-to-text, photos, voice notes, signatures, the AI report,
offline reports and the Hermes Mobile conversation. **0.2.5 and 0.2.6 are verified only on a local test Hermes** (Chromium,
and WebKit where [docs/TESTING.md](TESTING.md) says so). They are **not yet verified** on the owner's iPhone or the hosted
Hermes, including the live interview.

1. **Set up for my work (Hermes Mobile).** "Set up FieldKit for my work." Hermes interviews you about the job, shows you
   the brief to confirm, and builds the workspace straight away (about 2.5 minutes on average in local tests). Checking
   a rule against official sources is optional. Hermes publishes the workspace after you approve it, and returns a
   tappable app link.
   - Tools: `fieldkit_save_workspace_brief` → `fieldkit_build_workspace` → `fieldkit_publish_workspace`. A source check, when used, uses Hermes' own `web_search` and `web_extract`.
2. **Download on the phone.** Open the link over HTTPS and sign in. Tap **Download everything for offline**. In **Offline Packs**, install the **Question understanding — English and Hindi** pack, and the translation, OCR (English) and speech-to-text packs.
3. **Install and go offline.** Share → **Add to Home Screen**, then sign in once inside the installed app. Turn on airplane mode, with Wi-Fi and mobile data both off. Reopen FieldKit from the home screen.
4. **Decide offline.**
   - Open the workspace's decision guide and answer what it asks. The outcome shows the evidence status of each action.
   - Ask the assistant a question in English and one in Hindi. Each answer has a citation and an evidence status.
   - Ask an off-topic question. It is refused as not covered, and the question is kept for Hermes.
5. **Inspect offline.**
   - Symptoms → vibration, which reveals the vibration question; enter 9 mm/s.
   - Guard → No. Add a photo, a voice note, GPS and a signature.
   - **Translate** "The pump is vibrating." → Hindi. **Scan text**: photograph a nameplate.
6. **Local results.** Show local findings (safety guard problem, vibration above alarm level, risk score, recommended action), references and explanations, with the label "Saved locally. Pending synchronization." The header shows **1 awaiting confirmation**.
7. **Close and reopen offline.** Fully close the app and reopen it. The record and its results are still there.
8. **Reconnect.** Turn the network back on. Sync runs automatically with no user action and only uploads. In the verified 0.2.4 run, the record was received 41 s after completion, with all 11 answers and the photo uploaded.
9. **Decision-focused report.** Ask Hermes for the report, since none is written on sync. Report v2 leads with the decision and its confidence, then the ordered next actions (who, by when, and how to verify each), what is uncertain, and checks for next time. Show it on the phone, in the FieldKit dashboard tab, and in Hermes Mobile. Tap **Download report**.
   - Or, on the visit, tap **Ask Hermes about this visit**. The answer returns after sync (32–37 s in local test runs).
   - Tools: `fieldkit_analyze_record`, `fieldkit_list_records`, `fieldkit_get_report`, `fieldkit_get_record`.
10. **Follow-up check on the next inspection.** Start a new inspection of the same equipment. The phone asks the previous report's checks (Done, Not done, Can't check). Answer them. The answers travel with the new record.
11. **Learning candidate.** In Hermes Mobile: "What needs a decision in my FieldKit workspace?" Hermes proposes candidates from unanswered questions (research gaps) or from verified outcomes (a local practice). A practice needs at least three consistent verified outcomes, so prepare them before the demo, or show a research gap. Confirm one. Hermes publishes a new validated workspace version with a changelog, and the phone shows **Update available**.
   - Tools: `fieldkit_propose_workspace_changes`, `fieldkit_list_learning`, `fieldkit_decide_candidate`.
12. **Offline again (optional).** Turn on airplane mode. The downloaded Hermes report is still readable. Optionally repeat the inspection with *Classroom observation* (education) or *Crop health survey* (agriculture) to show domain independence.

## Catalog entry (draft — do not open the PR without the owner's go-ahead)
Repository must be public; `sha` must be the full 40-character commit; `version` quoted.
```yaml
# plugin-catalog/fieldkit.yaml
name: fieldkit
repo: https://github.com/Snehal707/fieldkit
sha: "<40-char commit sha>"
version: "0.2.6"
requires_hermes: ">=0.23.0"
description: "Offline mobile field workflows with local findings, knowledge Q&A, translation, OCR and voice; secure sync; Hermes answers and reports on request."
network_disclosure: "PWA downloads pinned on-device model files from huggingface.co and cdn.jsdelivr.net only when the user installs a model pack. Backend makes no third-party calls."
```

## Known limitations
- The small OPUS-MT model mistranslates some technical terms (for example "bearing" → "bear").
- Whisper tiny's Hindi accuracy is limited.
- iOS PWAs have separate storage from Safari. Sign in once inside the installed app.
- Uploads run while the app is open. There is no background upload from a closed app.
- Hermes OAuth sessions last 15 minutes. Sync pauses and asks you to sign in; nothing is lost.
- The Workspace Assistant answers only from workspace content, your procedures and rules, records and reports. Without the 118 MB understanding pack it uses basic word search.
- Local-practice learning needs at least 3 consistent verified outcomes.
- PDF sources are checked with Hermes' own document extractor; a scanned PDF with a damaged text layer may only give an approximate match (numbers must still match exactly), reported for checking by eye.

## Checklist before submitting
- [ ] Confirm the deadline (reported as Nov 11 2026, 5 PM ET) and the submission format (catalog PR, form, or both) against the official announcement.
- [ ] Push to the public GitHub repo at https://github.com/Snehal707/fieldkit.
- [ ] Run `hermes plugins validate .` and `hermes plugins doctor . --ci` on the final commit. Both pass on v0.2.4 (security scan safe; doctor: 23 tools, 1 hook). For 0.2.5, `validate` passed at phase C and the final doctor run (32 tools expected) is not recorded yet. For 0.2.6, the doctor run (37 tools expected) is not recorded yet. Re-run on the exact commit you submit.
- [ ] Run the Python, TypeScript and Playwright suites on the final commit (see [docs/TESTING.md](TESTING.md)).
- [ ] Run `npm run build` and commit `dashboard/dist` and `dashboard/app_dist`.
- [x] Real iPhone + hosted Hermes + Hermes mobile app: everything checked and working (owner, 0.2.4).
- [x] Hosted dashboard tab: all sections working (owner, 0.2.4).
- [ ] 0.2.5 and 0.2.6 on the owner's iPhone and the hosted Hermes: workspace setup, decision guides, Workspace Assistant (Hindi included), questions about a visit, decision reports, follow-up checks and learning candidates.
- [ ] Optional: Android Chrome; scheduled analysis (cron); scheduled workspace proposals (cron, not verified).
- [ ] Record the demo video (3–4 minutes).
- [ ] Open the catalog PR only with the owner's go-ahead.
