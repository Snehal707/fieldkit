---
name: fieldkit-workspace-builder
description: Set up, change or undo changes to a FieldKit workspace: the offline forms a user fills in on their phone to collect observations for any kind of work (visits, inspections, interviews, surveys, research, client or site notes, personal logs), in any profession or country. Use when the user wants FieldKit set up for their work, wants to change their forms (add, remove or change questions, options, units, the purpose or title), or says "undo my last workspace update".
---

# FieldKit workspace builder

A workspace is the user's work turned into offline forms: what they record each time (answers, notes, issues,
photos, voice notes, GPS, signatures). FieldKit only collects and syncs; analysing the entries later is the user's
Hermes agent's job, when they ask. **Use the user's own words, units and categories; never invent questions, options,
limits or rules they did not give you.**

## 1. Interview (in the user's language, a few questions at a time)

Start with one question: **what is this workspace for?** Then ask only what you need, usually 3-6 questions:
- what they record each time (questions, measurements with units, choices with their options, free notes, issues seen);
- what identifies an entry (a site, person, household, asset, plot, sample...), so earlier entries of the same
  subject can be found;
- which media they need (photos, voice notes, location). Add a **signature** field only if the user asks for one
  (e.g. consent or sign-off); never add it by default;
- languages: the phone app supports **English and Hindi** only.
Ask before drafting: never guess a form before the user has told you what they record. Infer small details (field ids,
which fields are required) and show them in the summary. Add min/max limits only when the user gave them. The subject
(`metadata.subject_field`) is a short text, number or choice question the user can search by, never GPS or media.
If you still have open questions, ask them before drafting; a plain "yes" is not an answer to them. Publish only after
the user has seen the drafted forms (a "yes" to your interview summary is not approval of a draft they have not seen).

## 2. Draft, show, publish

1. `fieldkit_workspace_format` once, for the form schema and an example.
2. `fieldkit_draft_workspace` with `workspace_id` (lowercase slug), `title`, `purpose` (the user's words), `languages`
   and `forms` (one form per kind of entry; set `metadata.subject_field`). Label text in every chosen language.
3. Fix any `errors` (send the whole corrected form again). `fixed_automatically` lists shape repairs FieldKit made.
4. Show the user, in a few lines, each form and its questions. Publish with `fieldkit_publish_workspace` and
   `user_approved: true` only after they approve. Give the returned app link: on the phone, open the workspace and tap
   "Download everything for offline". Use the `app_link` that publishing returns (a workspace link); for a link later,
   `fieldkit_get_app_link` with `workspace_id`.

## 3. Changing a workspace (no new interview)

For "add a question about X", "remove the GPS field", "make the date required", "add an option", "change the purpose":
1. `fieldkit_get_workspace(workspace_id)` to see the current forms.
2. `fieldkit_draft_workspace(workspace_id, ...)` with **only** what changes: the whole changed form in `forms` (same id
   replaces it), `remove_forms`, `title`, `purpose` or `languages`. Do not redesign anything else. Keep every field the
   user did not ask to change, signatures included; if the draft warns that a signature field would be removed, remove
   it only if the user asked for that.
3. Show `changes_since_published` as a short list and ask "Publish these changes?". Publish only after they say yes.
4. Entries already made keep their original form version and answers, including answers to removed questions.

Workspaces made with FieldKit before 0.3 may still contain parts FieldKit no longer uses (sources, evidence, decision
guides); `fieldkit_get_workspace` lists them as `legacy_parts_not_used`, and the next edit drops them. Mention this in
the change summary; nothing the user recorded is lost.

## 4. Undo

An explicit "undo my last workspace update" is the approval: call `fieldkit_undo_workspace_update(workspace_id,
user_confirmed=true)` and tell the user exactly what changed back (the returned `changes`). If it is unclear what they
want undone, preview first (without `user_confirmed`) and ask. It publishes the previous version as a new version, so
phones get it as an update.
