# dart_defines/

Where the **JSON** files of `--dart-define` values live. Flutter's
`--dart-define-from-file` reads `*.json` from this directory directly.

```bash
cp dart_defines/local.example.json dart_defines/local.json
tool/run.sh --debug --dart_define=local
```

Bypassing `tool/run.sh` and calling Flutter directly is the same thing:

```bash
fvm flutter run --debug --dart-define-from-file=dart_defines/local.json
```

Any `.json` other than `*.example.json` is **not committed** (root `.gitignore`).
To add an environment, add `staging.json` / `prod.json` and so on;
`tool/run.sh --dart_define=staging` picks them up.

## What may go in here

**Public values only.** `--dart-define` values are embedded in the build artifact
and readable by disassembly. Do not put a single secret key here (those belong on
the server, in `backend/`).

JSON has no comments, so the keys are documented below.

| Key | Meaning |
| --- | --- |
| `API_BASE_URL` | `backend/api`'s URL. Locally `http://localhost:8787`. To reach your machine from a device, its LAN IP (e.g. `http://192.168.1.10:8787`). Empty falls back to `http://localhost:8787` |
| `REVENUECAT_IOS_PUBLIC_SDK_KEY` | RevenueCat's iOS public key (starts with `appl_`). For production, once products exist in the store |
| `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` | The same for Android (starts with `goog_`) |
| `REVENUECAT_SDK_KEY` | The Test Store key (starts with `test_`). RevenueCat's simulated store, which lets the purchase flow run end to end before products exist in App Store Connect / Play Console. **The same value for iOS and Android.** Used only when both keys above are empty |
| `REVENUECAT_ENTITLEMENT_ID` | The dashboard's Entitlement identifier (not the display name). Empty means `premium`. Get this wrong and purchases succeed while nothing unlocks |
| `REVENUECAT_OFFERING_ID` | Only when showing an Offering other than the default (for price experiments). Empty means current |
| `ONESIGNAL_APP_ID` | Push reception. The App ID is a public value. Keep it **identical** to `backend/api`'s `ONESIGNAL_APP_ID`. The app (`PushConfig` in `push_repository.dart`) has no default, so **an empty build disables notifications entirely** (no init, no device registration). The REST API Key lives on the server and never here |
| `SENTRY_DSN` | Monitoring for crashes and degradations (plan §10-7). A DSN is meant to be public and need not be secure. The app (`SentryConfig` in `src/telemetry/telemetry.dart`) has no default, so **an empty build disables monitoring entirely** (the SDK is not initialised). Take the value from Sentry's project settings > Client Keys (DSN) |
| `PRIVACY_POLICY_URL` | The link shown from the settings screen. `https://ubiqy.jp/privacy/` (the same as declared in both stores). While empty, the row does not appear at all (no rows that do nothing when tapped). With a subscription in the app, review will always look for it |
| `TERMS_URL` | As above. `https://ubiqy.jp/terms/` |
| `SUPPORT_EMAIL` | Where to report a bad explanation, board or question from the senpai. Required as a route for an app containing AI-generated content |

Values may only be strings, numbers or booleans (Flutter rejects nested objects and
arrays; `tool/run.sh` checks for that and fails before passing them on).

## Relation to CI

Codemagic does not read these files. The build machine's environment variables
(the `mobile-dart-defines` variable group) are expanded into `--dart-define=` by
`codemagic.yaml`. **Adding a key here means adding it there too** - forget and it
works locally while the distributed build gets an empty value.
