import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { browseServices, decodeRecords, encodeQuery, privateIpv4, servicesFromRecords } from "../src/standalone/mdns.mjs";
import { discoverNetwork, mergeDevices } from "../src/standalone/discovery.mjs";

const service = "_spotify-connect._tcp.local", instance = `LSX II.${service}`, host = "speaker.local";
const name = s => Buffer.concat([...s.split(".").map(p => Buffer.concat([Buffer.from([Buffer.byteLength(p)]), Buffer.from(p)])), Buffer.from([0])]);
function packet(rows) {
  const header = Buffer.alloc(12); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(rows.length, 6);
  return Buffer.concat([header, ...rows.map(([n, type, data, ttl = 120]) => {
    const h = Buffer.alloc(10); h.writeUInt16BE(type); h.writeUInt16BE(1, 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(data.length, 8);
    return Buffer.concat([name(n), h, data]);
  })]);
}
function response(ttl = 120) {
  const srv = Buffer.alloc(6); srv.writeUInt16BE(1234, 4);
  const txt = Buffer.concat([Buffer.from([7]), Buffer.from("CPath=/")]);
  return packet([[service, 12, name(instance), ttl], [instance, 33, Buffer.concat([srv, name(host)])],
    [instance, 16, txt], [host, 1, Buffer.from([192, 168, 1, 12])]]);
}
test("DNS wire records assemble Connect services, resolve split replies and reject malformed compression", () => {
  const decoded = decodeRecords(response());
  const [s] = servicesFromRecords(decoded);
  assert.equal(s.address, "192.168.1.12"); assert.equal(s.port, 1234); assert.equal(s.txt.CPath, "/");
  assert.deepEqual(servicesFromRecords(decodeRecords(response(0))), []);
  const pointerLoop = Buffer.alloc(24); pointerLoop.writeUInt16BE(0x8400, 2); pointerLoop.writeUInt16BE(1, 6); pointerLoop[12] = 0xc0; pointerLoop[13] = 12;
  assert.deepEqual(decodeRecords(pointerLoop), []);
  assert.deepEqual(decodeRecords(response().subarray(0, 30)), []);
  assert.deepEqual(decodeRecords(Buffer.alloc(100000)), []);
  assert.equal(encodeQuery([{ name: service }]).readUInt16BE(4), 1);
  assert.equal(encodeQuery([{ name: service }]).readUInt16BE(encodeQuery([{ name: service }]).length - 2), 0x8001);
  const compressed = packet([[service, 12, Buffer.concat([Buffer.from([3]), Buffer.from("LSX"), Buffer.from([0xc0, 12])])]]);
  assert.equal(decodeRecords(compressed)[0].data, `LSX.${service}`);
});
test("bounded UDP browse uses private interfaces, ignores off-LAN packets and closes every socket", async () => {
  const sockets = [];
  const result = await browseServices({ timeoutMs: 250, interfaces: ["192.168.1.2", "8.8.8.8"], socketFactory: () => {
    const s = new EventEmitter(); sockets.push(s);
    s.bind = (_port, ip, callback) => { assert.equal(ip, "192.168.1.2"); queueMicrotask(callback); };
    s.setMulticastInterface = () => {}; s.setMulticastTTL = () => {};
    s.send = (_body, port, group, callback) => { assert.equal(port, 5353); assert.equal(group, "224.0.0.251"); callback();
      if (!s.sent) { s.sent = true; queueMicrotask(() => { s.emit("message", response(), { address: "8.8.8.8" }); s.emit("message", response(), { address: "192.168.1.12" }); }); } };
    s.close = () => { s.closed = true; }; return s;
  } });
  assert.equal(result.services.length, 1); assert.equal(sockets.length, 1); assert.ok(sockets.every(s => s.closed));
  assert.deepEqual(result.warnings, []);
  assert.equal(sockets[0].sent, true);
});
test("network speaker metadata never receives Spotify credentials; Cast is discoverable without audio or login", async () => {
  let requests = 0;
  const services = servicesFromRecords(decodeRecords(response()));
  services.push({ service: "_googlecast._tcp.local", instance: "Kitchen._googlecast._tcp.local", address: "192.168.1.13", port: 8009, txt: { fn: "Kitchen" } });
  const result = await discoverNetwork({ browse: async () => ({ services, warnings: [] }), fetchImpl: async (url, options) => {
    requests++; assert.equal(url, "http://192.168.1.12:1234/?action=getInfo");
    assert.deepEqual(options.headers, { Accept: "application/json" }); assert.equal(options.redirect, "error");
    return Response.json({ deviceID: "speaker-id", remoteName: "LSX II", deviceType: "SPEAKER", tokenType: "accesstoken" });
  } });
  assert.equal(requests, 1); assert.equal(result.devices.length, 2);
  assert.ok(result.devices.every(d => d.available === false && d.accountVisibility === "unknown"));
  assert.equal(result.devices[1].protocol, "google-cast");
  const account = [{ id: "speaker-id", name: "LSX", active: true, available: true, volume: 23 }];
  const merged = mergeDevices(account, result.devices);
  assert.equal(merged.length, 2); assert.equal(merged[0].active, true); assert.equal(merged[0].volume, 23);
  assert.equal(merged[0].local, true); assert.equal(account[0].local, undefined);
  assert.equal(merged[0].requiresActivation, false); assert.equal(merged[1].requiresActivation, true);
  assert.equal(mergeDevices([{ ...account[0], id: "speaker-id::a_7" }], result.devices)[0].local, true);
});
test("one physical speaker advertising Connect and Cast appears once with both protocols", async () => {
  const services = servicesFromRecords(decodeRecords(response()));
  services[0].port = 80;
  services.push({ service: "_googlecast._tcp.local", instance: "LSX._googlecast._tcp.local", address: services[0].address, port: 8009, txt: {} });
  const result = await discoverNetwork({ browse: async () => ({ services, warnings: [] }), fetchImpl: async () => Response.json({ deviceID: "speaker-id" }) });
  assert.equal(result.devices.length, 1); assert.equal(result.devices[0].port, 80);
  assert.deepEqual(result.devices[0].protocols, ["spotify-connect", "google-cast"]);
  assert.equal(result.devices[0].cast.port, 8009);
});
test("LAN probes reject public/loopback targets, injected paths and redirects without masking account devices", async () => {
  const base = servicesFromRecords(decodeRecords(response()))[0]; let calls = 0;
  const services = [{ ...base, address: "8.8.8.8" }, { ...base, address: "127.0.0.1" }, { ...base, txt: { CPath: "//other.example/" } }, { ...base, txt: { CPath: "/?action=addUser" } }, base];
  const result = await discoverNetwork({ browse: async () => ({ services, warnings: [] }), fetchImpl: async () => { calls++; throw Error("redirect contains private data"); } });
  assert.equal(calls, 1); assert.deepEqual(result.devices, []); assert.deepEqual(result.warnings, ["SPEAKER_INFO_UNAVAILABLE"]);
  for (const address of ["localhost", "127.0.0.1", "0.0.0.0", "8.8.8.8", "10.0.0.999", "10.0.0.1.evil", "010.0.0.1"]) assert.equal(privateIpv4(address), false);
});

test("split mDNS replies trigger only missing-record questions; goodbye removes the device", async () => {
  const srv = Buffer.alloc(6); srv.writeUInt16BE(1234, 4);
  const sent = []; let closed = false;
  const result = await browseServices({ timeoutMs: 250, interfaces: ["192.168.1.2"], socketFactory: () => {
    const s = new EventEmitter(); s.bind = (_p, _ip, cb) => queueMicrotask(cb);
    s.setMulticastInterface = () => {}; s.setMulticastTTL = () => {};
    s.send = (query, _p, _ip, cb) => {
      sent.push(query); cb();
      if (sent.length === 1) queueMicrotask(() => {
        s.emit("message", packet([[service, 12, name(instance)]]), { address: "192.168.1.12" });
        s.emit("message", packet([[instance, 33, Buffer.concat([srv, name(host)])], [instance, 16, Buffer.alloc(0)]]), { address: "192.168.1.12" });
        s.emit("message", packet([[host, 1, Buffer.from([192, 168, 1, 12])]]), { address: "192.168.1.12" });
        s.emit("message", packet([[service, 12, name(instance), 0]]), { address: "192.168.1.12" });
      });
    }; s.close = () => { closed = true; }; return s;
  } });
  assert.equal(sent.length, 4, "Initial browse, missing SRV/TXT, then missing address");
  assert.deepEqual(result.services, []); assert.ok(closed);
});
test("multicast errors are reported without leaking sockets or throwing away account availability", async () => {
  let closed = false;
  const result = await browseServices({ timeoutMs: 250, interfaces: ["192.168.1.2"], socketFactory: () => {
    const s = new EventEmitter(); s.bind = () => queueMicrotask(() => s.emit("error", Error("EPERM")));
    s.close = () => { closed = true; }; return s;
  } });
  assert.deepEqual(result.services, []); assert.deepEqual(result.warnings, ["MDNS_UNAVAILABLE"]); assert.ok(closed);
  const account = [{ id: "speaker", available: true, active: true }];
  assert.deepEqual(mergeDevices(account, result.services), account);
});
