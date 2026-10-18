> Historical Android dependency/runtime audit. The current CLI uses a source-ported Linux Trust collector and official verification in the user's browser. Fresh HTTP login and independent account validation succeeded on the Orin; see the [current audit](protocol-audit.md). Android/remote-screen code is no longer shipped.

# Native login requirement audit

**Historical decision:** Remote app display/control was disallowed and that implementation was removed. Runtime results below describe rejected experiments. Fresh CLI authorization now works through the lightweight flow linked above.

This audit separates the requirements observed in Expedia's response from supported client runtimes. It records completed original-app login and subsequent HTTP handoff, without reproducing anti-abuse tokens or changing device identity.

## Observed server requirements

The retained native email-OTP form's Continue action requires all three providers: CSRF, Trust and Arkose Mobile App. The native ATO coordinator accumulates provider failures and completes only when no failure remains. The verification code by itself is insufficient for this observed form.

| Requirement | Established behavior | Current status |
| --- | --- | --- |
| CSRF | Uses the server-issued value associated with the returned form/action and session. | Already implemented by the protocol layer. |
| Trust | Expedia's provider calls its TrustWidget service and device-risk SDK through Android Context, with asynchronous completion. | The original app completed native login in the bounded runtime experiment below. Individual provider callbacks were not captured; a standalone Node provider has not been established. |
| Arkose | The shipped ArkoseServiceImpl requires AppCompatActivity, initializes the SDK with the application and registers completion/failure callbacks. | The original app completed its normal verification flow. No interactive challenge appeared in this test; challenge rendering and a standalone SDK bridge remain unverified. |

## Runtime versus physical hardware

Arkose's [Android SDK documentation](https://developer.arkoselabs.com/docs/android-mobile-sdk) lists Android and System WebView requirements and includes emulator testing in its compatibility table. This does not prove Expedia will accept a particular emulator, or that no additional integrity check is configured. It also does not establish a server-only Node alternative.

The audited Trust entry points establish Android SDK dependencies. They do not by themselves establish mandatory hardware-backed attestation or a physical-phone requirement. The [vendor's Android SDK documentation](https://github.com/iovation/deviceprint-SDK-Android/blob/main/README.html) likewise integrates with Android application context; vendor documentation is supporting context, not proof of Expedia's complete server policy.

Arkose's [server-side documentation](https://developer.arkoselabs.com/docs/server-side-instructions-v4) distinguishes obtaining a token through the genuine client flow from verifying it server-side. Calling a verification endpoint cannot replace completing the client flow; tokens are single use.

## Evidence and limits

Target: Expedia Android 2026.41.0, base APK SHA-256 `dfd7bbfdf10976740cbf7b4a74e359358871479766d0705d1e9b5ff633a7700f`.

REA class inventory: `ev_9b3ab801ec81d2de404a29d72130d095002de07e5dd99aa8c3c0a602099dfdbe`. Exact `ArkoseServiceImpl.verifyWithCaptcha` source: `ev_69a893565567a46c50bc9277592c4c614f7c701075d63c3c56845a347b04358d`. Prior ATO coordinator and Trust provider dumps and the live form remain private.

The initial static audit made no login requests and did not reconstruct risk tokens. Subsequent live testing used the genuine SDKs in the original app, as recorded below.

## Bounded runtime experiment

The user subsequently accepted evaluating a genuine Android runtime subject to a total memory budget below 2 GB. Private experiments on the ARM64 Orin use the original APK. The initial container limit was 1,800,000,000 bytes; a later test uses 1,900,000,000 bytes with 100,000,000 bytes reserved for auxiliary processes. Host swap remains disabled. Guest compressed RAM, when enabled by Android, remains inside that allocation. Booting Android alone is not sufficient: genuine verification, session persistence and measured total auxiliary memory must also pass before this architecture can be described as working.

Redroid did not boot reliably on the installed Tegra kernel, which lacks PSI and binderfs support. Its attempted initialization also cleared the host module-loader path; the original value was restored and those containers were stopped and removed. A KVM-backed Cuttlefish guest booted, but the first configuration lost its package service during APK installation under memory pressure. Android 12's bundled launcher requires unavailable host interfaces, while mixing it with the newer launcher fails boot-configuration validation. A subsequent Cuttlefish test successfully installed all three original Expedia APKs under the 1.9 GB container limit. The working configuration subsequently completed native login. A reusable factory now downloads pinned official artifacts, installs original APKs after boot, and configures networking inside its private container namespace.

The Cuttlefish restart command resets unspecified launch options, including guest RAM. One restart requested the default 4 GB guest and hit the container's hard limit; that failed attempt is excluded from successful measurements. Repeated launches must specify and inspect the actual guest configuration rather than assume previous flags persist.

## Native login result, 2026-10-15

The final guest reports Android **17**, build 16373615; earlier lab filenames labeled it Android 16 based on an incorrect assumption. With 1,536 MiB of guest RAM, a 480 × 800 display, working virtual networking and the required Bluetooth boot dependency, Cuttlefish reported a completed boot. All original APK splits installed. The original Expedia app accepted the account email, sent a six-digit SMS code and accepted the user's code. Its home screen then displayed the account's membership details, and its own cookie store contained `EG_SESSIONTOKEN`.

The container remained limited to 1,900,000,000 bytes with host swap disabled. The historical OOM counter did not increase during this successful configuration. This establishes one native sign-in inside that cap. It does **not** establish a complete installation on a machine with 2 GB of total RAM, repeated cold-start reliability, interactive challenge memory use, or measured auxiliary-process overhead.

HTTP handoff succeeded after correcting two protocol details. The adapter supplies the actual original app's `Device-User-Agent-ID` and retains the public `ExpediaBookings/2026.41.0` compatibility prefix, followed by an explicit `rea-expedia-cli`, Node version, host OS and architecture. It does not claim HTTP runs on a Pixel. Actual Cuttlefish/Android origin metadata is stored separately. Both `expUserId` and `tuid` are string scalars, even when profile results return numeric IDs. The session was accepted by the public handoff module, saved privately, and refreshed repeatedly through `expedia auth refresh` after Android stopped.

The initial HTTP 429 response is retained as a negative result; it was not hidden with automatic retries, proxies or forged risk tokens. The CLI surfaces later rate limits and preserves the previous validated session on failed replacement.

## Reusable installation

A clean run of `setup-android-runtime.py setup` downloaded the pinned official build, created a separate owned container, completed boot and installed all original APK splits under a **1,850,000,000-byte** memory cap, no host swap and no OOM kill. It did not reuse authenticated lab guest data. The factory repeats every memory/radio/display flag on restart and checks both CVD Running and Android boot completion before installing APKs. Separate immutable image cache and mutable guest disks support reset/logout without downloading again.

The initial reusable setup used a separate Node worker; it was replaced by a small Python supervisor to keep the combined workload below the requested budget. The current guest has 1,280 MiB of RAM. Startup uses a 1.9 GB container cap without Node or a tunnel; the running login screen uses a 1.85 GB cap plus Python and cloudflared. Docker/ADB calls are serialized. Node starts only after Android stops to validate the session. Sampled combined container memory and auxiliary RSS peaked at 1,957,363,712 bytes during this run, with no host swap or OOM kill. RSS can count shared mappings more than once, and sampling is not a continuous kernel peak. The public relay returned a 480 × 800 original-app image in WebKit with no JavaScript errors; the user is retrying the repaired link. A cold first app launch previously exited to Android home; readiness now requires the Expedia package and permits one bounded restart before any login input. No verification submission is replayed.

These measurements exclude the host OS and unrelated applications; a physical machine with only 2 GB including its OS is not established by these tests. Interactive challenges were not encountered and remain unverified. Guest internal zram, if used by Android, remains within guest RAM.

The authenticated lab state was retained privately; the guest and container were stopped after testing. The original host module-loader path was verified. Unloading the Binder module loaded for Redroid returned `Device or resource busy`; it was not forcibly removed. No flight purchase was submitted.
