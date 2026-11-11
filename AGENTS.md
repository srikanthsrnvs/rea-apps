# REA apps agent guide

These apps run on a headless NVIDIA Orin with limited RAM. Read the root README,
the target app's README, authentication protocol and agent guide before changing
its runtime or login design.

- No Chrome, CDP, Playwright, browser sessions, desktop apps, Android runtimes,
  emulators or display servers on the host, including during login.
- Login happens on the user's separate device. Use a genuine provider-issued
  device grant, callback, verification code or documented widget handoff. An
  ordinary login page does not transfer a session to this installation.
- Validate the acquired account through an independent API read before replacing
  a saved session. Preserve the previous account when replacement fails.
- Persist pending exchanges and distinguish uncertain submissions from safe
  validation retries. Never invent an OAuth client, redirect or polling API.
- Keep passwords, cookies, grants and callback credentials out of command output,
  logs and Git. Protect credential records with directory 0700/file 0600 modes.
- Keep public reads usable without login where the provider allows them.
- Prefer one-shot native Node HTTP/WebSocket commands. Start temporary login
  workers/tunnels only when the actual provider flow needs them, and close them
  on completion, cancellation and expiry.
- Bound bodies, frames, pages, symbols, history, concurrent requests and retained
  stream data. Measure peak RSS; label development-host measurements separately
  from ARM64 Orin results. Do not add persistent services or heavyweight runtime
  dependencies to hide a missing protocol implementation.
- Reuse the existing strict JSON CLI/tool-schema, safe-error, state and installer
  conventions. Separate deterministic tests from requested live side effects.

Useful references: Spotify/Instagram device grants; Resy's widget handoff;
Claude/Airbnb verification relays; ChatGPT/Amazon code exchanges; OpenTable's
candidate-session validation and uncertain-exchange handling.
