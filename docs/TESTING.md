# Testing FieldKit

## Unit and API tests

```bash
uv venv .venv --python 3.11 && uv pip install --python .venv fastapi httpx pytest jsonschema pyyaml python-multipart
.venv/Scripts/python -m pytest        # Python: engine, plugin API, sync, tools, skills
npm ci --legacy-peer-deps
npm test                              # TypeScript: phone engine, sync queue, storage, backup
npm run typecheck
```

The Python and TypeScript form engines are checked against the same test vectors in `tests/vectors`.

## Plugin checks

Use a temporary `HERMES_HOME` so nothing touches a real install.

```bash
export HERMES_HOME=<temporary folder>
hermes plugins validate .
hermes plugins doctor . --ci            # expects 12 tools, 0 hooks
```

## Browser end-to-end tests

These run in real browsers (Playwright) against a real Hermes dashboard with FieldKit installed.

1. Make a throwaway Hermes home with FieldKit in `plugins/fieldkit` and this `config.yaml`:
   `plugins.enabled: [fieldkit]` and `dashboard.basic_auth.{username, password, secret}`.
2. Start its dashboard. Binding `127.0.0.2` turns on Hermes' sign-in gate while staying on your machine:
   ```bash
   HERMES_HOME=<throwaway home> hermes dashboard --host 127.0.0.2 --port 9300 --isolated --no-open --skip-build
   ```
3. Run the tests:
   ```bash
   FIELDKIT_E2E_PASS=<password> FIELDKIT_E2E_DATA_DIR=<throwaway home>/plugin-data/fieldkit npm run test:e2e
   FIELDKIT_E2E_BROWSER=webkit FIELDKIT_E2E_PASS=<password> FIELDKIT_E2E_DATA_DIR=... npm run test:e2e
   ```

| Variable | Meaning |
|---|---|
| `FIELDKIT_E2E_BASE` | Dashboard address (default `http://127.0.0.2:9300`) |
| `FIELDKIT_E2E_USER`, `FIELDKIT_E2E_PASS` | Dashboard sign-in (user defaults to `demo`) |
| `FIELDKIT_E2E_DATA_DIR` | The test Hermes' FieldKit data folder; the synthetic test workspaces are seeded into it |
| `FIELDKIT_E2E_BROWSER` | `webkit` to run on Safari's engine (default Chromium) |
| `FIELDKIT_E2E_MODELS` | `1` to also install and test the offline translation and OCR packs (downloads about 115 MB) |

Some failure cases use Playwright `route()` to block service-worker traffic, which WebKit does not support, so they
run in Chromium only.

## OCR and translation accuracy

Scripts that score the offline OCR and translation packs on synthetic photos and sentences are in
[tests/eval](../tests/eval/README.md).
