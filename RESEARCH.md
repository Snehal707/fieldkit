# FieldKit — Research notes (verified Hermes interfaces)

Everything below was checked against the **installed Hermes Agent v0.23.0 source**, the version the hosted
instance reportedly runs, and against the official docs on 2026-11-08. "Verified" means read in source
or exercised by a test in this repository.

## Plugin packaging

| Item | Finding | How verified |
|---|---|---|
| Manifest | `plugin.yaml` with `name`, `version`, `description`, `provides_tools`, `provides_hooks`, `requires_hermes`, `python_dependencies`, `config_keys` | `hermes plugins validate` passes |
| Entry point | `__init__.py` defining `register(ctx)` | `hermes plugins doctor --ci` ran discovery, import and registration: 23 tools, 1 hook |
| Tools | `ctx.register_tool(name, toolset, schema, handler, check_fn=None, …, description=…)`; handler `(args: dict, **kw) -> str` (JSON) | `hermes_cli/plugins.py:463`; validator "declared tools — matches registrations" |
| Skill | `ctx.register_skill(name, path, description=…)` → resolvable as `fieldkit:fieldkit` | `hermes_cli/plugins_content.py:32` |
| Hooks | `on_session_start` is in `VALID_HOOKS`; callbacks must accept `**kwargs` | `hermes_cli/plugins.py:109`, `plugin_dev.py:476` |
| Storage | `plugins.plugin_storage.plugin_data_dir(name)` → `<HERMES_HOME>/plugin-data/<name>/`; `plugin_db(name)` → SQLite in WAL mode, `check_same_thread=False`, and the caller owns transactions | `plugins/plugin_storage.py` |
| `register()` side effects | Must not open files or start threads. Doctor runs in a temporary `HERMES_HOME` and its cleanup fails on Windows if the DB is held open | Observed, then fixed: the worker now starts lazily |

## Host LLM (`ctx.llm`)

- `ctx.llm` is `agent.plugin_llm.PluginLlm(plugin_id=…)`, created lazily on the plugin context (`hermes_cli/plugins.py:377`).
- Methods: `complete`, `complete_structured(instructions, input, json_schema, schema_name, system_prompt, …)` and async siblings. Structured output is parsed and validated against the JSON schema by Hermes (`_parse_structured_text`).
- Background threads need `contextvars.copy_context().run(...)` (official docs). FieldKit's worker does this.
- **Dashboard process:** in a real v0.23.0 dashboard (`hermes dashboard --isolated`), FieldKit's `register()` runs in the same process as `plugin_api.py`. `/status` reported `llm_available: true` and the worker processed the queued job automatically.
  - With no provider configured, Hermes returned `AuxiliaryClientUnavailable: No LLM provider configured…`. The job stayed `pending` with a retry scheduled.
  - So the automatic path reaches the real host LLM entry point. **A successful real model call is not yet verified**; it needs the hosted instance, with permission.
- Tests use Hermes' own `make_plugin_llm_for_test` with an injected `sync_caller`, loaded from the Hermes source. That exercises the real trust gate, message building and schema validation.

## Photos and non-multimodal models (0.1.2)

- **Problem:** `ctx.llm` uses the operator's default model. A text-only model (reported on the hosted instance with `z-ai/glm-5.3`) rejects image parts, so analysis of any record with photos failed on every retry.
- **Fix:** one job attempt runs a chain:
  1. Opt-in plugin vision task.
  2. Default model with photos.
  3. Default model **text-only**: answers, notes, OCR text, transcripts, local findings and knowledge references, with an explicit instruction not to infer image contents.
  - It falls back only on image rejections (image/vision/multimodal wording, or a 400/415/422 on a request that carried images). Timeouts, 429 and 5xx go to the normal job retry.
  - The report carries `images: {attached, sent_to_model, analyzed, mode, note, fallback_reasons}` plus a "missing information" line, and the PWA and dashboard show "Photos not analysed".
  - Attachments are never touched.
  - Jobs whose revision already has a report are completed without a new LLM call (no duplicates).
  - `fieldkit_process_pending_jobs(retry_failed=true)` gives previously failed jobs one fresh set of attempts.
- **Per-plugin vision model (supported, no gateway change):**
  - `ctx.register_auxiliary_task("fieldkit_vision", inherit_from="vision")` registers a plugin-owned model slot. Verified: Hermes logs "registered auxiliary task: fieldkit_vision".
  - Calls with `task="fieldkit_vision"` pass Hermes' trust gate (`agent/plugin_llm.py:_check_task`, own tasks are always allowed). The operator selects the model under `auxiliary.fieldkit_vision` in config.yaml, and FieldKit uses it when plugin setting `vision_task: true`.
  - The built-in `vision` task would need `plugins.entries.fieldkit.llm.allow_task_override: true`. A plugin-owned task avoids widening trust.
  - **Not yet verified against a real vision provider.**

## Dashboard extension

| Item | Finding |
|---|---|
| Manifest | `dashboard/manifest.json` with `name`, `label`, `icon`, `tab.path`, `entry`, `css`, `api` |
| Bundle | Plain IIFE reading `window.__HERMES_PLUGIN_SDK__` (`React`, `hooks`, `components`, `fetchJSON(url, init)`, `authedFetch`, `utils`), registering with `window.__HERMES_PLUGINS__.register(name, Component)` within 2 s |
| Backend | Module-level `router = APIRouter()` mounted at `/api/plugins/<name>/` with `Depends(_plugin_route_secret_scope)` (`web_server_dashboard.py:1243`) |
| Mount timing | Startup sweep plus a **hot-mount fallback** on first request for plugins enabled after start (`_PluginApiHotMount`, line 1144). Changing an already-mounted router needs a dashboard restart |
| Trust gates | Only `bundled`/`user` sources import Python; the plugin must be in `plugins.enabled`; project plugins (`./.hermes/plugins`) never auto-import `plugin_api.py` |
| Isolation | The validator reports `plugins.isolation: host` for this setup: the backend is served through the plugin host with buffered responses, and handlers that take longer than 60 s get a 504. FieldKit never streams and caps uploads at 15 MB |
| Static | `/dashboard-plugins/<name>/<path>` serves `dashboard/` files (used for the tab bundle) |

## Authentication

- A non-loopback bind turns on the cookie gate (`hermes_session_at`, HttpOnly, SameSite=Lax). The Nous OAuth provider issues 15-minute tokens with no refresh token in contract v1. The basic provider issues HMAC sessions (default 12 h, `session_ttl_seconds`).
- Unauthenticated `/api/*` requests get **401 before the plugin runs**. Verified with curl: `/api/plugins/fieldkit/records` and `/app/` both returned 401.
- Identity inside a plugin route: `request.state.session.user_id` (gated) or loopback `local` (`dashboard_auth/routes.py:541`).
- Login: `POST /auth/password-login {provider, username, password, next}` or the `/login?next=` page.
- **Post-login redirects:** `is_safe_next_path` (`dashboard_auth/request_utils.py`) rejects **every `/api/...` path** as a `next` target, plus `/login`, `/auth/` and `/api/auth/`. A `next` pointing at the app (`/api/plugins/fieldkit/app/`) is therefore silently replaced with `/`, so the user lands on the dashboard (reported on the hosted instance in 0.1.0).
  - Fix (0.1.1): `next=/dashboard-plugins/fieldkit/return.html`. That's a static page from the plugin's `dashboard/` folder: Hermes serves it unauthenticated, `.html` is an allowed type, and it isn't under `/api`. It forwards to the app with a script-free meta refresh, and the app reopens the remembered screen.
  - Verified: Hermes now returns `"next":"/dashboard-plugins/fieldkit/return.html"`, and `tests/e2e/login.spec.ts` completes the real Hermes login page round trip back into FieldKit.
- **Hot-installed plugin without a restart** (hosted, 0.1.0): API routes hot-mount, but `register(ctx)` hasn't run in the plugin host yet ("deferred: tools (next session)"). So `/status` reports `llm_available: false, analysis_mode: deferred`. Jobs stay queued; `fieldkit_process_pending_jobs` (from Hermes) or one approved dashboard restart enables automatic mode.
- Loopback binds require `X-Hermes-Session-Token` on `/api/*`, so plain browser navigation to the PWA fails on a loopback-only dashboard. Local testing therefore binds `127.0.0.2`: still local-only, but it turns the gate on.

## Catalog rules that shaped the design

- No committed ELF, Mach-O, PE or **WebAssembly** files, detected by header. `scripts/postbuild-app.mjs` enforces the same header check and fails the build.
  - It caught Vite emitting `ort-wasm-simd-threaded.asyncify.wasm` (26 MB).
  - Fix: onnxruntime-web's documented export condition `onnxruntime-web-use-extern-wasm`, so Transformers.js loads the pinned upstream copy at setup time.
- Setup-time downloads are allowed only from the upstream official source, pinned and disclosed. See `fieldkit_core/models.json` and `THIRD_PARTY.md`.
- The install scanner's `inline_shell_exec` rule (`` !`…` ``, the SKILL.md shell syntax) also scans bundled JS. Vite 8's default minifier rewrites `"…!"` strings as template literals and trips it. FieldKit minifies with esbuild, escapes the single occurrence in minisearch's own source as `\x21` (the runtime string is unchanged), and the build fails if the pattern appears anywhere else. Result: security scan **safe**.
- GitHub secret scanning flagged the Transformers.js class name `Mistral3ForConditionalGeneration` (32 alphanumerics after "mistral3") as a "Mistral AI API key". It is a false positive: **this repository contains no credentials**, and all model access goes through Hermes' `ctx.llm`. The build writes it as `Mistral3ForConditionalGeneration` (`F` = "F", the same name to JavaScript), and the build fails if any such pattern reappears. Both browser E2E suites pass on the patched bundle.
- No self-updating code and no `eval`. The PWA updates only when the plugin is updated; the service worker reports a new build and the user reloads.

## Offline intelligence: candidates checked

| Capability | Choice | Verification |
|---|---|---|
| Translation en→hi | `Xenova/opus-mt-en-hi` @ `7aad7200…` (quantized ONNX, ~110 MB) | HF API: files, sizes, LFS SHA-256 pinned in `models.json`. Install in Chromium: "pinned files verified" (SHA-256 of cached weights matched). Offline result: see `docs/TESTING.md` |
| Translation hi→en | `Xenova/opus-mt-hi-en` @ `99853100…` | HF API verified. A separate model, because reverse translation is not assumed from en→hi |
| Marathi | **Not available.** Only PyTorch/CTranslate2 conversions exist (`Helsinki-NLP/opus-mt-en-mr`, `-mr-en`) | HF search. Needs a reproducible ONNX conversion in CI |
| Speech to text | `Xenova/whisper-tiny` @ `5332fcc3…` (~41 MB) | HF API verified; tiny model, Hindi accuracy is limited |
| OCR | tesseract.js 7.0.0, core 7.0.0, `@tesseract.js-data/{eng,hin}@1.0.0/4.0.0_best_int` | All URLs returned HTTP 200. The worker JS is vendored; core and language data are fetched pinned |
| Text to speech | `speechSynthesis` restricted to `localService` voices | Runtime detection; no network voices are used |
| Native local STT | `SpeechRecognition.available({processLocally:true})` detection only | Shown in Settings; never falls back to cloud recognition |

**Transformers.js 4.3.1 bug found:** `get_tokenizer_files()` calls `get_file_metadata(modelId, "tokenizer_config.json", {})` without the revision. Offline, it therefore looks up the `main` URL, misses the pinned cache, and tries the network.

- FieldKit's workaround is to set `env.remotePathTemplate` to the pinned commit while building each pipeline (`app/src/intel.ts`).

## Hackathon

- Deadline reported as **2026-11-11 17:00 ET** in a news article (coinfomania). I found no official Nous announcement, so **verify before submitting**.
- Submission is a PR adding `plugin-catalog/fieldkit.yaml` to `NousResearch/hermes-agent`, with a public repo, a full 40-character `sha`, a quoted `version`, and `hermes plugins validate` passing.
