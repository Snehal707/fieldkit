# FieldKit — Research notes (verified Hermes interfaces)

Everything below was checked against the **Hermes Agent v0.23.0 source** and the official docs on 2026-11-08, and
re-checked with **v0.23.1**: plugin validate and doctor pass, 12 tools, 0 hooks (FieldKit 0.3.2). "Verified" means read in
source or exercised by a test in this repository.

**FieldKit 0.3.x uses no `ctx.llm`.** FieldKit never calls a model; Hermes reads synced data only when the user asks.

## Plugin packaging

| Item | Finding | How verified |
|---|---|---|
| Manifest | `plugin.yaml` with `name`, `version`, `description`, `provides_tools`, `provides_hooks`, `requires_hermes`, `python_dependencies`, `config_keys` | `hermes plugins validate` passes |
| Entry point | `__init__.py` defining `register(ctx)` | `hermes plugins doctor --ci` ran discovery, import and registration: 12 tools, 0 hooks (0.3.2) |
| Tools | `ctx.register_tool(name, toolset, schema, handler, check_fn=None, …, description=…)`; handler `(args: dict, **kw) -> str` (JSON) | `hermes_cli/plugins.py:463`; validator "declared tools — matches registrations" |
| Skill | `ctx.register_skill(name, path, description=…)` → resolvable as `fieldkit:fieldkit` | `hermes_cli/plugins_content.py:32` |
| Hooks | `on_session_start` is in `VALID_HOOKS`; callbacks must accept `**kwargs`. FieldKit 0.3.x registers no hook | `hermes_cli/plugins.py:109`, `plugin_dev.py:476` |
| Storage | `plugins.plugin_storage.plugin_data_dir(name)` → `<HERMES_HOME>/plugin-data/<name>/`; `plugin_db(name)` → SQLite in WAL mode, `check_same_thread=False`, and the caller owns transactions | `plugins/plugin_storage.py` |
| `register()` side effects | Must not open files or start threads. `register()` in 0.3.x opens no database; the store opens on first use. The doctor runs in a temporary `HERMES_HOME`, and its cleanup fails on Windows if a database is still open | Observed in an earlier version, then fixed by opening the store lazily |

## Host LLM

- Not used. FieldKit 0.3.x uses no `ctx.llm`, and FieldKit never calls a model.

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
- **Hot-installed plugin without a restart** (hosted, 0.1.0): API routes hot-mount, but `register(ctx)` hasn't run in the plugin host yet ("deferred: tools (next session)"). The tools appear in the next session or after a restart.
- Loopback binds require `X-Hermes-Session-Token` on `/api/*`, so plain browser navigation to the PWA fails on a loopback-only dashboard. Local testing therefore binds `127.0.0.2`: still local-only, but it turns the gate on.

## Catalog rules that shaped the design

- No committed ELF, Mach-O, PE or **WebAssembly** files, detected by header. `scripts/postbuild-app.mjs` enforces the same header check and fails the build.
  - It caught Vite emitting `ort-wasm-simd-threaded.asyncify.wasm` (26 MB).
  - Fix: onnxruntime-web's documented export condition `onnxruntime-web-use-extern-wasm`, so Transformers.js loads the pinned upstream copy at setup time.
- Setup-time downloads are allowed only from the upstream official source, pinned and disclosed. See `fieldkit_core/models.json` and `THIRD_PARTY.md`.
- The install scanner's `inline_shell_exec` rule (`` !`…` ``, the SKILL.md shell syntax) also scans bundled JS. Vite 8's default minifier rewrites `"…!"` strings as template literals and trips it. FieldKit minifies with esbuild, and the build fails if the pattern appears anywhere in the bundle. Result: security scan **safe**.
- GitHub secret scanning flagged the Transformers.js class name `Mistral3ForConditionalGeneration` (32 alphanumerics after "mistral3") as a "Mistral AI API key". It is a false positive: **this repository contains no credentials**, and the plugin makes no model calls. The build writes it as `Mistral3ForConditionalGeneration` (`F` is "F", so JavaScript reads the same name), and the build fails if any such pattern reappears. Both browser E2E suites pass on the patched bundle.
- No self-updating code and no `eval`. The PWA updates only when the plugin is updated; the service worker reports a new build and the user reloads.

## Offline translation and OCR: candidates checked

| Capability | Choice | Verification |
|---|---|---|
| Translation en→hi | `Xenova/opus-mt-en-hi` @ `7aad7200…` (quantized ONNX, ~110 MB) | HF API: files, sizes, LFS SHA-256 pinned in `models.json`. Install in Chromium: "pinned files verified" (SHA-256 of cached weights matched). Offline result: see `docs/TESTING.md` |
| Translation hi→en | `Xenova/opus-mt-hi-en` @ `99853100…` | HF API verified. A separate model, because reverse translation is not assumed from en→hi |
| Marathi | **Not available.** Only PyTorch/CTranslate2 conversions exist (`Helsinki-NLP/opus-mt-en-mr`, `-mr-en`) | HF search. Needs a reproducible ONNX conversion in CI |
| OCR | tesseract.js 7.0.0, core 7.0.0, `@tesseract.js-data/{eng,hin}@1.0.0/4.0.0_best_int` | All URLs returned HTTP 200. The worker JS is vendored; core and language data are fetched pinned. 0.2.4 changed how images are prepared and which page-segmentation mode is used (see `docs/TESTING.md`) |

**Translation and Transformers.js findings (0.2.4 measurements, `tests/eval`, Node):**
- **NLLB-600M (895 MB) and M2M100 (632 MB) are too large** for a phone web app, so OPUS-MT stays.
- **fp32 translation is not worth it:** en→hi fp32 44.6 chrF vs q8 41.5, at four times the download.
- **Beam search is effectively greedy** in Transformers.js 4.3.1. `app/src/translate_prep.ts` splits sentences and fixes Hindi sentence endings; its term protection applies only to dictionary packs a phone installed before 0.3.

**Transformers.js 4.3.1 bug found:** `get_tokenizer_files()` calls `get_file_metadata(modelId, "tokenizer_config.json", {})` without the revision. Offline, it therefore looks up the `main` URL, misses the pinned cache, and tries the network.

- FieldKit's workaround is to set `env.remotePathTemplate` to the pinned commit while building each pipeline (`app/src/intel.ts`).

## Hermes facilities used (0.3.x)

| Facility | Used for | Verification |
|---|---|---|
| `ctx.register_system_prompt_section("fieldkit.workspace", …)` | Each new Hermes session is told which workspaces the user has (or offered a setup), in a bounded text | Registered in `__init__.py` with a bounded text (`fieldkit_core/workspace.py`) |
| Skills (`ctx.register_skill`) | `fieldkit` (find and read entries) and `fieldkit-workspace-builder` (set up, change, undo) | Registered in `__init__.py`; `hermes plugins validate` passes |
| `ctx.register_tool` | 12 tools | `hermes plugins doctor . --ci`: 12 tools, 0 hooks (0.3.2) |
| Hermes' own vision and speech-to-text tools | Used by the user's Hermes agent on photos and voice notes (`fieldkit_get_attachment` returns a local file) | Real conversation on a local test Hermes v0.23.0, 2026-11-10 (see `docs/TESTING.md`) |

## Hackathon

- Deadline reported as **2026-11-11 17:00 ET** (2026-11-12 03:30 IST). Confirm it against the official announcement.
- Submission is a PR adding `plugin-catalog/fieldkit.yaml` to `NousResearch/hermes-agent`, with a public repo, a full 40-character `sha`, a quoted `version`, and `hermes plugins validate` passing.
