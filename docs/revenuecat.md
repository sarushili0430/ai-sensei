# RevenueCat

Billing goes through the RevenueCat SDK (`purchases_flutter` + `purchases_ui_flutter`).
It is also what satisfies Shipaton's entry requirement (at least one in-app purchase
through the SDK).

The store-side submission work is in [`docs/ci/store-setup.md`](ci/store-setup.md).
This document covers **how the app meshes with the dashboard**, and nothing else.

---

## 1. What lives where

| File | Role |
| --- | --- |
| `data/revenuecat_config.dart` | Reads the keys, entitlement and offering from `--dart-define` |
| `data/purchases_repository.dart` | The SDK's only entry point. Tests replace this whole file |
| `domain/entitlement.dart` | Pure functions turning `CustomerInfo` / `Offering` into what the screens use |
| `domain/purchase_outcome.dart` | Pure functions folding SDK exceptions into "cancelled / kind of failure" |
| `application/entitlement_controller.dart` | Holds the state. The entry point for purchase, restore, paywall and Customer Center |
| `application/premium_sync.dart` | When the entitlement changes, re-reads the server's decision (§9) |
| `presentation/paywall_screen.dart` | RevenueCat's paywall -> (if unavailable) our own paywall |
| `presentation/thanks_screen.dart` | Thanks for a purchase, trial or restore. Shown after the paywall |
| `presentation/manage_subscription_button.dart` | The Customer Center route, the subscription card, the Premium badge |
| `main.dart` | Calls `configure` exactly once at startup |

## What appears after a purchase

Once a purchase goes through, **always route to `/thanks`**. There are three entry
points, and leaving any one of them on `closeOrGoHome()` means people who bought through
that route see nothing:

| Entry point | What to call |
| --- | --- |
| Our own paywall's `PurchaseSucceeded()` | `context.replaceWithThanks()` |
| RevenueCat's paywall, `PaywallResult.purchased` | `context.replaceWithThanks()` |
| Restore (paywall / settings) | `context.replaceWithThanks(restored: true)` / `pushThanks(restored: true)` |

The heading splits three ways, **because "thank you for your purchase" cannot always be
written** (§6, honesty):

- **A free trial** (`Entitlement.isTrial`) — not a yen has been paid yet. State the
  number of days and the date billing starts, up front. `PeriodType.intro` (a **paid**
  campaign such as 100 yen for the first month) does not count as free.
- **A restore** — nothing was bought again. Thanking them suggests they paid twice.
- **Payment succeeded but no entitlement attached** — the router's `redirect` bounces to
  home. Celebrating and then being unable to use it is the sharpest possible drop.

The subscription badge appears in two places: `PremiumChip` at the top right of home, and
`SubscriptionStatusCard` in settings (status plus renewal / end / billing-start date).
**Never turn it into a rank or a title** - only streak days and filled holes are counted
(§7).

`Purchases.configure` is called **exactly once, in `main()`**.
Calling it inside a provider's `build()` would run it on every provider rebuild.

```dart
// main.dart
await const PurchasesRepository().configure(appUserId: deviceId);
```

`appUserID` receives the anonymous device id (`ai_sensei.device_id`) directly.
No account creation is required, so `logIn` is not used. That value arrives as the
webhook's `app_user_id`, and `backend/api/src/routes/webhooks.ts` syncs it into D1.

**The server's decision is authoritative.** The app's entitlement is used only to gate
UI; the effective limits, such as session caps, are decided by
`backend/api/src/lib/entitlement.ts`.

---

## 2. What to create in the dashboard

### Products

Register the product ids created in the stores as-is.

| Period | RevenueCat package identifier |
| --- | --- |
| Weekly | `$rc_weekly` |
| Monthly | `$rc_monthly` |
| Annual | `$rc_annual` |

The app reads `PackageType` (weekly / monthly / annual), so the product ids need not
match between iOS and Android. Using the standard identifiers above lets `plansOf()`
pick them up. Packages created with non-standard identifiers **do not appear on screen**.

### Entitlement

The identifier is **`premium`**. The display name can be anything.

Getting this wrong produces the hardest breakage to notice: purchases succeed and
nothing unlocks. To use a different name, match it in the app:

```bash
flutter run --dart-define=REVENUECAT_ENTITLEMENT_ID=pro
```

Remember to attach the Product to the Entitlement. Forget, and the purchase goes through
without the entitlement. The app detects that and says "the purchase completed but has
not applied yet" (it does not close the screen as a success).

### Offering

Set it as `current` and put the three packages above in it. With `current` empty, the
paywall shows nothing.

### Paywall

Create it attached to the Offering
([Paywalls](https://www.revenuecat.com/docs/tools/paywalls)).
Wording, prices and images can be swapped from the dashboard, so the paywall can be fixed
without shipping the app again.

**It works without one.** Unconfigured, `PaywallResult.error` comes back and the app
falls to our own paywall (`_ManualPaywall` in `paywall_screen.dart`). Ours is kept so
that a keyless build, an old OS or an unconfigured dashboard all still show a screen
containing the "keep using it free" route.

> The §6 promises apply when building the paywall in the dashboard too: do not hide
> "keep using it free", state clearly that it can be cancelled, and use no countdowns.
> The HAMM award looks at honesty.

### Customer Center

Enable [Customer Center](https://www.revenuecat.com/docs/tools/customer-center).
It bundles cancellation, plan changes, refund requests and purchase restoration - the
kind of screen that gets flagged in App Review every time when built by hand.

In the app, the route is shown on home **only to people with a subscription**
(`ManageSubscriptionButton`). "Restore purchases", for people without one, lives on the
paywall.

---

## 3. Supplying the keys

The values live in `apps/mobile/dart_defines.env` (gitignored).
The template is `dart_defines.example.env`.

```bash
cp dart_defines.example.env dart_defines.env
fvm flutter run --dart-define-from-file=dart_defines.env
```

| Variable | Content |
| --- | --- |
| `REVENUECAT_IOS_PUBLIC_SDK_KEY` | `appl_...`. Production iOS |
| `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` | `goog_...`. Production Android |
| `REVENUECAT_SDK_KEY` | `test_...`. The Test Store. Used **only when both of the above are empty** |
| `REVENUECAT_ENTITLEMENT_ID` | Defaults to `premium` |
| `REVENUECAT_OFFERING_ID` | Empty means current |

The public SDK key is **meant to be embedded in the build artifact** and needs no
secrecy. The secret key (`sk_...`) and the webhook's shared secret live on the backend,
and `pnpm run verify:secrets` watches for them leaking in.

**A build with no keys disables billing silently and entirely**
(`RevenueCatConfig.isConfigured`). `flutter test` and CI go down that path, so tests for
screens unrelated to billing are never collateral damage.

### Test Store

A key starting with `test_` lets the purchase flow run end to end before products exist
in App Store Connect / Play Console. Nothing is actually charged.
The paywall shows a note saying so (`AppStrings.testStoreNotice`).

Once the store products exist, fill in `REVENUECAT_IOS_PUBLIC_SDK_KEY` /
`REVENUECAT_ANDROID_PUBLIC_SDK_KEY`. They take precedence, so `REVENUECAT_SDK_KEY` need
not be removed.

---

## 4. Platform requirements

| | Requirement | Reason |
| --- | --- | --- |
| iOS | 15.0+ | Paywalls / Customer Center need iOS 15+. `IPHONEOS_DEPLOYMENT_TARGET` in `project.pbxproj` is set to 15.0 |
| Android | minSdk 24+ | Required by `purchases_ui_flutter`. Flutter defaults to 24, so nothing extra is needed |

---

## 5. Restores and server-side reassignment (TRANSFER)

An anonymous device id disappears on uninstall and changes with a new device.
So **the app_user_id at restore time differs from the one at purchase time**.

Behaviour depends on the dashboard's **Restore Behavior** setting.

| Setting | What happens |
| --- | --- |
| Transfer to new App User ID | RevenueCat reassigns the purchase and sends a `TRANSFER` webhook |
| Keep with original App User ID | Nothing is reassigned; the app says "no restorable purchases found" |

With the former, dropping `TRANSFER` means **the app says "restored" while the server
stays free** (reviews and history never open). The server's decision is authoritative, so
the mismatch looks to the user like a bug that will not go away.

`backend/api/src/routes/webhooks.ts` handles it. TRANSFER's shape is unique:

- There is **no** `app_user_id`. Instead there are `transferred_from` /
  `transferred_to` (arrays)
- There is neither `expiration_at_ms` nor `entitlement_ids` (it reassigns everything, not
  a single product)

Since the expiry is absent from the payload, **it is inherited from the source record**.
If the source has no Premium record, nothing is granted - granting with no expiry would
let a restore alone create permanent Premium. In that case the next `RENEWAL` /
`EXPIRATION` arrives on the new id and settles the correct expiry.

---

## 6. State is pushed from the SDK

`Purchases.addCustomerInfoUpdateListener` is wrapped into a Stream by
`PurchasesRepository.customerInfoChanges()`, which `EntitlementController` subscribes to.

Renewal, expiry, a purchase inside the paywall and a cancellation in Customer Center all
apply without reopening the screen. There is no polling.

But that changes **only the app's entitlement**; the server's decision changes later, via
a different route (the webhook). How they mesh is §9.

---

## 7. Handling failures

The SDK throws failures as `PlatformException`. **A user closing the sheet is also an
exception**, so passing it straight to the screen shows an error to someone who simply
changed their mind.

`PurchaseOutcome.fromException` folds it into cancelled / a kind of failure first.

| Category | Example | What the screen shows |
| --- | --- | --- |
| Cancelled | The user closed it | **Nothing.** No attempt to hold them |
| `network` | No signal, timeout | Say it should work again later |
| `storeProblem` | A store outage | Say it is not something we can fix |
| `alreadyOwned` | They already have a subscription | Point at "restore purchases" |
| `pending` | Convenience-store payment and the like | Say it becomes usable automatically once approved |
| `configuration` | The wrong product id or entitlement | **An implementation bug.** Log the details |

A `configuration` error means suspecting how it meshes with the dashboard.
`EntitlementController._warnIfMisconfigured` logs a mismatched entitlement identifier and
an empty Offering even in release builds.

---

## 8. Tests

```bash
cd apps/mobile
fvm flutter test test/monetization_test.dart test/premium_sync_test.dart
```

They check not "does the SDK work" but **whether we misread the values the SDK returned**:
a mismatched entitlement identifier, package ordering, never calling a non-zero
introductory price "free", and never treating a cancellation as a failure.

The paywall golden (`test/golden/goldens/paywall.png`) captures a keyless build, i.e. our
own paywall. That "keep using it free" and "cancel any time" have not disappeared is
checked by `test/widget_test.dart`.

---

## 9. The app's entitlement versus the server's `is_premium`

Premium is updated by **two separate routes**, and this is the easiest thing in this app
to get wrong.

| | Who writes it | When |
| --- | --- | --- |
| The app's entitlement | The SDK (`CustomerInfo`) | The moment of purchase |
| The server's `users.is_premium` | RevenueCat's webhook | A few seconds later |

And **the screens gate on the server's side**: whether a lesson is available on home and
the review screen (`is_premium` / `limits.lesson_allowed_today` from
`/v1/me/progress`), and whether a session may start (`free_limit_reached` /
`fair_use_limit_reached`). The decision is kept off the client so a claim from the client
cannot loosen the cap.

The `ProgressController` that reads it is `keepAlive` and **read once at startup**, with
nobody re-reading it. So a re-read after a purchase has to be wired up.

`premium_sync.dart` does that. It subscribes to `EntitlementController`'s changes and
re-reads `/v1/me/progress` when Premium is granted or removed. The webhook may not have
arrived yet, so it re-reads a few times until it catches up (1s / 2s / 4s / 8s).

If it never catches up, **it gives up and stays free**. Nothing is unlocked on the
client's word. A permanently broken webhook is something to fix on the server, and
overriding it here would mean nobody notices it is broken.

> Without this, **the app stays free even though the webhook returned 200**.
> The breakage looks like "the purchase succeeded, the dashboard and D1 both have the
> record, and nothing unlocks until the app is restarted".
> `test/premium_sync_test.dart` covers this path.

It hooks **entitlement changes** rather than being called from each purchase entry point
(our own paywall, RevenueCat's paywall, Customer Center, the settings restore) so that
adding an entry point and forgetting the call cannot break it.
