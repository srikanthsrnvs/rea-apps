// Optional adapter for your own frontend. ChatGPT/MCP Apps supply this bridge.
// `invoke` routes a named Spotify tool to the authenticated backend on the Orin.
const allowed = new Set(["spotify_status", "spotify_pause", "spotify_resume", "spotify_next", "spotify_previous", "spotify_seek"]);

export function mountSpotifyPlayer(container, { resource, output, invoke, theme = "light" }) {
  if (resource?.uri !== "ui://spotify/player-v1.html" || typeof resource.text !== "string")
    throw new Error("Load the Spotify player resource from the trusted Spotify tool server.");
  if (typeof invoke !== "function") throw new Error("An authenticated tool callback is required.");
  const frame = document.createElement("iframe");
  frame.title = "Spotify player";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "width:100%;height:480px;border:0;display:block";
  let disposed = false, initialized = false, current = output, tail = Promise.resolve();
  const post = message => { if (!disposed) frame.contentWindow?.postMessage({ jsonrpc: "2.0", ...message }, "*"); };
  const update = value => {
    current = value?.structuredContent || value;
    if (initialized) post({ method: "ui/notifications/tool-result", params: { structuredContent: current } });
  };
  const listener = async event => {
    if (disposed || event.source !== frame.contentWindow || event.origin !== "null") return;
    const message = event.data;
    if (message?.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/initialized") { initialized = true; if (current) update(current); return; }
    if (message.method === "ui/notifications/size-changed") {
      const height = message.params?.height;
      if (Number.isFinite(height)) frame.style.height = `${Math.min(1200, Math.max(280, height))}px`;
      return;
    }
    if (!Number.isSafeInteger(message.id)) return;
    try {
      let result;
      if (message.method === "ui/initialize") {
        result = { protocolVersion: "2026-01-26", hostInfo: { name: "spotify-player-host", version: "1" }, hostCapabilities: {}, hostContext: { theme } };
      } else if (initialized && message.method === "tools/call") {
        const { name, arguments: args = {} } = message.params || {};
        if (!allowed.has(name) || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Unsupported player action.");
        if (name === "spotify_seek") {
          if (Object.keys(args).some(key => !["seconds", "track-uri"].includes(key)) || !Number.isFinite(args.seconds) || args.seconds < 0 || typeof args["track-uri"] !== "string")
            throw new Error("Invalid seek input.");
        } else if (name === "spotify_status") {
          if (Object.keys(args).some(key => key !== "refresh") || (args.refresh !== undefined && typeof args.refresh !== "boolean"))
            throw new Error("Invalid refresh input.");
        } else if (Object.keys(args).length) throw new Error("This action takes no arguments.");
        const job = tail.then(() => {
          if (disposed) throw new Error("Player closed.");
          return invoke(name, args);
        });
        tail = job.catch(() => {});
        const response = await job;
        result = response?.structuredContent ? response : { structuredContent: response, isError: response?.ok === false };
      } else throw new Error("Unsupported player request.");
      post({ id: message.id, result });
    } catch (error) { post({ id: message.id, error: { code: -32000, message: error.message || "Player action failed." } }); }
  };
  window.addEventListener("message", listener);
  frame.srcdoc = resource.text;
  container.append(frame);
  return {
    frame, update,
    destroy() { disposed = true; window.removeEventListener("message", listener); frame.remove(); },
  };
}
