# Roshan RPHS Android app

A native Android app (package `pk.rphs.society`) built with [Capacitor](https://capacitorjs.com).
It opens the live web app (https://naveedsher96-oss.github.io/RP-Housing-PWA/), so every
change to `index.html` reaches the app at once, with no Play update needed.

It replaces the old Play Store TWA under the same package name and Play signing,
so it installs as a normal update.

## What's here

- `capacitor.config.json`: app id, name and the live site address.
- `www/offline.html`: the screen shown when there is no internet.
- `android/`: the Android project.
  - `app/src/main/assets/rphs-shim.js` is injected into the web app inside the
    Android app only. It fills gaps in Android's WebView: share sheet, file
    downloads, opening PDFs, WhatsApp and other outside links.
  - `app/src/main/java/pk/rphs/society/RphsBridgePlugin.java` is the native half of that.

## Building

GitHub Actions builds it (`.github/workflows/android.yml`); nothing needs installing locally.

- Every pull request that touches `android-app/` builds a test APK named "RPHS Test".
  It installs next to the Play app, so it is safe to try on a phone.
- To make a Play release, go to Actions > Android app > Run workflow on `main`.
  Download the `rphs-play-bundle-…` artifact and upload the `.aab` in Play Console.

The release is signed with the Play upload key from these repository secrets
(Settings > Secrets and variables > Actions):

| Secret | Value |
|---|---|
| `RPHS_KEYSTORE_BASE64` | `signing.keystore` encoded as base64 |
| `RPHS_KEYSTORE_PASSWORD` | Key store password |
| `RPHS_KEY_ALIAS` | Key alias |
| `RPHS_KEY_PASSWORD` | Key password |

The keystore itself is never committed.
