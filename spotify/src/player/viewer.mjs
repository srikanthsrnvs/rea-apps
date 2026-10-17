import { mountSpotifyPlayer } from "/host.mjs";
const key = new URLSearchParams(location.hash.slice(1)).get("key");
const error = document.getElementById("error");
try {
  if (!key) throw Error("Open the complete player link, including its access key.");
  const response = await fetch("/resource", { cache: "no-store" });
  if (!response.ok) throw Error("This player link has expired.");
  const resource = await response.json();
  window.spotifyPlayer = mountSpotifyPlayer(document.getElementById("player"), {
    resource,
    invoke: async (name, args) => {
      const response = await fetch("/rpc", { method: "POST", cache: "no-store", credentials: "omit",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name, arguments: args }) });
      if (!response.ok) throw Error(response.status === 410 ? "This player link has expired." : "The player connection was rejected. Reopen the complete link.");
      return response.json();
    },
  });
  window.addEventListener("pagehide", () => window.spotifyPlayer.destroy(), { once: true });
} catch (e) { error.textContent = e.message; }
