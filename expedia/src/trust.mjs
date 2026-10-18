import os from 'node:os';
import v8 from 'node:v8';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { ExpediaError } from './errors.mjs';

// Source-pinned transport format; these public obfuscation bytes are not a signing key.
export const FORMAT_VERSION = '0740';
const OBFUSCATION_BYTES = Buffer.from([136, 38, 175, 196, 150, 158, 198, 189, 89, 18, 127, 181, 217, 177, 213, 241]);
const MAX_BYTES = 1024 * 1024;
const HTML_ESCAPES = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '=': '\\u003d', "'": '\\u0027', '\u2028': '\\u2028', '\u2029': '\\u2029' };
const UNSUPPORTED_COLLECTORS = [
  'AndroidBuildCollector', 'AndroidIdCollector', 'APKIdentityCollector', 'AndroidBatteryCollector',
  'AndroidCameraCollector', 'AndroidDisplayCollector', 'AndroidInputCollector', 'AndroidSensorsCollector',
  'AndroidConfigurationCollector', 'AndroidStorageCollector', 'AndroidRootDetectionCollector',
  'AndroidNetworkTypeCollector', 'VendorPhoneHomeCollector',
];

// Gson omits null object members, retains null array elements, and escapes HTML.
function gsonValue(value, inArray = false) {
  if (value === null || value === undefined) return inArray ? null : undefined;
  if (Array.isArray(value)) return value.map(item => gsonValue(item, true));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, gsonValue(item)]).filter(([, item]) => item !== undefined));
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Non-finite JSON number');
  return value;
}

export function serializeTrustPayload(payload) {
  const json = JSON.stringify(gsonValue(payload), null, 2).replace(/[<>&='\u2028\u2029]/g, character => HTML_ESCAPES[character]);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new RangeError('Trust payload too large');
  return Buffer.from(json, 'utf8').toString('base64');
}

export function decodeTrustPayload(encoded) {
  if (typeof encoded !== 'string' || encoded.length > MAX_BYTES * 2) throw new RangeError('Invalid Trust payload size');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

function lengthField(value) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > 0xffff) throw new RangeError('Blackbox field exceeds four-hex-digit length');
  return bytes.toString(16).padStart(4, '0') + value;
}

export function serializeBlackboxFields(input) {
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input);
  const filtered = entries.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
  if (filtered.length > 0xffff) throw new RangeError('Too many blackbox entries');
  return filtered.length.toString(16).padStart(4, '0') + filtered
    .map(([key, value]) => lengthField(String(key)) + lengthField(String(value))).join('');
}

export function encodeBlackbox(input, { mask = randomBytes(4) } = {}) {
  if (!Buffer.isBuffer(mask) || mask.length !== 4) throw new TypeError('Mask must contain four bytes');
  const serialized = serializeBlackboxFields(input);
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new RangeError('Blackbox too large');
  const compressed = deflateRawSync(Buffer.from(FORMAT_VERSION + serialized, 'utf8'));
  const result = Buffer.alloc(compressed.length + 4);
  for (let index = 0; index < compressed.length; index++) {
    result[index] = compressed[index] ^ OBFUSCATION_BYTES[index % 16] ^ mask[index % 4];
  }
  mask.copy(result, compressed.length);
  return FORMAT_VERSION + result.toString('base64');
}

export function decodeBlackbox(encoded) {
  if (typeof encoded !== 'string' || !encoded.startsWith(FORMAT_VERSION) || encoded.length > MAX_BYTES * 2) throw new TypeError('Invalid blackbox');
  const bytes = Buffer.from(encoded.slice(4), 'base64');
  if (bytes.length < 5) throw new TypeError('Truncated blackbox');
  const compressed = Buffer.alloc(bytes.length - 4), mask = bytes.subarray(bytes.length - 4);
  for (let index = 0; index < compressed.length; index++) {
    compressed[index] = bytes[index] ^ OBFUSCATION_BYTES[index % 16] ^ mask[index % 4];
  }
  const raw = inflateRawSync(compressed, { maxOutputLength: MAX_BYTES });
  let offset = 0;
  function take(length) {
    if (offset + length > raw.length) throw new TypeError('Truncated blackbox field');
    const value = raw.subarray(offset, offset + length);
    offset += length;
    return value;
  }
  function size() {
    const value = take(4).toString();
    if (!/^[0-9a-f]{4}$/.test(value)) throw new TypeError('Invalid blackbox field length');
    return parseInt(value, 16);
  }
  if (take(4).toString() !== FORMAT_VERSION) throw new TypeError('Wrong inner blackbox version');
  const count = size(), entries = [];
  for (let index = 0; index < count; index++) entries.push([take(size()).toString('utf8'), take(size()).toString('utf8')]);
  if (offset !== raw.length) throw new TypeError('Trailing blackbox bytes');
  return new Map(entries);
}

// Collection is local and truthful. No Android identifiers, package signatures,
// attestation, location, sensors, or vendor phone-home results are invented.
export async function collectLinuxTrust() {
  if (process.platform !== 'linux') throw new ExpediaError('UNSUPPORTED_PLATFORM', 'Expedia Trust collection currently supports Linux.');
  const started = performance.now(), errors = [];
  const actualOS = os.type(), heap = v8.getHeapStatistics();
  const fields = new Map([
    ['BBSC', actualOS], ['CLIENT_TIME', new Date().toISOString()],
    ['SDKVER', 'rea-linux-port/0.0.1'], ['APPID', 'rea-apps.expedia.cli'], ['APPN', 'REA Expedia CLI'],
    ['OSVER', os.release()], ['HOST', os.hostname()], ['UPTIME', String(os.uptime())],
  ]);
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const total = meminfo.match(/^MemTotal:\s+(\d+) kB$/m);
    if (total) fields.set('PHYMEM', String(BigInt(total[1]) / 1024n));
    else errors.push('LinuxMemoryCollector:missing MemTotal');
  } catch (error) { errors.push(`LinuxMemoryCollector:${error.code ?? error.name}`); }
  try {
    const cpuinfo = await readFile('/proc/cpuinfo', 'utf8');
    const cpu = cpuinfo.match(/^(?:Processor|model name)\s*:\s*(.+)$/m);
    if (cpu) fields.set('CPU', cpu[1].trim());
  } catch (error) { errors.push(`LinuxCPUCollector:${error.code ?? error.name}`); }
  // Native collector errors live inside EXCPT; a nonempty blackbox still completes.
  fields.set('PHEN', '0');
  fields.set('EXCPT', `REA Linux port: ${UNSUPPORTED_COLLECTORS.join(',')} unavailable; no Android identity fabricated`);
  fields.set('BBRT', String((performance.now() - started) / 1000));
  const blackbox = encodeBlackbox(fields);
  const elapsed = Math.max(0, Math.round(performance.now() - started));
  const payload = {
    configuredDependencies: [{ name: 'iovationname', payload: blackbox, status: blackbox ? 'COMPLETE' : 'REQUESTED' }],
    deviceInfo: { runtime: {
      availableProcessors: os.availableParallelism(), freeMemory: heap.total_heap_size - heap.used_heap_size,
      maxMemory: heap.heap_size_limit, totalMemory: heap.total_heap_size,
    } },
    diagnostics: {
      dependencies: [{ dependencies: [], errors: [], name: 'iovationname', timeToProducePayload: elapsed }],
      errors, timeToProducePayload: elapsed,
    },
    executionContext: { deviceName: os.hostname(), placement: 'DEFAULT', placementPage: 1, reportingSegment: `CLI,${actualOS},REA` },
    payloadSchemaVersion: 1, status: errors.length ? 'ERROR' : 'COMPLETE',
  };
  return {
    payload, encoded: serializeTrustPayload(payload),
    provenance: {
      implementation: 'source-ported codec; truthful host telemetry', platform: process.platform,
      arch: process.arch, node: process.version, networkCalls: 0, attestation: false, androidIdentity: false,
      unsupportedCollectors: [...UNSUPPORTED_COLLECTORS],
      notes: [
        'COMPLETE describes local collection and encoding, not authentication or server acceptance.',
        'Runtime measurements describe V8, not Java Runtime; OS and reporting segment describe this Linux client.',
        'Unavailable Android measurements are omitted and recorded in diagnostics.',
      ],
    },
  };
}
