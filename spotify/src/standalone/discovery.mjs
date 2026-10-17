import { browseServices, localInterfaces, privateIpv4 } from "./mdns.mjs";
import { createReadCache } from "./read-cache.mjs";

function speakerUrl(service) {
  if (!privateIpv4(service.address) || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return null;
  const sonos = service.service === "_sonos._tcp.local", path = sonos ? "/spotifyzc" : service.txt?.CPath ?? "/";
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\x00-\x20\\?#]/.test(path) || path.length > 512) return null;
  return `http://${service.address}:${sonos ? 1400 : service.port}${path}`;
}
async function getInfo(url, fetchImpl) {
  const response = await fetchImpl(`${url}?action=getInfo`, { redirect: "error", signal: AbortSignal.timeout(1200), headers: { Accept: "application/json" } });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
  const chunks = []; let length = 0;
  for await (const c of response.body ?? []) {
    length += c.length;
    if (length > 65536) throw Error("Speaker info too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const safeName = (s, fallback) => typeof s === "string" && s.length && s.length <= 256 ? s : fallback;
export async function discoverNetwork({ timeoutMs = 2000, browse = browseServices, fetchImpl = fetch } = {}) {
  const { services, warnings } = await browse({ timeoutMs });
  const found = new Map(), notes = new Set(warnings);
  // Sequential batches cap sockets and response memory even on busy LANs.
  for (let i = 0; i < Math.min(services.length, 32); i += 4) {
    const batch = await Promise.all(services.slice(i, i + 4).map(async service => {
      if (!privateIpv4(service.address)) return null;
      const fallback = safeName(service.txt?.fn, service.instance.split("._")[0]);
      if (service.service === "_googlecast._tcp.local") return {
        id: `cast:${service.address}:${service.port}`, name: fallback, type: "speaker", protocol: "google-cast",
        address: service.address, port: service.port, local: true, active: false, available: false,
        supportsVolume: false, volume: null, accountVisibility: "unknown",
      };
      const url = speakerUrl(service);
      if (!url) return null;
      try {
        const info = await getInfo(url, fetchImpl);
        if (!info || typeof info.deviceID !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(info.deviceID)) return null;
        return { id: info.deviceID, name: safeName(info.remoteName, fallback), type: safeName(info.deviceType, "speaker").toLowerCase(),
          protocol: "spotify-connect", address: service.address, port: Number(new URL(url).port || 80),
          local: true, active: false, available: false, supportsVolume: false, volume: null,
          accountVisibility: "unknown", tokenType: safeName(info.tokenType, null) };
      } catch { notes.add("SPEAKER_INFO_UNAVAILABLE"); return null; }
    }));
    for (const device of batch) if (device && !found.has(device.id)) found.set(device.id, device);
  }
  const devices = [...found.values()].filter(d => {
    if (d.protocol !== "google-cast") return true;
    const connect = [...found.values()].filter(c => c.protocol === "spotify-connect" && c.address === d.address);
    if (connect.length !== 1) return true;
    connect[0].protocols = ["spotify-connect", "google-cast"];
    connect[0].cast = { address: d.address, port: d.port };
    return false;
  });
  return { devices, warnings: [...notes], source: "local-network" };
}

export function mergeDevices(accountDevices, networkDevices) {
  const devices = accountDevices.map(d => ({ ...d })), claimed = new Set();
  for (const local of networkDevices) {
    const matches = devices.filter(d => d.id.split("::a_")[0] === local.id);
    if (matches.length) {
      for (const d of matches) Object.assign(d, { local: true, protocol: "spotify-connect", address: local.address, port: local.port,
        ...(local.protocols ? { protocols: local.protocols, cast: local.cast } : {}), accountVisibility: "listed", requiresActivation: false });
      claimed.add(local.id);
    } else if (!claimed.has(local.id)) { devices.push({ ...local, accountVisibility: "not-listed", requiresActivation: true }); claimed.add(local.id); }
  }
  return devices;
}

// Cached independently from account data; interface changes invalidate the result.
export async function discoverSpeakers({ refresh = false, timeoutMs = 2000 } = {}) {
  const interfaces = localInterfaces();
  const cache = createReadCache({ namespace: JSON.stringify(interfaces), storeName: "discovery-cache", maxEntries: 1, maxBytes: 131072 });
  try {
    const result = await cache.get("speakers", 30000, () => discoverNetwork({ timeoutMs }), { refresh });
    return result;
  } finally { await cache.flush(); }
}
