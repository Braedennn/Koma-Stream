# Koma for Android (Phase 1 skeleton) — WORKING

The app is a WebView pointed at Koma's own server running inside the app. One
embedded Node runtime (nodejs-mobile 18.20.4) hosts both servers — Koma on
`127.0.0.1:4180` (what the WebView loads) and the AniVault streaming API on
`127.0.0.1:4181` (what Koma proxies to) — exactly the desktop architecture with
two loopback ports instead of two processes.

Verified end to end on LDPlayer 9 (Android 14, x86_64): app opens, Node boots
both servers, the site renders, the API answers. Not yet verified on device:
playback (the user's next test), dub badges (Python not ported), or the
watch-together host.

## The five crashes between "closes instantly" and "works", in the order they fell

1. **`libc++_shared.so` missing** — `libnode.so` needs the shared C++ runtime;
   without `-DANDROID_STL=c++_shared` in the app's CMake config the APK ships
   none, and `System.loadLibrary("node")` dies before any window. Symptom:
   open -> instant close, nothing on screen.
2. **`extractNativeLibs=false`** (AGP's default) — some emulator linkers fail
   to mmap native libs straight out of the APK. LDPlayer included. Fix:
   `packagingOptions { jniLibs { useLegacyPackaging = true } }`. Symptom: same
   instant close. (Real devices usually survive this one.)
3. **aapt2's asset ignore rules** — aapt2 silently drops everything starting
   with a dot (`.env`, `node_modules/.bin`) and directories starting with an
   underscore (`node-cache/_src`), but **keeps underscore-prefixed files**
   (`readable-stream/lib/_stream_readable.js`). The first-launch copy list
   must name exactly what aapt2 keeps: a listed file without an asset crashes
   the copy; a kept asset missing from the list breaks `require()` at runtime.
   `sync-assets.mjs` mirrors the rules.
4. **`.env` renamed to `anivault.env`** — same aapt2 dotfile rule; Node reads
   the key from storage, so the file must survive packaging.
5. **undici 7 vs Node 18** — cheerio pulls `undici@^7.19.0`, which uses the
   `File` global (Node 20+). The first launch died with
   `ReferenceError: File is not defined` inside undici, and in nodejs-mobile a
   Node exit takes the whole Android process down. Fix: npm `overrides` pin
   `undici@5.28.5` (Node 18 compatible) in the AniVault package.json.

Diagnosis loop that found all five: adb + logcat (node's stderr arrives with
tag `nodejs`), the app's own trail (`files/koma-log.txt`, via
`adb shell run-as app.koma.stream cat files/koma-log.txt`), and
`llvm-readelf -d` on the shipped .so files for missing dependencies.

The install-and-launch dance used for testing:
```
adb connect 127.0.0.1:5555        # LDPlayer with ADB debugging enabled
adb install -r -g Koma-1.7.19-phone.apk
adb shell am force-stop app.koma.stream; adb shell input keyevent KEYCODE_HOME
adb shell input tap 800 228       # the home-screen icon
adb forward tcp:14180 tcp:<port> # use the port in files/koma-site.port
```

## Install a build

`Koma-1.7.19-phone.apk` and `Koma-1.7.19-tv.apk` are the public release
packages. Copy the phone package to a phone and the TV package to a television.
Android asks to allow installs from that source once. The release packages use
the project's permanent signing key; the debug variants are only for local
testing.

On first launch the app copies the Node project out of the APK (a few seconds),
starts the servers, then opens the site. From there it is the same Koma: browse,
search, play. Progress, library and preferences live in the WebView's storage and
survive updates, not uninstalls — Settings -> Data backup is the migration path.

## Updates from GitHub Releases

Both Android flavors look at the latest published release in
`Braedennn/Koma-Stream`. The phone build looks for a phone APK and the TV build
looks for a TV APK, so an update can never install the wrong app or package.
The APK is downloaded in the background, checked against GitHub's SHA-256
digest, and kept in private app storage.

When it is ready, each app shows its own confirmation screen: a compact panel
on the phone and a large remote-friendly panel on the television. **Update now**
opens Android's package installer, which asks for the final user confirmation;
**Later** keeps the downloaded APK and offers it again later. Android's
`REQUEST_INSTALL_PACKAGES` permission is required for this system installer
step.

Every GitHub release used by the Android apps must contain the desktop
installer plus both Android packages, for example:

```text
Koma-Setup.exe
Koma-1.7.19-phone.apk
Koma-1.7.19-tv.apk
```

The stable names `Koma-phone.apk` and `Koma-tv.apk` are accepted too. A release
without the APK for the running flavor is ignored by that flavor.

## What is known-missing in this build

- **Dub badges**: the AllAnime catalogue is a separate Python service that does not
  port; badge lookups stay "pending" and the row stays empty. Playback does not
  depend on it. The fix is porting the catalogue scan into AniVault (Phase 4).
- **Watch-together host**: the viewer side works; hosting on the phone is deferred.
- A first-play on a show nobody has opened yet can take longer than desktop (the
  mapping search), same as a cold desktop install.

## Rebuild

1. `node sync-assets.mjs` — assembles `app/src/main/assets/nodejs-project` from
   the repo (`server.js`, `server/`, `public/`, the packaged AniVault `dist` +
   `node_modules`, the API key as `anivault.env`), then writes `dir.list` /
   `file.list`. The walk mirrors aapt2's ignore rules exactly (see crash 3
   above) — rebuild the desktop `dist` first when AniVault's dependency tree
   changes, so the packaged copy carries the fix.
2. Build:
   ```powershell
   $env:JAVA_HOME   = "E:\WebsiteAnime\.data\android\jdk-21.0.13+9"
   $env:ANDROID_HOME = "E:\WebsiteAnime\.data\android\sdk"
   $env:GRADLE_USER_HOME = "E:\WebsiteAnime\.data\android\gradle-home"
   & "E:\WebsiteAnime\.data\android\gradle-8.7\bin\gradle.bat" assemblePhoneRelease assembleTvRelease
   ```
   -> `app/build/outputs/apk/phone/release/app-phone-release.apk` and
   `app/build/outputs/apk/tv/release/app-tv-release.apk` — then COPY them to
   `Koma-1.7.19-phone.apk` and `Koma-1.7.19-tv.apk` before installing or
   publishing (the stale-copy trap: verifying one file and installing another
   costs an hour).

   Release signing reads `.data/android/release-signing.properties`; that file
   and `koma-release.keystore` are deliberately outside Git. Back both up
   somewhere safe: changing the certificate later means Android cannot install
   an update over an existing installation. The version code is `10719` for
   1.7.19 and must rise for every later release.

   The TV's integrated OpenSubtitles consumer key reads
   `.data/auth/opensubtitles.json` (`{"apiKey":"…"}`). Gradle injects it only
   into the TV flavor's `BuildConfig`; the phone field is empty and desktop
   packaging never reads it. At startup the TV writes it to its private files
   directory for Node, not to WebView storage. TV release builds fail if it is
   missing. This file is private local configuration and must not be published.

Toolchain (all portable, all under `.data\android\`): JDK 21, cmdline-tools,
platform-tools, platforms;android-34, build-tools;34.0.0, NDK r26b, CMake 3.22.1,
Gradle 8.7.

## Layout

- `app/src/main/java/com/koma/app/MainActivity.java` — WebView + poll + fullscreen
  video + the diagnosis trail (`trace()` -> `koma-log.txt`, both storages).
- `app/src/main/java/com/janeasystems/rn_nodejs_mobile/RNNodeJsMobileModule.java` —
  the Node runner (nodejs-mobile-react-native 18.20.4 with the React bindings
  removed; the package and class names are load-bearing — the JNI symbols in
  `native-lib.cpp` are bound to them).
- `app/src/main/cpp/` — that JNI layer + node headers; `jniLibs/` — the three
  prebuilt `libnode.so` runtimes.
- `node-src/` — the starter Node runs (`main.js`: env, then both servers).
- `sync-assets.mjs` — assembles the APK's Node project from the repo.
