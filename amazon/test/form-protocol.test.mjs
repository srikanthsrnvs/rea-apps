import assert from 'node:assert/strict';
import test from 'node:test';
import { parseForms, buildFormSubmission } from '../src/form-protocol.mjs';

const url = 'https://www.amazon.com/checkout/review?old=1#section';
const parse = html => parseForms(html, { url });
const entries = request => request.form ? [...request.form] : [...new URL(request.url).searchParams];

test('preserves ordered opaque hidden fields and chooses exactly one submitter', () => {
  const [form] = parse(`<form method=post action="/checkout/submit?flow=server">
    <input type=hidden name=csrf value="a&amp;b=+/%25">
    <input type=hidden name=state value=one><input type=hidden name=state value=two>
    <label for=quantity>Quantity</label><input id=quantity name=quantity value=1 required min=1 max=4>
    <button name=action value=review>Review</button><button id=place name=action value=place>Place order</button>
  </form>`);
  assert.equal(form.fields.find(field => field.name === 'quantity').label, 'Quantity');
  assert.equal(form.fields.find(field => field.name === 'quantity').required, true);
  assert.deepEqual(form.fields.find(field => field.name === 'quantity').constraints, { min: '1', max: '4' });
  const request = buildFormSubmission(form, { values: { quantity: 2 }, submitter: 'place' });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://www.amazon.com/checkout/submit?flow=server');
  assert.deepEqual(entries(request), [['csrf', 'a&b=+/%25'], ['state', 'one'], ['state', 'two'], ['quantity', '2'], ['action', 'place']]);
  assert.equal(form.fields.find(field => field.name === 'quantity').value, '1');
  for (const values of [{ csrf: 'changed' }, { state: ['three'] }, { invented: '1' }]) {
    assert.throws(() => buildFormSubmission(form, { values }), { code: 'INVALID_FORM_FIELD' });
  }
});

test('GET replaces existing query, preserves duplicates and excludes unselected buttons', () => {
  const [form] = parse('<form action="/s?stale=1"><input name=k value="tea &amp; coffee"><input name=tag value=a><input name=tag value=b><button name=go value=1>Go</button></form>');
  const request = buildFormSubmission(form);
  assert.equal(request.form, undefined);
  assert.equal(request.url, 'https://www.amazon.com/s?k=tea+%26+coffee&tag=a&tag=b');
});

test('checkbox and radio choices are bounded to enabled server options', () => {
  const [form] = parse(`<form method=post>
    <input type=hidden name=gift value=0><input type=checkbox name=gift value=1>
    <input type=radio name=shipping value=slow checked><input type=radio name=shipping value=fast>
    <input type=radio name=shipping value=forbidden disabled>
    <input type=checkbox name=extra value=a checked><input type=checkbox name=extra value=b>
    <input type=checkbox name=flag checked>
  </form>`);
  assert.deepEqual(entries(buildFormSubmission(form, { values: { gift: true, shipping: 'fast', extra: ['b'], flag: false } })), [['gift', '0'], ['gift', '1'], ['shipping', 'fast'], ['extra', 'b']]);
  assert.throws(() => buildFormSubmission(form, { values: { shipping: 'forbidden' } }), { code: 'INVALID_FORM_CHOICE' });
  assert.throws(() => buildFormSubmission(form, { values: { extra: ['invented'] } }), { code: 'INVALID_FORM_CHOICE' });
});

test('select defaults, option groups, multiselect and repeated checked radios match static HTML', () => {
  const [form] = parse(`<form method=post>
    <select name=first><optgroup disabled><option>Disabled</option></optgroup><option>First enabled</option><option value=last>Last</option></select>
    <select name=chosen><option value=a selected>A</option><option value=b selected>B</option></select>
    <select name=items multiple><option value=a selected>A</option><option value=b>B</option><option value=c selected disabled>C</option></select>
    <input type=radio name=r value=earlier checked><input type=radio name=r value=later checked>
  </form>`);
  assert.deepEqual(entries(buildFormSubmission(form)), [['first', 'First enabled'], ['chosen', 'b'], ['items', 'a'], ['r', 'later']]);
  assert.deepEqual(entries(buildFormSubmission(form, { values: { items: ['b', 'a'], first: 'last' } })), [['first', 'last'], ['chosen', 'b'], ['items', 'a'], ['items', 'b'], ['r', 'later']]);
  assert.throws(() => buildFormSubmission(form, { values: { items: ['c'] } }), { code: 'INVALID_FORM_CHOICE' });
  assert.throws(() => buildFormSubmission(form, { values: { first: ['last', 'First enabled'] } }), { code: 'INVALID_FORM_CHOICE' });
});

test('disabled fieldset exempts only its first legend and respects nested outer fieldsets', () => {
  const [form] = parse(`<form method=post><fieldset disabled>
    <legend><input name=allowed value=yes></legend>
    <legend><input name=second value=no></legend><input name=blocked value=no>
    <fieldset><legend><input name=nested value=no></legend></fieldset>
  </fieldset><input name=readonly value=server readonly><input name=disabled disabled value=no>
  <button id=off disabled name=go value=off>Off</button></form>`);
  assert.deepEqual(entries(buildFormSubmission(form, { values: { allowed: 'updated' } })), [['allowed', 'updated'], ['readonly', 'server']]);
  for (const name of ['second', 'blocked', 'nested', 'readonly', 'disabled']) assert.throws(() => buildFormSubmission(form, { values: { [name]: 'changed' } }), { code: 'INVALID_FORM_FIELD' });
  assert.throws(() => buildFormSubmission(form, { submitter: 'off' }), { code: 'INVALID_SUBMITTER' });
});

test('external form association follows document order and invalid form owner does not fallback', () => {
  const forms = parse(`<input form=target name=before value=1><form id=target method=post>
    <input name=inside value=2><input form=missing name=orphan value=no>
    <input form=other name=reassigned value=other></form>
    <form id=other></form><input form=target name=after value=3>`);
  assert.deepEqual(entries(buildFormSubmission(forms[0])), [['before', '1'], ['inside', '2'], ['after', '3']]);
  assert.deepEqual(entries(buildFormSubmission(forms[1])), [['reassigned', 'other']]);
});

test('unsafe actions, credentials, ports and selected submitter redirects cannot carry hidden tokens', () => {
  const [safe, foreign, http, userinfo, port, suffix] = parse(`<form method=post action=/safe><input type=hidden name=token value=secret><button id=bad formaction="https://evil.example/steal">Bad</button></form>
    <form action="//evil.example/steal"></form><form action="http://www.amazon.com/steal"></form>
    <form action="https://user:pass@www.amazon.com/steal"></form><form action="https://www.amazon.com:8443/steal"></form>
    <form action="https://www.amazon.com.evil.example/steal"></form>`);
  assert.equal(safe.action, 'https://www.amazon.com/safe');
  for (const form of [foreign, http, userinfo, port, suffix]) {
    assert.equal(form.action, null);
    assert.throws(() => buildFormSubmission(form), { code: 'INVALID_FORM_ACTION' });
  }
  assert.throws(() => buildFormSubmission(safe, { submitter: 'bad' }), { code: 'INVALID_FORM_ACTION' });
  assert.throws(() => parseForms('<form></form>', { url: 'https://evil.example/' }), { code: 'INVALID_FORM_ACTION' });
});

test('base URLs and submitter method/action overrides are resolved only within Amazon', () => {
  const [form] = parse('<base href="https://www.amazon.com/path/"><form action=review><input name=x value=y><button id=next formaction=send formmethod=post name=step value=next>Next</button></form>');
  assert.equal(form.action, 'https://www.amazon.com/path/review');
  const request = buildFormSubmission(form, { submitter: 'next' });
  assert.equal(request.url, 'https://www.amazon.com/path/send');
  assert.equal(request.method, 'POST');
  const [blocked] = parse('<base href="https://evil.example/"><form action=relative></form>');
  assert.throws(() => buildFormSubmission(blocked), { code: 'INVALID_FORM_ACTION' });
  const [documentAction] = parse('<base href="https://evil.example/"><form></form>');
  assert.equal(documentAction.action, 'https://www.amazon.com/checkout/review?old=1');
});

test('textareas normalize initial newline and CRLF, charset and dirname follow entry rules', () => {
  const [form] = parse('<form method=post><input type=hidden name=_charset_ value=ignored><textarea name=note dirname=note.dir dir=rtl>\nfirst\nsecond</textarea><datalist><option>suggestion</option></datalist><input value=unnamed></form>');
  assert.deepEqual(entries(buildFormSubmission(form)), [['_charset_', 'UTF-8'], ['note', 'first\r\nsecond'], ['note.dir', 'rtl']]);
});

test('repeated editable controls require exact values while hidden duplicates remain opaque', () => {
  const [form] = parse('<form method=post><input type=hidden name=x value=token><input name=x value=a><input name=x value=b></form>');
  assert.throws(() => buildFormSubmission(form, { values: { x: 'single' } }), { code: 'AMBIGUOUS_FORM_FIELD' });
  assert.deepEqual(entries(buildFormSubmission(form, { values: { x: ['left', 'right'] } })), [['x', 'token'], ['x', 'left'], ['x', 'right']]);
});

test('unsupported files, encodings and dialog forms fail instead of pretending to submit', () => {
  for (const [html, code] of [
    ['<form method=post><input type=file name=file></form>', 'UNSUPPORTED_FORM_CONTROL'],
    ['<form method=post enctype=multipart/form-data></form>', 'UNSUPPORTED_FORM_ENCODING'],
    ['<form method=dialog></form>', 'UNSUPPORTED_FORM'],
  ]) assert.throws(() => buildFormSubmission(parse(html)[0]), { code });
});

test('image submission uses only chosen control coordinates and nameless controls remain excluded', () => {
  const [form] = parse('<form method=post><input id=picture type=image name=go value=ignored><input type=submit name=other value=no></form>');
  assert.deepEqual(entries(buildFormSubmission(form, { submitter: 'picture' })), [['go.x', '0'], ['go.y', '0']]);
  assert.throws(() => buildFormSubmission(form, { submitter: { name: 'missing', value: '1' } }), { code: 'INVALID_SUBMITTER' });
});
