// Narrow native DesktopLogin bridge. Credentials never leave the Spotify process.
// This function is serialized into the desktop renderer; keep it self-contained.
export async function spotifyAuthRuntime(action) {
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  if (typeof window.executeEsperantoCall !== "function")
    return fail("NOT_READY", "Spotify's native login bridge is not ready.");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  function fields(buffer) {
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    function varint() {
      let value = 0;
      let factor = 1;
      for (let i = 0; i < 10; i++) {
        if (offset >= bytes.length) throw new Error("Truncated protobuf");
        const byte = bytes[offset++];
        value += (byte & 127) * factor;
        if (!(byte & 128)) {
          if (!Number.isSafeInteger(value)) throw new Error("Oversized protobuf integer");
          return value;
        }
        factor *= 128;
      }
      throw new Error("Invalid protobuf integer");
    }
    const result = new Map();
    while (offset < bytes.length) {
      const tag = varint();
      const number = Math.floor(tag / 8);
      const wire = tag % 8;
      if (!number) throw new Error("Invalid protobuf field");
      let value;
      if (wire === 0) value = varint();
      else if (wire === 2) {
        const length = varint();
        if (length > bytes.length - offset) throw new Error("Truncated protobuf field");
        value = bytes.slice(offset, offset + length);
        offset += length;
      } else if (wire === 1 || wire === 5) {
        offset += wire === 1 ? 8 : 4;
        if (offset > bytes.length) throw new Error("Truncated protobuf field");
        continue;
      } else throw new Error("Unsupported protobuf wire type");
      result.set(number, value);
    }
    return result;
  }
  function call(method, persistent, onSuccess, onFailure) {
    const chunks = [
      encoder.encode("spotify.desktop.login_esperanto.proto.DesktopLogin"),
      encoder.encode(method),
      new Uint8Array(),
    ];
    const request = new Uint8Array(chunks.reduce((sum, chunk) => sum + 4 + chunk.length, 0));
    const view = new DataView(request.buffer);
    let offset = 0;
    for (const chunk of chunks) {
      view.setInt32(offset, chunk.length);
      request.set(chunk, offset + 4);
      offset += chunk.length + 4;
    }
    return window.executeEsperantoCall({
      request: request.buffer,
      persistent,
      onSuccess,
      onFailure,
    });
  }
  try {
    const session = await new Promise((resolve, reject) => {
      let handle;
      const timer = setTimeout(() => {
        if (handle !== undefined) window.cancelEsperantoCall(handle);
        reject(new Error("Native session check timed out"));
      }, 8000);
      handle = call(
        "GetSessionState",
        false,
        (buffer) => {
          clearTimeout(timer);
          try {
            resolve(fields(buffer));
          } catch (error) {
            reject(error);
          }
        },
        () => {
          clearTimeout(timer);
          reject(new Error("Native session check failed"));
        },
      );
    });
    if (session.get(1)) {
      if (action === "login" && window.location?.hostname === "login.app.spotify.com")
        window.location.href = "spotify:app:xpui";
      return {
        ok: true,
        result: {
          loggedIn: true,
          phase: "authenticated",
          username: decoder.decode(session.get(2) ?? new Uint8Array()),
        },
      };
    }
    let state = window.__spotifyDesktopLogin;
    const publicState = () => ({
      loggedIn: false,
      phase: state?.phase ?? "logged_out",
      ...(state?.verificationUri
        ? { verificationUri: state.verificationUri, userCode: state.userCode }
        : {}),
      ...(state?.errorCode !== undefined ? { errorCode: state.errorCode } : {}),
    });
    if (action === "login-status") return { ok: true, result: publicState() };
    if (action !== "login") return fail("UNKNOWN_COMMAND", "Unknown login action.");
    if (state && ["starting", "awaiting_approval", "authenticated"].includes(state.phase))
      return { ok: true, result: publicState() };
    if (state?.handle !== undefined) window.cancelEsperantoCall(state.handle);
    state = window.__spotifyDesktopLogin = { phase: "starting" };
    state.handle = call(
      "LoginWithQRCode",
      true,
      (buffer) => {
        try {
          const response = fields(buffer);
          if (response.has(1)) {
            const approval = fields(response.get(1));
            const verificationUri = decoder.decode(approval.get(1) ?? new Uint8Array());
            const userCode = decoder.decode(approval.get(2) ?? new Uint8Array());
            const url = new URL(verificationUri);
            if (
              url.protocol !== "https:" ||
              !["spotify.com", "www.spotify.com", "accounts.spotify.com"].includes(url.hostname) ||
              !userCode
            )
              throw new Error("Invalid pairing instructions");
            Object.assign(state, { phase: "awaiting_approval", verificationUri, userCode });
          } else if (response.has(2)) {
            state.phase = "authenticated";
            if (window.location?.hostname === "login.app.spotify.com")
              window.location.href = "spotify:app:xpui";
          } else if (response.get(3)) state.phase = "expired";
          else if (response.has(4)) {
            state.phase = "error";
            state.errorCode = fields(response.get(4)).get(1) ?? -1;
          }
        } catch {
          state.phase = "error";
          state.errorCode = -1;
        }
      },
      () => {
        state.phase = "error";
        state.errorCode = -1;
      },
    );
    const deadline = Date.now() + 12000;
    while (state.phase === "starting" && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    return { ok: true, result: publicState() };
  } catch (error) {
    return fail("LOGIN_UNAVAILABLE", error.message);
  }
}
