import { ChartsError } from './errors.mjs';

const invalid = message => { throw new ChartsError('INVALID_ARGUMENT', message); };
function jsonValue(value, depth = 0) {
  if (depth > 8) invalid('JSON arguments must not be nested more than eight levels.');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { if (value.length > 100) invalid('Nested arrays are limited to 100 entries.'); value.forEach(v => jsonValue(v, depth + 1)); return; }
  if (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    if (Object.keys(value).length > 100) invalid('Nested objects are limited to 100 properties.');
    for (const [key, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid('Unsafe JSON property name.');
      jsonValue(v, depth + 1);
    }
    return;
  }
  invalid('Arguments must contain JSON values only.');
}
function validate(value, schema, name) {
  if (schema.enum && !schema.enum.includes(value)) invalid(`${name} has an unsupported value.`);
  if (!schema.type) return value;
  if (schema.type === 'object') {
    if (!value || Array.isArray(value) || typeof value !== 'object') invalid(`${name} must be an object.`);
    if (schema.maxProperties && Object.keys(value).length > schema.maxProperties) invalid(`${name} has too many properties.`);
    const properties = schema.properties ?? {}, result = {};
    for (const key of schema.required ?? []) if (value[key] === undefined) invalid(`Provide ${key}.`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) invalid('This tool received an unsupported option. Check its schema.');
        result[key] = value[key];
      } else result[key] = validate(value[key], properties[key], key);
    }
    for (const [key, field] of Object.entries(properties)) if (!Object.hasOwn(result, key) && Object.hasOwn(field, 'default')) result[key] = structuredClone(field.default);
    return result;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) invalid(`${name} has an invalid number of entries.`);
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) invalid(`${name} must contain unique entries.`);
    return value.map(v => validate(v, schema.items, name));
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))
      || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) invalid(`${name} must be a number within its documented bounds.`);
    return value;
  }
  if (typeof value !== schema.type) invalid(`${name} must be a ${schema.type}.`);
  if (schema.type === 'string' && (value.trim().length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)
    || /[\x00-\x1f\x7f]/u.test(value) || (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)))) invalid(`${name} has an invalid format.`);
  return value;
}

export function validateArguments(definition, input) {
  jsonValue(input);
  if (Buffer.byteLength(JSON.stringify(input)) > 32768) invalid('Tool arguments must fit within 32 KiB.');
  return validate(input, definition.inputSchema, 'arguments');
}

export function marketSymbol(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_./-]+:[A-Za-z0-9_!./%+@=-]+$/u.test(value)) invalid('Use an exchange-qualified symbol from symbols search, such as COINBASE:BTCUSD.');
  return value;
}

export function timeframe(value = 'D') {
  const aliases = { '1d': 'D', '1w': 'W', '1mo': 'M' };
  if (aliases[value]) return aliases[value];
  const minute = /^(\d+)m$/u.exec(value), hour = /^(\d+)h$/u.exec(value);
  const result = minute ? minute[1] : hour ? String(Number(hour[1]) * 60) : value;
  if (!/^(?:[1-9]\d{0,4}(?:S|D|W|M)?|D|W|M)$/u.test(result)) invalid('Unsupported timeframe format. Use minutes, 1h, D, W or uppercase M for months.');
  return result;
}

export function timestamp(value) {
  if (value === undefined) return undefined;
  const number = /^\d+$/u.test(value) ? Number(value) : /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(value) ? Date.parse(value) / 1000 : NaN;
  if (!Number.isSafeInteger(number) || number < 0 || number > 100000000000) invalid('Use a valid ISO timestamp with timezone or Unix seconds, not milliseconds.');
  return number;
}

export function chartQuery(o) {
  const from = timestamp(o.from), to = timestamp(o.to);
  if (from !== undefined && to !== undefined && from > to) invalid('from must be before or equal to to.');
  if (o['chart-inputs'] && !o['chart-type']) invalid('chart-inputs requires chart-type.');
  return { symbol: marketSymbol(o.symbol), timeframe: timeframe(o.timeframe), count: o.count,
    ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), maxCount: o.count,
    session: o.session, adjustment: o.adjustment, timezone: o.timezone, currency: o.currency,
    chartType: o['chart-type'], chartInputs: o['chart-inputs'], backAdjustment: o['back-adjustment'] };
}
