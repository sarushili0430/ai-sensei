# Store-side setup (Apple / Google)

Configuration on the receiving end of whatever `codemagic.yaml` builds.
For the Codemagic side, see [`codemagic.md`](./codemagic.md).

| | Identifier |
| --- | --- |
| iOS | `jp.co.aiSensei` |
| Android | `jp.co.aiSensei` |

---

## 0. Decide these first

Only the things that force a redo if done in the wrong order.

### 0-1. Does the audience include under-13s (13 in the US; minors in practice in Japan)?

**This one matters most.** Targeting "13+" for middle and high schoolers versus including elementary
schoolers changes which policies apply on both stores.

If elementary schoolers are included:

- **Apple**: treated as Kids Category. Third-party analytics and ad SDKs are restricted, and external links
  need a parental gate. **We would have to revisit Sentry and OneSignal.**
- **Google**: the Families program applies. Every SDK needs a families self-certification, and collecting
  the advertising ID is banned.

To ship as-is with the current dependencies (Sentry / OneSignal), the answer is **13+**. Decide before
submitting — otherwise "please remove the SDK" mid-review means a rebuild.

### 0-2. Privacy policy URL

**Required by both stores.** Without a live page you cannot submit. State what photos, audio and anonymous
device IDs are collected for, where they are stored, and when they are deleted.

**Settled** (the same URLs go in both store declarations and in `--dart-define`):

| | URL |
| --- | --- |
| Privacy policy | `https://ubiqy.jp/privacy/` |
| Terms of service | `https://ubiqy.jp/terms/` |

`apps/lp/public/{privacy,terms}/` carries equivalent pages. **A mismatch between the two is a mismatch
between declaration and reality**, so pick one canonical published copy and point the other at it (the LP
side is undecided).

### 0-3. Retention period for photos and conversations

This determines what goes in the declarations (1-7 / 2-6), so decide the policy first. Reading the current
code:

- Notebook photos **stay** in R2 under `photos/{deviceId}/{sessionId}`
  (`backend/api/src/routes/sessions.ts:105`). No deletion path is present.
- Conversation transcripts feed karte generation (`backend/agent/src/transcript.ts`).

"We don't delete them" is a fine answer as long as that's what we declare — it is not itself a violation.
**The dangerous case is a declaration that disagrees with the implementation** (grounds for removal on both
stores).

### 0-4. Subscription contents

Price, period (monthly or yearly), and whether there's a free trial. The same thing gets created in three
places (both stores and RevenueCat), so settle it on paper first.

---

## 1. Apple

### 1-1. Apple Developer Program

$99/year (organizations need a D-U-N-S number, which takes days to weeks to issue). If registering as an
Organization, **this is the long pole** — start here.

### 1-2. Certificates, Identifiers & Profiles → Identifiers

Create `jp.co.aiSensei` as an **Explicit** App ID under **Identifiers > + > App IDs > App**.

> **This is separate from "create the app" in 1-4, and comes first.**
> Without the Identifier, Codemagic signing fails with
> `No matching profiles found for bundle identifier ...`.
> Automatic signing can create profiles and certificates, but **it will not register the Identifier**.
> It is case-sensitive too: register `jp.co.aiSensei`, not `jp.co.aisensei`.

Capabilities this app **touches**:

| Capability | Setting | Why |
| --- | --- | --- |
| In-App Purchase | On (on by default) | `purchases_flutter` |
| Push Notifications | **Turn on** | `onesignal_flutter`. Off by default |
| App Groups | **Turn on** | Shared with OneSignal's Notification Service Extension (1-2-1) |

> **In-App Purchase is also recorded on the Xcode side.**
> The Runner target's `SystemCapabilities` in `apps/mobile/ios/Runner.xcodeproj` contains
> `com.apple.InAppPurchase` (the same state as adding **In-App Purchase** in Xcode's Signing &
> Capabilities). This capability adds no entitlement keys — i.e. `Runner.entitlements` won't tell you
> whether it's there, so check `project.pbxproj` instead.
> Automatic signing reads this to align the App ID's capabilities, so keep the record even though the portal
> enables it by default.

**What we don't touch** (adding these just invites review questions):

Sign in with Apple (no accounts), Associated Domains, HealthKit, Maps, Wallet, iCloud, Game Center, NFC,
Apple Pay — all unused.

> Background Modes is not an App ID capability; it's an Info.plist / Xcode setting. See 1-9.

### 1-2-1. The App Group, and the extension's own Identifier

The app ships OneSignal's **Notification Service Extension**
(`ios/OneSignalNotificationServiceExtension/`). It is **signed with its own bundle ID and its own profile**,
so it needs its own Identifier. The two exchange values through an App Group, which makes **three things to
register**.

Register them in this order (reversed, you get either no group to assign or an Identifier that can't hold
one).

1. **Identifiers > + > App Groups** — create `group.jp.co.aiSensei.onesignal`
2. Open **App ID `jp.co.aiSensei`**, tick the **App Groups** capability, and assign the group from step 1
   via `Edit`
3. **Identifiers > + > App IDs > App** — create
   `jp.co.aiSensei.OneSignalNotificationServiceExtension` as **Explicit** and assign the same group under
   **App Groups** (it needs neither Push Notifications nor In-App Purchase)

The two entitlements files in the repo are authoritative for the group name, and **one character of
difference across the three places fails the build**:

- `apps/mobile/ios/Runner/Runner.entitlements`
- `apps/mobile/ios/OneSignalNotificationServiceExtension/OneSignalNotificationServiceExtension.entitlements`
- The App Group in the Developer Portal

> **After adding a capability, delete the existing provisioning profiles.**
> A profile bakes in the capabilities as of its creation, so fixing the App ID afterwards leaves
> **existing profiles stale**, and Codemagic's automatic signing happily reuses them. The portal looks
> correct while builds keep failing with
> `Provisioning profile "..." doesn't include the App Groups capability`.
> **Delete them from Profiles** and automatic signing recreates them on the next build.

Without all three, `flutter build ipa` fails *after* Xcode has finished archiving:

| What the log says | What's missing |
| --- | --- |
| `doesn't include the App Groups capability` | 2 (App Groups not on the App ID, or a stale profile) |
| `doesn't support the group.jp.co.aiSensei.onesignal App Group` | 1 (group not created) or the assignment in 2 |
| `Signing for "OneSignalNotificationServiceExtension" requires a development team` | 3 (no Identifier for the extension, so no profile) |

The signing step in `codemagic.yaml` checks the same things **before archiving**, so in practice the log
tells you which of the above is missing well before this point.

### 1-3. There are three kinds of key (get the difference straight first)

Three different files share the `.p8` extension, and **each is issued somewhere different**. Mixing them up
is the most common accident, so:

| Key | Created at | Purpose | Given to |
| --- | --- | --- | --- |
| **App Store Connect API Key** | App Store Connect > Users and Access > Integrations | Signing and uploading builds | Codemagic |
| In-App Purchase Key | Same page, different tab | Purchase receipt validation | RevenueCat (1-10) |
| APNs Auth Key | **Apple Developer** (a different site) > Keys | Push notifications | OneSignal |

Only the **first one, the App Store Connect API Key**, is needed right now.

> **Common mistake**: "Certificates, Identifiers & Profiles > Keys" on Apple Developer
> (developer.apple.com) issues APNs keys and the like — **the App Store Connect API Key is not there.**
> Create it on the separate App Store Connect site (appstoreconnect.apple.com).

### 1-3-1. Issuing the App Store Connect API Key

#### Steps

1. Sign in to **[appstoreconnect.apple.com](https://appstoreconnect.apple.com)**
2. Open **Users and Access** at the top
3. Select the **Integrations** tab
4. Pick **App Store Connect API** in the left-hand list
5. Confirm you're on the **Team Keys** tab
   - Individual Keys are tied to a person. **Don't use them for CI** (the key dies with their membership)
6. Press **+**
7. Fill in

   | Field | Value |
   | --- | --- |
   | Name | Anything recognisable later, e.g. `Codemagic` |
   | Access (role) | **App Manager** |

8. Press **Generate**

#### What to record (three items)

Take these three from the listing after generation. **These three go into Codemagic.**

| | Where it is | Shape |
| --- | --- | --- |
| **Issuer ID** | One line at the **top** of the page (outside the key list) | A UUID such as `6a7b...` |
| **Key ID** | The key's row | 10 alphanumeric characters |
| **API key (.p8)** | "Download API Key" at the right of the row | `AuthKey_XXXXXXXXXX.p8` |

> **The `.p8` downloads exactly once.**
> Close the page and it's gone forever, so store it in a password manager immediately.
> If lost, revoke it and issue a new one (you can do that any number of times).

> **The Issuer ID is easy to miss.** It's one per team rather than per key, and it appears only in small
> text above the list.

#### If you get stuck

- **No Integrations tab, or + is disabled**
  → Insufficient permissions. Sign in as **Admin or Account Holder**.
- **Only a "Request Access" button on first use**
  → Team keys must be enabled by the **Account Holder** in person. If that's someone else, have them do it.
- **Role set to Developer by mistake**
  → Codemagic builds fail with `Provisioning profile ... doesn't include signing certificate`.
    The role can be changed afterwards — raise it to **App Manager**.

### 1-3-2. Registering it in Codemagic

1. Open Codemagic **Settings** (or Account settings, bottom left) > **Integrations** > **Developer Portal**
2. Register a new key via **Manage keys / Add key**
3. Fill in

   | Field | Value |
   | --- | --- |
   | **Name** | **`codemagic`** |
   | Issuer ID | The UUID from 1-3-1 |
   | Key ID | The 10 characters from 1-3-1 |
   | API key | Upload `AuthKey_XXXXXXXXXX.p8` |

> **The name must be `codemagic`.**
> `integrations.app_store_connect: codemagic` in `codemagic.yaml` refers to it by that name. Use a different
> name and you must edit the yaml too.
>
> **Same string as the filename, different thing.** `codemagic` here is the display name you gave this API
> key, not `codemagic.yaml`.
>
> **Also different from the certificate name under Code signing identities.**
> That one names a certificate file you uploaded by hand, and `integrations.app_store_connect` cannot refer
> to it. Put a certificate name (`aisenseidist`, say) there and the build fails with
> `App Store Connect integration "..." does not exist`.

Once registered, you **don't need to create certificates or provisioning profiles by hand**. The signing
step in `codemagic.yaml` calls `app-store-connect fetch-signing-files` through this API key and creates
whatever is missing.

> **You do have to supply the private key embedded in the distribution certificate**, though: it's
> `CERTIFICATE_PRIVATE_KEY` in the `ios-code-signing` variable group. Forget it and every build mints a new
> certificate until you hit the cap. How to generate it:
> [`codemagic.md`](./codemagic.md#certificate_private_key-is-required).

### 1-3-3. APNs Auth Key (only when wiring up push)

OneSignal init is already in the app (`lib/src/features/notifications/`).
**Until this key reaches OneSignal, not one notification arrives on iOS.**

Create it under **[developer.apple.com](https://developer.apple.com) > Certificates, Identifiers &
Profiles > Keys > +**, ticking **Apple Push Notifications service (APNs)**.
This `.p8` also cannot be re-downloaded.

OneSignal needs the `.p8` + **Key ID** + **Team ID** + **Bundle ID** (`jp.co.aiSensei`). The Team ID is in
the top right of Apple Developer, or on the membership page.

### 1-4. Create the app in App Store Connect

**My Apps > + > New App**

| Field | Value |
| --- | --- |
| Platform | iOS |
| Name | Store display name (≤30 chars, Japanese allowed) |
| Primary language | Japanese |
| Bundle ID | `jp.co.aiSensei` (created in 1-2) |
| SKU | Any internal ID, e.g. `ai-sensei-ios` |

**Without this, Codemagic's upload fails** — easy to miss, since the build itself succeeds.

### 1-5. Agreements, tax and banking

**Business** (formerly Agreements, Tax, and Banking)

**Activate** the Paid Applications Agreement. Without it you cannot create subscription products, and any
you do create can't be bought in Sandbox. It requires bank and tax details, so **for a company this usually
waits on finance**. Along with 0-1 it has a long lead time — start early.

### 1-6. Create the subscription

**App > Monetization > Subscriptions**

1. Create a subscription group (e.g. `ai-sensei Premium`)
2. Create an auto-renewable subscription inside it
   - Product ID (e.g. `jp.co.aisensei.premium.monthly`) — **cannot be changed later**
   - Duration and price
   - Display name and description (localized; Japanese required)
3. Attach a **review screenshot** (the paywall screen) — reviews reject without it
4. For a free trial, add it under Subscription Offers

### 1-7. App Privacy

**App > App Privacy.** Reading the code, here is what to declare.

| Data type | Collected | Purpose | Linked to identity | Evidence |
| --- | --- | --- | --- | --- |
| Photos | Yes | App functionality | **Linked** (paired with an anonymous device ID) | `api_client.dart` posts multipart, stored in R2 |
| Audio data | Yes | App functionality | Linked | Conversation sent over `livekit_client` |
| User ID | Yes | App functionality | Linked | The anonymous UUID in `device_id.dart` |
| Purchase history | Yes | App functionality | Linked | `purchases_flutter` |
| Crash data | Yes | Analytics | Can be configured as not linked | `sentry_flutter` |
| Other usage data | Yes | App functionality | Linked | The karte (learning records) |

**Not declared**: name, email, phone number, address, location, contacts, health, financial data. The app
collects none of them (there are no accounts).

**"Tracking" is "no"**, since we don't use the advertising ID (IDFA) and don't pass data to third parties
for advertising. `NSUserTrackingUsageDescription` and the ATT dialog are therefore unnecessary.

> The ID in `device_id.dart` is a UUID the app generates itself, not an advertising ID. It still counts as a
> "User ID" under Apple's definitions, so **it must be declared**.

### 1-8. Age Rating

Answer the questionnaire under **App > General Information > Age Rating**. If 0-1 settled on "13+", **stay
out** of the Kids Category.

### 1-9. Info.plist (app side, in the repo)

Already present:

| Key | Meaning | Source |
| --- | --- | --- |
| `NSCameraUsageDescription` | Photographing the notebook | `camera` / `image_picker` |
| `NSMicrophoneUsageDescription` | Having them explain aloud | `livekit_client` |
| `NSPhotoLibraryUsageDescription` | Picking an existing photo | `image_picker` |
| `ITSAppUsesNonExemptEncryption` = `false` | Skips the export-compliance prompt | HTTPS only |

Needed **when push gets wired up** (not implemented yet):

- Add **Push Notifications** in Xcode's Signing & Capabilities
  → `aps-environment` appears in `Runner.entitlements`
- `remote-notification` in `UIBackgroundModes`

**To keep the conversation going with the screen locked**, additionally:

- `audio` in `UIBackgroundModes`
- Review will always ask why. A conversation app can justify it, but "don't add it unless you need it" is
  the safe course

### 1-10. RevenueCat (Apple side)

1. Add the App Store app to the RevenueCat project and enter the Bundle ID
2. Create an **In-App Purchase Key** (App Store Connect > Users and Access > Integrations > In-App Purchase)
   and upload it to RevenueCat
3. Point **App Store Server Notifications V2** at RevenueCat's URL (App Store Connect > App > General
   Information)
4. Register the 1-6 product IDs under Products
5. **Create the `premium` entitlement** (the identifier; the display name is free-form). The app's default
   is `entitlementId` in `revenuecat_config.dart`; to use another name, match it with
   `--dart-define=REVENUECAT_ENTITLEMENT_ID=...`. A mismatch means **the purchase succeeds and unlocks
   nothing**
6. **Set `current` under Offerings and put three packages in it: weekly, monthly, yearly** — the identifiers
   are RevenueCat's standard ones (`$rc_weekly` / `$rc_monthly` / `$rc_annual`). With `current` empty, the
   paywall shows no products
7. **Build a paywall under Paywalls** (attached to the Offering). Without one the app falls back to its own
   paywall — see [`docs/revenuecat.md`](../revenuecat.md)
8. Put the public SDK key (`appl_...`) into `REVENUECAT_IOS_PUBLIC_SDK_KEY` in the Codemagic variable group
   `mobile-dart-defines`
9. Point the webhook at `https://<api>/v1/webhooks/revenuecat` and set the Authorization header to the same
   value as `REVENUECAT_WEBHOOK_AUTH` (`backend/api/src/routes/webhooks.ts:41`)

### 1-11. TestFlight

Internal testers just need to be App Store Connect users, and get builds without review (up to 100).
External testers need beta app review the first time.

Because `ITSAppUsesNonExemptEncryption` is set, uploads don't prompt for export compliance each time.

---

## 2. Google

### 2-1. Google Play Console

$25 one-off registration fee. Organization accounts need D-U-N-S and identity verification. Even personal
accounts go through **address and phone verification**, which can take several days.

### 2-2. Create the app

**All apps > Create app**

| Field | Value |
| --- | --- |
| App name | Store display name |
| Default language | Japanese |
| App / Game | App |
| Free / Paid | **Free** (with in-app purchases) |

> **Paid cannot be changed to free later.** Build subscriptions as "free app + in-app purchase".

The package name `jp.co.aiSensei` is **fixed the moment the first AAB is uploaded** and cannot change after.

### 2-3. Signing (Play App Signing)

**Release > Setup > App signing**

Play App Signing turns on automatically at the first upload. The upload keystore held by Codemagic is the
*upload* key; Google holds the distribution signing key. **Losing the upload keystore means filing for a
reset**, so keep the `.jks` and its passwords somewhere besides Codemagic.

### 2-4. Internal testing

**Testing > Internal testing > Create new release**

`android-internal` in `codemagic.yaml` promotes to `track: internal`. Testers are registered as a list of
email addresses (up to 100, no review).

**The very first AAB must be uploaded by hand**, though — API uploads are rejected while the app has never
been published.

### 2-4-1. Closed testing (collecting testers via a Google Group)

Unlike internal testing, **closed testing can reach outsiders**. That's the funnel we recruit through from
the LP, and the roster lives in **a single Google Group**.

| Item | Value |
| --- | --- |
| Group address | `ai-sensei@googlegroups.com` |
| Join page (linked from the LP) | `https://groups.google.com/g/ai-sensei` |
| Join by email | Blank email to `ai-sensei+subscribe@googlegroups.com` |
| Play opt-in URL | `https://play.google.com/apps/testing/jp.co.aiSensei` |

> **Never change the group address.** Play Console resolves testers by the group's email address, so
> changing it **drops every registered tester from the roster at once**. The 12-testers/14-days count
> (below) breaks there too, and starts over.

#### Steps

1. **Create the group** (groups.google.com > Create group) at the address in the table above. It doesn't
   have to be the same Google account that owns Play Console (we only hand over the group address).
2. **Configure the group** (Group > Group settings) as follows. Left at the defaults, someone pressing the
   button on the LP cannot join.

   | Setting | Value | Why |
   | --- | --- | --- |
   | Who can join group | **Anyone on the web can join** | Default is "invited users only". With approval required, nobody becomes a tester until we approve by hand |
   | Who can view members | **Group owners and managers** | Keeps testers' email addresses hidden from other testers |
   | Who can post | **Group owners and managers** | It's a roster, not a message board. Left open it becomes a spam target |
   | Who can view conversations | Group members | Later joiners can read back the release announcements |

   Since "anyone on the web can join", **bots do get in**. Accounts that never actually use the app don't
   count toward the 12 (below), so if the noise becomes visible, drop it to "anyone can ask" (approval
   required) and update the LP copy ("joining makes you a tester") to match.
3. **Link it in Play Console.** Add `ai-sensei@googlegroups.com` under **Testing > Closed testing > Track >
   Testers**. The "tester opt-in URL" on the same screen is the Play opt-in URL in the table, and
   **until at least one closed-testing release is approved, that URL only ever shows "you're not a tester"**.
4. **Once a release is on the track, open up step 2 of the join page.** The recruitment funnel lives in
   `apps/lp/public/beta/` (and `en/beta/`) and is written as two steps: ① join the group, ② press the Play
   opt-in URL. **Step ②'s button currently ships in a non-pressable state (`.btn-soon`)** — pressing it
   before approval drops everyone, per the note above. When the release lands, swap in the link and send one
   message to the group at the same time (how to swap it: "What to fill in before launch" in
   `apps/lp/README.md`).

#### 12 testers / 14 days (personal accounts only)

**Personal developer accounts created on or after 2023-11-13** need a closed test with **at least 12 testers
opted in continuously for 14 days** before applying for production. D-U-N-S-verified organization accounts
are exempt. The procedure differs by account type, so **check yours first under Play Console > Account
details.**

If the requirement applies, three things matter on the tester side.

- **Joining the Google Group alone does not count.** They only count once they open the Play opt-in URL and
  opt in. Anyone who skips step 2 of the join page is on the roster but counts as zero.
  **That's why the recruitment page spells out step 2** — say only "join the group" and everyone you
  recruited evaporates.
- **The 14 days start once both the release is approved and 12 testers are reached.** Drop below 12 and the
  count resets.
- **Opting in without using it fails too.** Since April 2026, insufficient testing activity gets production
  applications rejected. "Open it about every other day" on the join page and the LP exists to avoid that
  rejection.

Testers must also be Google accounts on real devices (emulators and duplicate accounts don't count), so
**you can't pad it out with 12 in-house devices.**

### 2-5. App content (mandatory declarations)

**Policy > App content.** You cannot release without completing all of it.

| Item | This app's answer | Why |
| --- | --- | --- |
| App access | No restrictions | No accounts, so every feature is available immediately |
| Ads | No ads | No ad SDK |
| Content rating | Answer the IARC questionnaire | Education app. No violence or sexual content |
| Target audience and content | **The age band chosen in 0-1** | Including under-13s triggers the Families policy |
| Data safety | See 2-6 | |
| News app | No | |
| Health | No | |
| Financial | No | |
| Government app | No | |
| Privacy policy | The URL from 0-2 | |

**Sensitive permission declaration forms** apply to four families: background location, SMS/call log,
all-files access, and the installed-apps list. **We use none of them, so no submission is needed.**

The one that needs checking is the **photo and video permissions** declaration, required if
`READ_MEDIA_IMAGES` is requested. `image_picker` uses the Photo Picker on Android 13+ and shouldn't request
it in principle, but **verify the merged manifest by the method in 2-8 before answering.**

### 2-6. Data safety

The same content as 1-7, in Google's taxonomy.

| Data | Collected | Shared | Purpose | Required |
| --- | --- | --- | --- | --- |
| Photos | Yes | Yes (LLM provider) | App functionality | Required |
| Audio | Yes | Yes (STT / LLM) | App functionality | Required |
| User ID (anonymous UUID) | Yes | No | App functionality | Required |
| Purchase history | Yes | Yes (RevenueCat) | App functionality | Required |
| Crash logs | Yes | Yes (Sentry) | Analytics | Can be optional |
| Other (learning records) | Yes | No | App functionality | Required |

- **Careful with "shared".** Sending photos or conversations to an LLM API counts as sharing with a third
  party under Google's definitions. Confirm the facts along with 0-3.
- "Encrypted in transit" = yes (HTTPS / WSS)
- "Way to request deletion" = depends on the 0-3 policy. With only an anonymous ID there's no way to verify
  identity, so **an in-app deletion path is the realistic answer** (not implemented yet).

### 2-7. Subscriptions

**Monetize > Products > Subscriptions**

1. Product ID (e.g. `premium_monthly`) — **cannot be changed later**
2. Base plan (duration, price, auto-renewal)
3. Name and description
4. For a free trial, add it under Offers

Product IDs need not match iOS (RevenueCat bundles them under the `premium` entitlement).

### 2-8. Android permissions

**Declared explicitly** in the repo's manifest (`android/app/src/main/AndroidManifest.xml`):

| Permission | What for |
| --- | --- |
| `INTERNET` | Talking to the backend / LiveKit. **Only present in the debug/profile manifests, so release builds broke — added by hand** |
| `RECORD_AUDIO` | Having them explain aloud (LiveKit) |
| `MODIFY_AUDIO_SETTINGS` | Switching between speaker and headphones |
| `CAMERA` | Photographing the notebook |

On top of that, **dependency manifests get merged in**. What we could confirm:

| Permission | Source |
| --- | --- |
| `ACCESS_NETWORK_STATE` | `connectivity_plus` |
| `WRITE_EXTERNAL_STORAGE` (with `maxSdkVersion`) | `camera_android_camerax` |

More come from native SDK (AAR) manifests: `POST_NOTIFICATIONS` / `WAKE_LOCK` (OneSignal),
`com.android.vending.BILLING` (Play Billing), and so on — **but these can't be confirmed without resolving
the AARs, which this environment can't do.**

Always build and inspect the final form before declaring:

```bash
cd apps/mobile
flutter build apk --debug
# the merged manifest
cat build/app/intermediates/merged_manifests/debug/AndroidManifest.xml | grep uses-permission
```

Once an AAB is uploaded, **Release > App bundle explorer > Permissions** lists them too. Answer the "photo
and video permissions" question in 2-5 after looking at that list.

### 2-9. Google Play Developer API (for Codemagic)

The credentials used by `publishing.google_play` in `codemagic.yaml`.

1. Create a project in Google Cloud Console (an existing one is fine)
2. Create a **service account** and download the JSON key
3. Invite that service account under Play Console > **Users and permissions**
4. Grant **Releases** (app-level is fine; "create and publish releases" plus "release to testing tracks" is
   enough)
5. Put the whole JSON into `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` in Codemagic's `google-play` variable group,
   **marked Secure**

### 2-10. RevenueCat (Google side)

1. Add the Play Store app in RevenueCat and enter the package name
2. Prepare **a service account separate from the one in 2-9** and give its JSON to RevenueCat (permissions:
   "view financial data" and "manage orders and subscriptions")
3. **Real-time developer notifications**: set RevenueCat's Pub/Sub topic under Play Console > Monetize >
   Monetization setup
4. Register the 2-7 product IDs under Products
5. **Entitlement `premium`, Offering `current`** (required for the same reasons as 1-10 steps 5 and 6) —
   entitlements and offerings are **project-wide**, so don't recreate them if Apple's side already has them
6. Put the public SDK key (`goog_...`) into `REVENUECAT_ANDROID_PUBLIC_SDK_KEY`

---

## 3. Order of operations

Start with the longest lead times.

1. **Apple Developer Program / Play Console registration** (weeks for organizations)
2. **Paid Applications Agreement (1-5)** (waits on finance and banking)
3. **The 0-1 age-band decision** (changing it later means redoing SDK choices)
4. ~~**Privacy policy URL (0-2)**~~ — settled (table in 0-2)
5. Create App IDs and app records (1-2 / **1-2-1** / 1-4 / 2-2)
   — skip 1-2-1 (App Group and the extension's Identifier) and iOS alone still fails at signing, however
   complete everything else is
6. Keys (1-3 / 2-9) → Codemagic runs from here on
7. Subscriptions and RevenueCat (1-6 / 1-10 / 2-7 / 2-10)
8. Declarations (1-7 / 1-8 / 2-5 / 2-6)

Through step 6 you can ship to TestFlight and internal testing. Steps 7 and 8 can wait until just before
launch, but the paywall doesn't work without 7.

**On a personal account, start closed testing (2-4-1) right after step 6.** The 14 days only start counting
once 12 testers are in, so there's no way to shorten it but wait — you can finish 7 and 8 entirely and still
be locked out of production for a while. Recruit testers from `apps/lp/public/beta/` (the join page linked
from `#beta` on the LP).
