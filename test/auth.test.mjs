import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spotifyAuthRuntime } from "../src/auth-runtime.mjs";

const str = (field, value) => {
  const bytes = new TextEncoder().encode(value);
  return [field * 8 + 2, bytes.length, ...bytes];
};
function mock() {
  let loggedIn = false;
  let stream;
  let starts = 0;
  const context = vm.createContext({
    TextEncoder,
    TextDecoder,
    URL,
    Uint8Array,
    DataView,
    ArrayBuffer,
    setTimeout,
    clearTimeout,
    window: {
      location: {
        hostname: "login.app.spotify.com",
        href: "https://login.app.spotify.com/index.html",
      },
      cancelEsperantoCall() {},
      executeEsperantoCall({ request, persistent, onSuccess }) {
        const view = new DataView(request);
        const bytes = new Uint8Array(request);
        let offset = 0;
        const parts = [];
        for (let i = 0; i < 3; i++) {
          const length = view.getInt32(offset);
          parts.push(bytes.slice(offset + 4, offset + 4 + length));
          offset += 4 + length;
        }
        assert.equal(offset, bytes.length);
        assert.equal(
          new TextDecoder().decode(parts[0]),
          "spotify.desktop.login_esperanto.proto.DesktopLogin",
        );
        assert.equal(parts[2].length, 0);
        const method = new TextDecoder().decode(parts[1]);
        if (method === "GetSessionState") {
          assert.equal(persistent, false);
          onSuccess(new Uint8Array(loggedIn ? [8, 1, ...str(2, "test-user")] : []).buffer);
        } else {
          assert.equal(method, "LoginWithQRCode");
          assert.equal(persistent, true);
          starts++;
          stream = (bytes) => onSuccess(new Uint8Array(bytes).buffer);
          const approval = [...str(1, "https://spotify.com/pair?code=ABC123"), ...str(2, "ABC123")];
          stream([10, approval.length, ...approval]);
        }
        return starts;
      },
    },
  });
  return {
    invoke: async (name) =>
      JSON.parse(
        JSON.stringify(
          await vm.runInContext(
            `(${spotifyAuthRuntime.toString()})(${JSON.stringify(name)})`,
            context,
          ),
        ),
      ),
    emit: (bytes) => stream(bytes),
    loggedIn: () => {
      loggedIn = true;
    },
    starts: () => starts,
    href: () => context.window.location.href,
  };
}

test("pairing survives separate calls, reuses pending code, and accepts empty success messages", async () => {
  const app = mock();
  assert.equal((await app.invoke("login-status")).result.phase, "logged_out");
  const first = await app.invoke("login");
  assert.equal(first.result.userCode, "ABC123");
  assert.deepEqual(await app.invoke("login"), first);
  assert.equal(app.starts(), 1);
  assert.equal(app.href(), "https://login.app.spotify.com/index.html");
  app.emit([18, 0]);
  assert.equal(app.href(), "spotify:app:xpui");
  assert.equal((await app.invoke("login-status")).result.phase, "authenticated");
  app.loggedIn();
  assert.deepEqual((await app.invoke("login")).result, {
    loggedIn: true,
    phase: "authenticated",
    username: "test-user",
  });
  assert.equal(app.starts(), 1);
});

test("expiry permits another pairing attempt; malformed messages fail without returning payloads", async () => {
  const app = mock();
  await app.invoke("login");
  app.emit([24, 1]);
  assert.equal((await app.invoke("login-status")).result.phase, "expired");
  await app.invoke("login");
  assert.equal(app.starts(), 2);
  app.emit([10, 127, 1]);
  const result = await app.invoke("login-status");
  assert.equal(result.result.phase, "error");
  assert.equal(result.result.errorCode, -1);
  assert.equal(JSON.stringify(result).includes("payload"), false);
});

test("unknown protobuf fields do not hide terminal native errors", async () => {
  const app = mock();
  await app.invoke("login");
  app.emit([80, 1, 34, 2, 8, 7]);
  assert.equal((await app.invoke("login-status")).result.errorCode, 7);
});
