# Codemagic setup

Device builds and distribution of `apps/mobile` (TestFlight / Google Play) run on
Codemagic. The checks (lint / typecheck / test / analyze / golden) live on the GitHub
Actions side, so this is configured **for distribution only**.

The configuration itself is [`codemagic.yaml`](../../codemagic.yaml) at the repository
root.

This page covers the **Codemagic side**. What to do on the receiving side (App Store
Connect / Play Console) — the App ID's capabilities, permissions, privacy declarations,
subscriptions, the RevenueCat integration — is in [`store-setup.md`](./store-setup.md).

## 0. First, switch from the Workflow Editor to YAML

Codemagic starts in the GUI Workflow Editor.
Left that way, `codemagic.yaml` is never read.

**Applications > ai-sensei > Workflow Editor > "Switch to YAML configuration"**

After switching, `codemagic.yaml`'s `workflows:` appear in the list directly
(`iOS — TestFlight` and `Android — Play internal`).
Anything configured in the GUI ("Build for platforms", "Run build on") is no longer used.

## 1. Variable groups

Create them under **Teams/Personal Account > Environment variables**.
Both carry values that reach the app via `--dart-define`.

### `mobile-dart-defines` (used by both workflows)

| Variable | Example | Required | Secret |
| --- | --- | --- | --- |
| `API_BASE_URL` | `https://api.example.workers.dev` | Yes | No |
| `REVENUECAT_IOS_PUBLIC_SDK_KEY` | `appl_xxx` | Once products exist in the store | No (public key) |
| `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` | `goog_xxx` | Once products exist in the store | No (public key) |
| `REVENUECAT_SDK_KEY` | `test_xxx` | A stand-in until then | No (public key) |
| `REVENUECAT_ENTITLEMENT_ID` | `premium` | Optional (defaults to `premium`) | No |
| `REVENUECAT_OFFERING_ID` | | Optional (empty means current) | No |

All of these are read by `lib/` through `String.fromEnvironment`.
They go into the app binary, so **never put a secret key here** (LiveKit and LLM keys
belong on the server, under `wrangler secret`).

**Distribution works before the store products exist.** `appl_` / `goog_` keys can only
be issued after products are created in App Store Connect / Play Console, so until then
the Test Store key (`REVENUECAT_SDK_KEY`) alone is enough for the build to pass.
The app also falls back to the Test Store key when the per-platform key is empty
(`apiKeyFor` in `revenuecat_config.dart`). Such a build is not a real sale, so a warning
appears in the first step's log.

**The group name must match `mobile-dart-defines` exactly and be attached to the app.**
Miss either and the variables never arrive, failing the build's first step,
"Check the dart-define environment variables are present"
(before that check existed, it failed ten-plus minutes later in the final
`flutter build` with `API_BASE_URL: unbound variable`).

That check only inspects **the keys for the platform that workflow builds** (`appl_` for
the iOS workflow, `goog_` for Android). It decides from `environment.vars.TARGET_PLATFORM`
in `codemagic.yaml`, so set that variable too when adding a workflow.

### `ios-code-signing` (iOS only)

| Variable | Content | Secure |
| --- | --- | --- |
| `CERTIFICATE_PRIVATE_KEY` | The RSA private key embedded in the distribution certificate (the full PEM) | ✅ |

**The only variable in this repository holding a real private key.** How to create it,
and what happens if it is missing, is in [2. iOS signing](#certificate_private_key-is-required).

### `google-play` (Android only)

| Variable | Content | Secure |
| --- | --- | --- |
| `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` | Play Console's service-account JSON (in full) | ✅ |

## 2. iOS signing

Register an API key under
**Integrations > Apple Developer Portal > App Store Connect**.
The name must match **`codemagic`**, as written in `codemagic.yaml` (it is referenced by
name). It happens to be the same string as the file name, which is confusing, but what it
points at is **the display name given to the API key**.

What is needed (issued at App Store Connect > Users and Access > Integrations):

- Issuer ID
- Key ID
- `AuthKey_XXXXXXXX.p8`
- A role of **App Manager** or above

The issuing procedure is written screen by screen in
[`store-setup.md`'s 1-3-1](./store-setup.md).
The one thing to watch is that it is **App Store Connect's Keys, not Apple Developer's**.

Certificates and provisioning profiles need not be created by hand.
`codemagic.yaml`'s scripts step
**`Fetch signing files from Apple and apply them to the Xcode project`** uses that API key
to fetch them from Apple, creating them if absent.

```
keychain initialize                      # prepare the keychain
app-store-connect fetch-signing-files …  # fetch or create from Apple
keychain add-certificates                # put the certificates into the keychain
xcode-project use-profiles --project …   # apply to the Xcode project and
                                         # write export_options.plist
```

`use-profiles` is given `--project ios/Runner.xcodeproj` because, omitted, it searches
`**/*.xcodeproj` from the clone's root and can silently miss an iOS project living at
`apps/mobile/ios` as it does here. When it misses, `$HOME/export_options.plist` is never
written and the final `flutter build ipa` fails with
`"/Users/builder/export_options.plist" property list does not exist`.

### Do not use `environment.ios_signing`

> **Despite the name, `ios_signing` is not automatic signing.**
> It means "from the signing files **already uploaded to the Codemagic UI**, pick one
> matching `distribution_type` and `bundle_identifier`"
> ("uploaded signing files" in the
> [Codemagic docs](https://docs.codemagic.io/yaml-code-signing/signing-ios/)).
> **That is manual signing**, with **the UI's files** - not the Developer Portal - as the
> source of truth.

While this was mistaken for automatic signing, what was actually used was the
`aisenseiprd` uploaded by hand to the Codemagic UI.
That profile had been created without App Groups, so once the NSE arrived it started
failing with

```
Provisioning profile "aisenseiprd" doesn't include the App Groups capability
```

and **no amount of fixing the Developer Portal helped** - the UI's file is separate from
the Portal, so Portal changes never reach it.

Adding `ios_signing` back **mixes both schemes** with the scripts' `fetch-signing-files`.
Mixed, it fails with
`No matching profiles found for bundle identifier ... and distribution type "app_store"`,
so do not add it.

### CERTIFICATE_PRIVATE_KEY is required

Put `CERTIFICATE_PRIVATE_KEY` into the **`ios-code-signing`** variable group **as
Secure**. It is the private key embedded in the distribution certificate, and the only
real private key here.

To create it:

```
ssh-keygen -t rsa -b 2048 -m PEM -f ios_distribution_private_key -q -N ""
```

Open the resulting `ios_distribution_private_key` (the one with no extension) in a text
editor and paste **the whole thing** as the value, including the
`-----BEGIN RSA PRIVATE KEY-----` / `-----END RSA PRIVATE KEY-----` lines. <!-- pragma: allowlist secret -->

**Without it, a new distribution certificate is created on every build.**
A team can hold only so many Distribution certificates, so a few builds hit the cap and
issuing fails from then on. That is why the signing step reads this variable first and
fails immediately when it is missing.

### Profiles are inspected before use

In the same step, before calling `use-profiles`, it **reads the profiles' entitlements**
and checks two things.

- That the profiles for both the app (`jp.co.aiSensei`) and the **Notification Service
  Extension** (`jp.co.aiSensei.OneSignalNotificationServiceExtension`) were downloaded
- That the profile allows the **App Group** `Runner.entitlements` requires

Since the extension arrived, "at least one profile exists" is no longer enough.
Proceeding without them fails only after the whole Xcode archive (minutes) with

```
Provisioning profile "aisenseiprd" doesn't include the App Groups capability.
Signing for "OneSignalNotificationServiceExtension" requires a development team.
```

The fix is **on the Developer Portal side, not in this repository**, so the check fails
early and logs what is missing.
The Portal-side procedure is in
[`store-setup.md`'s 1-2-1](./store-setup.md).

### Do not create them by hand

**Do not run Generate a Provisioning Profile in the Developer Portal by hand.**
Three reasons.

- **The distribution certificate's private key stays on your machine.**
  A distribution certificate created on a Mac keeps its private key in that Mac's
  keychain, unusable from Codemagic. The build machine can download the certificate but
  has no key, and fails with `Cannot save Signing Certificates without certificate
  private key`.
- **It wastes a distribution certificate slot.** A team can hold only so many
  Distribution certificates. Creating one by hand and letting CI create another consumes
  two, and hitting the cap makes issuing fail outright.
- **The type is easy to get wrong.** What is needed is a
  **Distribution > App Store Connect** profile. Choosing Development lists only
  development certificates under Select Certificates, and the result cannot be used for
  `app_store` distribution.

> **"The device is not in the list" is not a problem.**
> Device registration is needed only for Development and Ad Hoc profiles;
> **an App Store distribution profile has no devices**.
> There is no need to register the CI Mac as a device.

**Delete profiles already created by hand (e.g. `aisenseiprd`).**
Automatic signing reuses any existing profile that matches, so leaving one produces "the
Portal's App ID is fixed but only the build keeps failing" - a profile **bakes in the
capabilities as of its creation**, so adding App Groups later never reaches an old one.
**Delete it from Profiles** and the next build's automatic signing recreates it with the
current capabilities.

### Keep Codemagic UI's "Code signing identities" empty

Codemagic UI's **Available provisioning profiles / iOS certificates** (the iOS side) is
**the place for manual signing, with files you uploaded yourself**.

> **What you put here is not "unused" - putting it here makes it get used.**
> This document once said "`codemagic.yaml` does not reference it, so anything here is
> unused". That was **backwards**. `environment.ios_signing` is precisely the setting that
> looks here, and the hand-uploaded `aisenseiprd` really was used on every build. That is
> the source of the awkward symptom where **fixing the Developer Portal changes nothing**.

`ios_signing` is no longer written, so this screen's files are unused.
But **leaving them invites the same trap next time**, so delete the iOS profiles and
certificates and keep it empty (the Android keystore is different - see below).

**What automatic signing used does not appear on this screen.**
Profiles and certificates are only "fetched from Apple's Developer Portal and downloaded
onto the build machine"; they are not stored in Codemagic.

To check, look in two places:

- The build log's **`Fetch signing files from Apple and apply them to the Xcode project`**
  step — it shows what was fetched and what went into the keychain
- **[developer.apple.com](https://developer.apple.com) >
  Certificates, Identifiers & Profiles > Profiles** — after a build, a new App Store
  profile for `jp.co.aiSensei` appears

> The Android keystore (`ai-sensei-upload-keystore`) is the opposite: **what is in the
> Codemagic UI is used**. Only iOS goes through the API, so the two are asymmetric.

### Running a build to check something

`ios-testflight`'s only automatic trigger is **a push to `develop`**.
To try a change on a PR branch, run it manually from the Codemagic UI's
**Start new build**, choosing the branch and the workflow (the `codemagic.yaml` from the
chosen branch is read).

> **Signing is done solely by the scripts' `fetch-signing-files`.**
> For a while this was removed in favour of `environment.ios_signing` alone, which is
> manual signing from UI files rather than automatic signing, and that produced the
> "fixing the Portal changes nothing" state (see the box above).
> What broke when the two were once used together was **mixing manual and automatic
> signing**, not a problem with `fetch-signing-files`.
> Do not mix them.

An app record with the same bundle id must exist in App Store Connect. Without it,
`flutter build ipa` succeeds and the upload fails.

## 3. Android signing

Upload the upload keystore under
**Settings > Code signing identities > Android keystores**.
The reference name is **`ai-sensei-upload-keystore`**, as in `codemagic.yaml`.

If you do not have one:

```bash
keytool -genkey -v -keystore upload-keystore.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

During the build, `codemagic.yaml` writes `apps/mobile/android/key.properties`, and
`android/app/build.gradle.kts` reads it for release signing.
**Never commit `key.properties` or `*.jks`** (excluded in `android/.gitignore`).

## 4. Triggers

| workflow | When it runs | Output |
| --- | --- | --- |
| `ios-testflight` | A push to `develop` | TestFlight (internal testers) |
| `android-internal` | A `v*` tag | Play internal track (draft) |

iOS goes first, per the README, so only iOS runs automatically.
Android runs when needed, by pushing a tag or via "Start new build" in the UI.

If uploading to TestFlight on every push to `develop` is too much, change
`triggering.branch_patterns` in `codemagic.yaml` to `main`, or change `events` to `tag`.

## 5. Versions

- **The version name** (the `1.2.3` part) is authoritative in `apps/mobile/pubspec.yaml`'s
  `version`. To bump it, edit and commit there.
- **The build number** is overridden with Codemagic's counter
  (`$PROJECT_BUILD_NUMBER`), because TestFlight rejects a re-upload with the same build
  number.

## 6. The Flutter version

`apps/mobile/.fvmrc` (= local fvm, = GitHub Actions) is authoritative.
Codemagic cannot take the SDK version from an environment variable or a file, so
`definitions.flutter_version` in `codemagic.yaml` **repeats the same value by hand**.

On drift, the first step (`Check the SDK version matches .fvmrc`) fails the build, so
there is no way to distribute a different version unnoticed.
Bump `codemagic.yaml` together with `.fvmrc`.

## 7. Why golden tests do not run on Codemagic

Goldens treat **Linux rasterization as authoritative**
([`apps/mobile/test/golden/README.md`](../../apps/mobile/test/golden/README.md)).
Codemagic runs macOS instances, so running them there always fails on font rendering
differences.

So golden tests carry the `golden` tag (`@Tags` in
`apps/mobile/test/golden/screens_golden_test.dart`), and Codemagic excludes them with
`flutter test --exclude-tags golden`.
The authoritative golden run is GitHub Actions (ubuntu-latest).

## Common stumbling blocks

- **`codemagic.yaml` is ignored** -> step 0's YAML switch was not done.
- **`Provisioning profile ... doesn't include signing certificate`**
  -> the App Store Connect API key's role is below App Manager.
- **`No matching profiles found for bundle identifier "..." and distribution type "app_store"`**
  -> see "When no profile is found" below.
- **`"/Users/builder/export_options.plist" property list does not exist`**
  -> the built-in signing step could not find `apps/mobile/ios/Runner.xcodeproj` and
     passed without writing the plist. The scripts' step that applies signing to the
     Xcode project and writes `export_options.plist` fills that in (see "2. iOS signing").
     If that step fails with "no provisioning profile was downloaded", the cause is the
     fetch, not the plist - go to "When no profile is found" below.
- **The AAB is rejected by Play (`not signed`)**
  -> the keystore's reference name does not match `ai-sensei-upload-keystore`.
     Mismatched, `key.properties` is never written and signing falls back to debug.

## When no profile is found

```
No matching profiles found for bundle identifier "jp.co.aiSensei"
and distribution type "app_store"
```

It means Codemagic asked App Store Connect for "a distribution profile for
`jp.co.aiSensei`" and Apple **returned nothing**.

Check in this order:

### 1. Is the Identifier registered (most common)

Look for `jp.co.aiSensei` under
**[developer.apple.com](https://developer.apple.com) > Certificates, Identifiers &
Profiles > Identifiers**.

- **It is case-sensitive.** `jp.co.aisensei` is a different thing and will not match
- **It must be registered as Explicit.** A wildcard (`jp.co.*`) cannot be used for an
  `app_store` distribution profile

> **Creating an app in App Store Connect and registering an Identifier in the Developer
> Portal are two different tasks.**
> The Identifier comes first, and the app record is created by choosing it. You cannot
> end up with an app record and no Identifier, but if **neither exists**, start here.

### 2. Are the API key and the Identifier in the same team

When an Apple ID belongs to several teams, **the Issuer ID decides the team**.
An Identifier created in another team is invisible to the API key and will not match.
Check the team on the Identifier's page.

### 3. The API key's role

It must be **App Manager or above**. A Developer role can read but **cannot create**, so
it produces the same "not found" error. The role can be changed later.

### 4. The distribution certificate quota

If the team's Distribution certificates are at the cap, no certificate can be created and
it fails. Revoke unused ones under Certificates.

### Reading the log

The signing step's log before the scripts shows **what Codemagic found, what it tried to
fetch, and why it failed**. Reasons for 1-4 above appear there, so there is no need to
guess.

Wording like `Not enough permissions` means 3; `Bundle ID ... not found` means 1; anything
about the certificate cap means 4.

### When you want to recreate a profile

Automatic signing **only fetches what exists**; it does not create what does not.
To force creation, add a temporary step to `codemagic.yaml`:

```yaml
- name: Create the signing files (add temporarily)
  script: |
    app-store-connect fetch-signing-files "$BUNDLE_ID" \
      --type IOS_APP_STORE \
      --certificate-key=@env:CERTIFICATE_PRIVATE_KEY \
      --create
```

**Do not omit `--certificate-key`.** Omitted, it fails in two ways.

- If a distribution certificate already exists in the Developer Portal, it is picked up
  but has no private key, failing with `Cannot save Signing Certificates without
  certificate private key`
- If none exists, a certificate is created with a new key on every build, quickly hitting
  the quota (point 4)

Create the key once, put it into Codemagic's secure environment variable
`CERTIFICATE_PRIVATE_KEY`, and reuse it:

```
ssh-keygen -t rsa -b 2048 -m PEM -f cert_key -q -N ""
```

Remove the step once it has done its job.
