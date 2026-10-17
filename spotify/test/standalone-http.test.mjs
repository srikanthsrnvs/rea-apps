import test from "node:test";
import assert from "node:assert/strict";
import { createRequest, spotifyUrl } from "../src/standalone/http.mjs";

test("native HTTP only accepts approved endpoints and repeats resolver query keys", () => {
  assert.equal(spotifyUrl("https://apresolve.spotify.com/", { type: ["dealer", "spclient"] }).search, "?type=dealer&type=spclient");
  for (const url of ["http://spclient.wg.spotify.com/", "https://api.spotify.com/v1/me", "https://spotify.com.evil.example/", "https://a:b@guc3-spclient.spotify.com/", "https://guc3-spclient.spotify.com:444/", "https://guc3-spclient.spotify.com/#token"]) {
    assert.throws(() => spotifyUrl(url), { code: "INVALID_ENDPOINT" });
  }
});
test("native HTTP keeps bearer private, refuses redirects and never replays mutations", async () => {
  let calls = 0;
  const request = createRequest(async () => "private-token", { fetchImpl: async (url, options) => {
    calls++; assert.equal(options.headers.Authorization, "Bearer private-token"); assert.equal(options.redirect, "error");
    throw Error("connection with private-token lost");
  } });
  await assert.rejects(request("https://guc3-spclient.spotify.com/connect-state/v1/test", { method: "POST", body: {} }), error => error.code === "NETWORK_ERROR" && !error.message.includes("private-token"));
  assert.equal(calls, 1);
});
test("rate limits are surfaced with server delay without retries or raw body leakage", async () => {
  let calls = 0;
  const request = createRequest(async () => "private-token", { fetchImpl: async () => {
    calls++; return new Response('private body', { status: 429, headers: { "retry-after": "30" } });
  } });
  await assert.rejects(request("https://api-partner.spotify.com/pathfinder/v2/query"), error => error.code === "RATE_LIMITED" && error.details.retryAfterSeconds === 30 && !error.message.includes("private body"));
  assert.equal(calls, 1);
});
test("public endpoint discovery receives no bearer and client code cannot override credentials", async () => {
  const request = createRequest(async () => "private-token", { fetchImpl: async (_, options) => {
    assert.equal(options.headers.Authorization, undefined); return Response.json({ dealer: [] });
  } });
  assert.deepEqual(await request("https://apresolve.spotify.com/"), { dealer: [] });
  await assert.rejects(request("https://spclient.wg.spotify.com/", { headers: { authorization: "other" } }), { code: "INVALID_HEADER" });
});

test("an outdated native persisted query remains actionable through the real HTTP helper", async () => {
  const request=createRequest(async()=>"private-token",{fetchImpl:async()=>Response.json({errors:[{message:"PersistedQueryNotFound"}]})});
  await assert.rejects(request("https://api-partner.spotify.com/pathfinder/v2/query"),{code:"QUERY_VERSION_UNSUPPORTED"});
});
