import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

export const SERVICES = ["_spotify-connect._tcp.local", "_googlecast._tcp.local", "_sonos._tcp.local"];
const MAX_RECORDS = 256;
const key = name => name.toLowerCase().replace(/\.$/, "");
export function privateIpv4(ip) {
  if (typeof ip !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const parts = ip.split("."), a = parts.map(Number);
  if (a.some((n, i) => n > 255 || String(n) !== parts[i])) return false;
  return a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
    (a[0] === 192 && a[1] === 168) || (a[0] === 169 && a[1] === 254);
}
export function localInterfaces() {
  return Object.values(networkInterfaces()).flat().filter(i => !i.internal && i.family === "IPv4" && privateIpv4(i.address)).map(i => i.address).sort();
}
function dnsName(buffer, start) {
  let offset = start, end, size = 0;
  const labels = [], visited = new Set();
  while (true) {
    if (offset >= buffer.length || visited.has(offset) || visited.size >= 128) throw Error("Invalid DNS name");
    visited.add(offset);
    const length = buffer[offset++];
    if (!length) return { name: labels.join("."), end: end ?? offset };
    if ((length & 0xc0) === 0xc0) {
      if (offset >= buffer.length) throw Error("Invalid DNS pointer");
      end ??= offset + 1;
      offset = ((length & 0x3f) << 8) | buffer[offset];
    } else {
      if (length > 63 || offset + length > buffer.length || (size += length + 1) > 255) throw Error("Invalid DNS label");
      labels.push(buffer.subarray(offset, offset + length).toString("utf8")); offset += length;
    }
  }
}
export function decodeRecords(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > 65535 || !(buffer.readUInt16BE(2) & 0x8000)) return [];
  try {
    const questions = buffer.readUInt16BE(4), count = buffer.readUInt16BE(6) + buffer.readUInt16BE(8) + buffer.readUInt16BE(10);
    if (questions > MAX_RECORDS || count > MAX_RECORDS) return [];
    let offset = 12;
    for (let i = 0; i < questions; i++) { offset = dnsName(buffer, offset).end + 4; if (offset > buffer.length) return []; }
    const records = [];
    for (let i = 0; i < count; i++) {
      const decoded = dnsName(buffer, offset); offset = decoded.end;
      if (offset + 10 > buffer.length) return [];
      const type = buffer.readUInt16BE(offset), cls = buffer.readUInt16BE(offset + 2) & 0x7fff,
        ttl = buffer.readUInt32BE(offset + 4), length = buffer.readUInt16BE(offset + 8), start = offset + 10, end = start + length;
      if (end > buffer.length) return [];
      offset = end;
      if (cls !== 1) continue;
      let data;
      if (type === 12) { const d = dnsName(buffer, start); if (d.end > end) return []; data = d.name; }
      else if (type === 33 && length >= 7) {
        const d = dnsName(buffer, start + 6); if (d.end > end) return [];
        data = { port: buffer.readUInt16BE(start + 4), target: d.name };
      } else if (type === 16) {
        data = {};
        for (let cursor = start; cursor < end;) {
          const n = buffer[cursor++]; if (cursor + n > end) return [];
          const text = buffer.subarray(cursor, cursor + n).toString("utf8"), split = text.indexOf("="); cursor += n;
          if (split > 0) Object.defineProperty(data, text.slice(0, split), { value: text.slice(split + 1), enumerable: true, configurable: true });
        }
      } else if (type === 1 && length === 4) data = [...buffer.subarray(start, end)].join(".");
      if (data !== undefined) records.push({ name: decoded.name, type, ttl, data });
    }
    return records;
  } catch { return []; }
}
export function encodeQuery(questions) {
  const header = Buffer.alloc(12); header.writeUInt16BE(questions.length, 4);
  return Buffer.concat([header, ...questions.map(({ name, type = 12 }) => {
    const labels = name.split(".");
    if (name.length > 253 || labels.some(s => !s || Buffer.byteLength(s) > 63)) throw Error("Invalid query name");
    const tail = Buffer.alloc(5); tail.writeUInt16BE(type, 1); tail.writeUInt16BE(0x8001, 3); // Request a unicast response.
    return Buffer.concat([...labels.map(s => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)])), tail]);
  })]);
}
export function servicesFromRecords(records) {
  const services = [];
  for (const ptr of records.filter(r => r.type === 12 && r.ttl && SERVICES.includes(key(r.name)))) {
    const name = key(ptr.data), srv = records.findLast(r => key(r.name) === name && r.type === 33 && r.ttl);
    if (!srv?.data.port) continue;
    const addresses = records.filter(r => key(r.name) === key(srv.data.target) && r.type === 1 && r.ttl && privateIpv4(r.data)).map(r => r.data);
    const txt = records.findLast(r => key(r.name) === name && r.type === 16 && r.ttl)?.data ?? {};
    if (addresses.length) services.push({ service: key(ptr.name), instance: ptr.data, host: srv.data.target,
      address: addresses[0], port: srv.data.port, txt });
  }
  return services;
}

// One short scan on every private IPv4 interface. No daemon, system packages,
// audio receiver, or Spotify credentials are involved. QU works from an ephemeral port.
export async function browseServices({ timeoutMs = 2000, interfaces = localInterfaces(), socketFactory = createSocket } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 5000) throw Object.assign(new Error("Discovery timeout must be 250–5000 ms."), { code: "INVALID_ARGUMENT" });
  const records = new Map(), sockets = [], warnings = new Set(), requested = new Set();
  const send = (socket, questions) => {
    try { socket.send(encodeQuery(questions), 5353, "224.0.0.251", error => { if (error) warnings.add("MDNS_SEND_FAILED"); }); }
    catch { warnings.add("MDNS_SEND_FAILED"); }
  };
  const receive = (buffer, sender) => {
    if (!privateIpv4(sender?.address)) return;
    const decoded = decodeRecords(buffer);
    for (const record of decoded) {
      const id = JSON.stringify([key(record.name), record.type, record.data]);
      if (!record.ttl) records.delete(id);
      else if (records.has(id) || records.size < 1024) records.set(id, record);
    }
    const known = [...records.values()];
    for (const record of decoded.filter(r => r.ttl)) {
      const questions = record.type === 12 && SERVICES.includes(key(record.name)) ? [{ name: record.data, type: 33 }, { name: record.data, type: 16 }]
        : record.type === 33 && SERVICES.some(s => key(record.name).endsWith(`.${s}`)) ? [{ name: record.data.target, type: 1 }] : [];
      for (const q of questions) {
        if (known.some(r => r.type === q.type && key(r.name) === key(q.name))) continue;
        const id = JSON.stringify(q);
        if (requested.size < 256 && !requested.has(id)) { requested.add(id); for (const s of sockets) send(s, [q]); }
      }
    }
  };
  const bindings = interfaces.filter(privateIpv4).slice(0, 8).map(address => new Promise(resolve => {
    let socket;
    try { socket = socketFactory({ type: "udp4" }); sockets.push(socket); }
    catch { warnings.add("MDNS_UNAVAILABLE"); resolve(); return; }
    socket.on("error", () => { warnings.add("MDNS_UNAVAILABLE"); resolve(); });
    socket.on("message", receive);
    try { socket.bind(0, address, () => {
      try { socket.setMulticastInterface(address); socket.setMulticastTTL(255); } catch { warnings.add("MDNS_INTERFACE_UNAVAILABLE"); }
      send(socket, SERVICES.map(name => ({ name }))); resolve();
    }); } catch { warnings.add("MDNS_UNAVAILABLE"); resolve(); }
  }));
  if (!bindings.length) return { services: [], warnings: ["NO_PRIVATE_IPV4_INTERFACE"] };
  let timer, repeat;
  try { await new Promise(resolve => {
    timer = setTimeout(resolve, timeoutMs);
    if (timeoutMs >= 1250) repeat = setTimeout(() => {
      for (const socket of sockets) send(socket, SERVICES.map(name => ({ name })));
    }, 1000);
  }); }
  finally { clearTimeout(timer); clearTimeout(repeat); for (const socket of sockets) { try { socket.close(); } catch { /* Already closed. */ } } }
  return { services: servicesFromRecords([...records.values()]), warnings: [...warnings] };
}
