import test from "node:test";
import assert from "node:assert/strict";
import { spotifyUri, spotifyUris, spotifyId } from "../src/standalone/uri.mjs";

test("resource helpers accept official localized URLs and preserve requested order", () => {
  assert.equal(spotifyUri("https://open.spotify.com/intl-en/track/one?si=x"), "spotify:track:one");
  assert.equal(spotifyId("https://open.spotify.com/playlist/list", "playlist"), "list");
  assert.deepEqual(spotifyUris("spotify:track:one,spotify:episode:two"), ["spotify:track:one", "spotify:episode:two"]);
});

test("resource helpers reject alternate destinations, malformed paths and wrong resource types", () => {
  for (const input of ["https://evil.test/track/one", "https://open.spotify.com/track/one/extra", "spotify:track:../secret", "spotify:track:x?token=secret", "spotify:track:", ""])
    assert.throws(() => spotifyUri(input), { code: "INVALID_ARGUMENT" });
  assert.throws(() => spotifyId("spotify:track:one", "playlist"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => spotifyUris([]), { code: "INVALID_ARGUMENT" });
});
