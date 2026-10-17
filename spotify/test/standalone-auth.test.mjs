import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "spotify-native-auth-"));
process.env.SPOTIFY_STATE_DIR = directory;
const { readState, saveState, withStateLock } = await import("../src/standalone/state.mjs");
const { login, loginStatus, getSession, logout } = await import("../src/standalone/auth.mjs");
const { execute } = await import("../src/client.mjs");
const originalFetch = globalThis.fetch;
const authorization = { device_code: "private-device-code", user_code: "ABC123", verification_uri: "https://spotify.com/pair", verification_uri_complete: "https://spotify.com/pair?code=ABC123", expires_in: 3600, interval: 5 };
const tokens = { access_token: "private-access-token", refresh_token: "private-refresh-token", token_type: "Bearer", expires_in: 3600, scope: "user-read-playback-state" };
test.after(async () => { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });

test("new-machine login and renewal use only HTTPS device/token requests and private state", async () => {
  const calls = [];
  let phase = "authorize";
  globalThis.fetch = async (url, options) => {
    calls.push({url,params:options.body});
    assert.equal(options.redirect, "error");
    if (phase === "authorize") return Response.json(authorization);
    if (phase === "pending") return Response.json({error:"authorization_pending"},{status:400});
    if (phase === "slow") return Response.json({error:"slow_down"},{status:400});
    if (phase === "transient") return Response.json({error:"server_error"},{status:503,headers:{"retry-after":"20"}});
    if (phase === "approved") return Response.json(tokens);
    return Response.json({...tokens,access_token:"renewed-access-token",refresh_token:undefined});
  };
  const started = await login();
  assert.equal(started.verificationUri, authorization.verification_uri_complete);
  assert.ok(!JSON.stringify(started).includes("private-device-code"));
  assert.equal((await login()).userCode,"ABC123");
  assert.equal(calls.length,1,"Repeated login must reuse pending approval");
  assert.equal((await loginStatus()).phase,"awaiting_approval");
  assert.equal(calls.length,1,"Do not poll before the server interval");
  const ready = async () => { const p=await readState("login");p.nextPollAt=0;await saveState("login",p); };
  phase="pending";await ready();assert.equal((await loginStatus()).phase,"awaiting_approval");
  phase="slow";await ready();await loginStatus();
  assert.equal((await readState("login")).intervalMs,10000);
  phase="transient";await ready();
  assert.equal((await loginStatus()).temporaryError,"AUTH_SERVICE_UNAVAILABLE");
  assert.equal((await readState("login")).error,undefined);
  assert.ok((await readState("login")).nextPollAt >= Date.now()+19000);
  phase="approved";await ready();assert.equal((await loginStatus()).loggedIn,true);
  const session=await readState("session");assert.equal(session.refreshToken,"private-refresh-token");
  assert.equal(session.controllerId.length,32);
  assert.equal((await fs.stat(path.join(directory,"session.json"))).mode&0o777,0o600);
  assert.equal(await readState("login"),null);
  phase="refresh";
  const refreshed=await withStateLock(()=>getSession({refresh:true}));
  assert.equal(refreshed.accessToken,"renewed-access-token");
  assert.equal(refreshed.refreshToken,"private-refresh-token");
  assert.equal(calls.at(-1).params.get("grant_type"),"refresh_token");
  assert.ok(!JSON.stringify(await loginStatus()).includes("token"));
  await logout();assert.equal((await loginStatus()).phase,"logged_out");
});

test("independent commands share one state lock and recover only dead owners", async () => {
  let active=0,peak=0;
  await Promise.all(Array.from({length:5},()=>withStateLock(async()=>{
    peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,10));active--;
  })));
  assert.equal(peak,1);
  const lock=path.join(directory,".locks","dead.json");
  await fs.writeFile(lock,JSON.stringify({id:"dead",pid:2147483646,host:os.hostname(),ticket:1}));
  await withStateLock(async()=>assert.equal(await fs.stat(lock).catch(()=>null),null));
});

test("default unsupported desktop actions cannot contact or launch a desktop app", async () => {
  let calls=0;globalThis.fetch=async()=>{calls++;throw Error("Should not contact runtime");};
  await assert.rejects(execute("settings"),{code:"UNSUPPORTED"});
  assert.equal(calls,0);
  const {connectSpotify}=await import("../src/lifecycle.mjs");
  const previous=process.env.SPOTIFY_BACKEND;
  try {
    process.env.SPOTIFY_BACKEND="typo";
    await assert.rejects(connectSpotify(),{code:"INVALID_ARGUMENT"});
  } finally { if(previous===undefined)delete process.env.SPOTIFY_BACKEND;else process.env.SPOTIFY_BACKEND=previous; }
});

test("revoked authorization permits a fresh pairing instead of claiming cached login forever", async () => {
  await saveState("session",{accessToken:"private-access",refreshToken:"private-refresh",expiresAt:0});
  globalThis.fetch=async()=>Response.json({error:"invalid_grant"},{status:400});
  await assert.rejects(withStateLock(()=>getSession()),{code:"AUTHENTICATION_REQUIRED"});
  assert.equal((await loginStatus()).phase,"reauth_required");
  globalThis.fetch=async()=>Response.json(authorization);
  assert.equal((await login()).userCode,"ABC123");
});
