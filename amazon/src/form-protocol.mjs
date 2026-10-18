import { parseHTML } from 'linkedom';
import { AmazonError } from './errors.mjs';

// Internal transport helpers, not public tool results: descriptors include opaque
// hidden tokens. This implements static HTML controls, not scripts or checkout
// semantics. Entry order follows the HTML form entry-list algorithm:
// https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#constructing-the-entry-list
const INPUT_TYPES = new Set(['hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button']);
const BUTTON_TYPES = new Set(['submit', 'reset', 'button']);
const SUBMIT_TYPES = new Set(['submit', 'image']);
const NOT_EDITABLE = new Set(['hidden', 'file', 'submit', 'image', 'reset', 'button']);
const READONLY_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number', 'textarea']);
const crlf = value => String(value).replace(/\r\n|\r|\n/g, '\r\n');
const text = element => (element?.textContent ?? '').replace(/[\t\n\f\r ]+/g, ' ').trim();
const fail = (code, message) => { throw new AmazonError(code, message); };

function safeURL(value, base) {
  let url;
  try { url = new URL(value, base); } catch { fail('INVALID_FORM_ACTION', 'The form has an invalid destination.'); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || !(host === 'amazon.com' || host.endsWith('.amazon.com')) || url.username || url.password || (url.port && url.port !== '443')) {
    fail('INVALID_FORM_ACTION', 'Forms may submit only to HTTPS Amazon.com destinations.');
  }
  url.hash = '';
  return url.href;
}

function disabled(element) {
  if (element.hasAttribute('disabled')) return true;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.localName !== 'fieldset' || !ancestor.hasAttribute('disabled')) continue;
    const legend = [...ancestor.children].find(child => child.localName === 'legend');
    if (!legend?.contains(element)) return true;
  }
  return false;
}

function owner(element, document) {
  if (element.hasAttribute('form')) {
    const candidate = document.getElementById(element.getAttribute('form'));
    return candidate?.localName === 'form' ? candidate : null;
  }
  return element.closest('form');
}

function labelFor(element, document) {
  const labels = [...document.querySelectorAll('label')].filter(label =>
    label.hasAttribute('for') ? !!element.id && label.getAttribute('for') === element.id : label.contains(element));
  return labels.map(text).filter(Boolean).join(' ') || element.getAttribute('aria-label') || (element.localName === 'button' ? text(element) : '') || element.getAttribute('title') || '';
}

function sanitizeText(type, value) {
  if (['text', 'search', 'tel', 'password'].includes(type)) return value.replace(/[\r\n]/g, '');
  if (['url', 'email'].includes(type)) return value.replace(/[\r\n]/g, '').replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  return value;
}

function describeControl(element, index, document) {
  const tag = element.localName;
  const rawType = (element.getAttribute('type') ?? '').toLowerCase();
  const type = tag === 'input' ? (INPUT_TYPES.has(rawType) ? rawType : 'text')
    : tag === 'button' ? (BUTTON_TYPES.has(rawType) ? rawType : 'submit') : tag;
  let value = element.getAttribute('value') ?? '';
  if (tag === 'textarea') value = element.textContent.replace(/^\n/, '');
  if ((type === 'checkbox' || type === 'radio') && !element.hasAttribute('value')) value = 'on';
  value = sanitizeText(type, value);
  const readonly = READONLY_TYPES.has(type) && element.hasAttribute('readonly');
  const control = {
    controlId: `control-${index}`, id: element.id || null, name: element.getAttribute('name') ?? '',
    tag, type, value, label: labelFor(element, document), required: element.hasAttribute('required'),
    disabled: disabled(element), readonly,
    editable: !NOT_EDITABLE.has(type) && !disabled(element) && !readonly,
    checked: element.hasAttribute('checked'), multiple: element.hasAttribute('multiple'),
    dirname: element.getAttribute('dirname'), direction: element.closest('[dir]')?.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr',
    constraints: Object.fromEntries(['min', 'max', 'step', 'minlength', 'maxlength', 'pattern'].filter(name => element.hasAttribute(name)).map(name => [name, element.getAttribute(name)])),
  };
  if (tag === 'select') {
    control.options = [...element.querySelectorAll('option')].map(option => ({
      value: option.getAttribute('value') ?? text(option), label: option.getAttribute('label') ?? text(option),
      disabled: option.hasAttribute('disabled') || !!option.closest('optgroup[disabled]'), selected: option.hasAttribute('selected'),
    }));
    if (!control.multiple) {
      const marked = control.options.map((option, i) => option.selected ? i : -1).filter(i => i >= 0);
      const chosen = marked.length ? marked.at(-1) : Number(element.getAttribute('size') ?? 0) <= 1 ? control.options.findIndex(option => !option.disabled) : -1;
      control.options.forEach((option, i) => { option.selected = i === chosen; });
    }
    control.value = control.options.filter(option => option.selected).map(option => option.value);
  }
  if (SUBMIT_TYPES.has(type)) {
    control.formaction = element.getAttribute('formaction');
    control.formmethod = element.getAttribute('formmethod');
    control.formenctype = element.getAttribute('formenctype');
  }
  return control;
}

/** Parse private static form descriptors. Unsafe actions are retained as blocked,
 * so one foreign form does not prevent inspection of other legitimate forms. */
export function parseForms(html, { url } = {}) {
  const pageURL = safeURL(url, undefined);
  if (typeof html !== 'string') fail('INVALID_FORM', 'HTML must be a string.');
  const { document } = parseHTML(html.replace(/\r\n?/g, '\n'));
  const baseElement = document.querySelector('base[href]');
  // A foreign <base> is never used to redirect private form tokens.
  let base = pageURL;
  if (baseElement) {
    try { base = safeURL(baseElement.getAttribute('href'), pageURL); }
    catch { base = null; }
  }
  const elements = [...document.querySelectorAll('input,select,textarea,button')];
  return [...document.querySelectorAll('form')].map((element, index) => {
    const actionAttribute = element.getAttribute('action');
    let action = null, blockedReason = null;
    try {
      // Missing/empty action targets the document URL, independently of <base>.
      action = safeURL(actionAttribute ? actionAttribute : pageURL, base ?? undefined);
    } catch { blockedReason = 'INVALID_FORM_ACTION'; }
    const controls = elements.filter(control => owner(control, document) === element && !control.closest('datalist')).map((control, i) => describeControl(control, i, document));
    // HTML radio groups resolve multiple checked attributes to the last control.
    for (const control of controls) {
      if (control.type !== 'radio' || !control.checked || !control.name) continue;
      for (const previous of controls.slice(0, controls.indexOf(control))) {
        if (previous.type === 'radio' && previous.name === control.name) previous.checked = false;
      }
    }
    const rawMethod = (element.getAttribute('method') ?? 'GET').toUpperCase();
    return {
      id: element.id || null, index, action, url: action, pageURL, baseURL: base, blockedReason,
      method: ['POST', 'DIALOG'].includes(rawMethod) ? rawMethod : 'GET',
      enctype: (element.getAttribute('enctype') ?? 'application/x-www-form-urlencoded').toLowerCase(),
      controls, fields: controls.filter(control => !SUBMIT_TYPES.has(control.type) && !['button', 'reset'].includes(control.type)),
      submitters: controls.filter(control => SUBMIT_TYPES.has(control.type)),
    };
  });
}

function selectSubmitter(form, selector) {
  if (selector === undefined || selector === null) return null;
  let matches;
  if (typeof selector === 'string') matches = form.submitters.filter(control => control.controlId === selector || control.id === selector);
  else if (typeof selector === 'object' && !Array.isArray(selector)) {
    if (selector.controlId) matches = form.submitters.filter(control => control.controlId === selector.controlId);
    else matches = form.submitters.filter(control => control.name === selector.name && control.value === String(selector.value ?? ''));
  } else matches = [];
  if (matches.length !== 1 || matches[0].disabled) fail('INVALID_SUBMITTER', 'Choose one enabled submit button from the form.');
  return matches[0];
}

function stringValue(value) {
  if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) fail('INVALID_FORM_VALUE', 'A form value must be text or a finite number.');
  return String(value);
}

function applyValues(controls, values) {
  for (const [name, value] of Object.entries(values)) {
    const group = controls.filter(control => control.name === name && control.editable);
    if (!name || group.length === 0) fail('INVALID_FORM_FIELD', 'Only recognized editable form fields may be changed.');
    const types = new Set(group.map(control => control.type));
    if (types.size !== 1) fail('AMBIGUOUS_FORM_FIELD', 'This field name refers to different control types.');
    const type = group[0].type;
    if (type === 'radio' || type === 'checkbox') {
      const requested = typeof value === 'boolean' && type === 'checkbox' && group.length === 1
        ? value ? [group[0].value] : [] : (Array.isArray(value) ? value : [value]).map(stringValue);
      if ((type === 'radio' && requested.length !== 1) || requested.some(item => !group.some(control => control.value === item))) fail('INVALID_FORM_CHOICE', 'Choose only an enabled option offered by the form.');
      for (const control of group) control.checked = requested.includes(control.value);
      if (type === 'radio') {
        const chosen = group.filter(control => control.checked).at(-1);
        for (const control of group) control.checked = control === chosen;
      }
    } else if (type === 'select') {
      if (group.length !== 1) fail('AMBIGUOUS_FORM_FIELD', 'Repeated select field names require a more specific form.');
      const control = group[0], requested = (Array.isArray(value) ? value : [value]).map(stringValue);
      if ((!control.multiple && requested.length !== 1) || requested.some(item => !control.options.some(option => !option.disabled && option.value === item))) fail('INVALID_FORM_CHOICE', 'Choose only an enabled option offered by the form.');
      let matched = false;
      for (const option of control.options) {
        option.selected = !option.disabled && requested.includes(option.value) && (control.multiple || !matched);
        if (option.selected) matched = true;
      }
    } else {
      const requested = (Array.isArray(value) ? value : [value]).map(stringValue);
      if (requested.length !== group.length) fail('AMBIGUOUS_FORM_FIELD', 'Repeated editable field names need one value per control.');
      group.forEach((control, i) => { control.value = sanitizeText(control.type, requested[i]); });
    }
  }
}

/** Build an HTTP request without I/O. A selected submitter is explicit; no
 * default button is guessed and no server-controlled hidden field is replaced. */
export function buildFormSubmission(form, { values = {}, submitter } = {}) {
  if (!form || !Array.isArray(form.controls) || !Array.isArray(form.submitters)) fail('INVALID_FORM', 'A parsed form is required.');
  if (form.blockedReason || !form.action) fail('INVALID_FORM_ACTION', 'The form destination is not allowed.');
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail('INVALID_FORM_VALUE', 'Form values must be keyed by editable field name.');
  const button = selectSubmitter(form, submitter);
  const destination = button?.formaction !== null && button?.formaction !== undefined ? (button.formaction || form.pageURL) : form.action;
  const url = new URL(safeURL(destination, form.baseURL ?? undefined));
  const methodAttribute = (button?.formmethod ?? form.method).toUpperCase();
  const method = ['POST', 'DIALOG'].includes(methodAttribute) ? methodAttribute : 'GET';
  if (method === 'DIALOG') fail('UNSUPPORTED_FORM', 'Dialog forms are not HTTP submissions.');
  const enctype = (button?.formenctype ?? form.enctype).toLowerCase();
  if (method === 'POST' && enctype !== 'application/x-www-form-urlencoded') fail('UNSUPPORTED_FORM_ENCODING', 'Only URL-encoded form submissions are supported.');
  const controls = structuredClone(form.controls);
  applyValues(controls, values);
  const entries = new URLSearchParams();
  const append = (name, value) => entries.append(crlf(name), crlf(value));
  for (const control of controls) {
    if (control.disabled || ['reset', 'button'].includes(control.type)) continue;
    if (SUBMIT_TYPES.has(control.type)) {
      if (control.controlId !== button?.controlId) continue;
      if (control.type === 'image') {
        append(control.name ? `${control.name}.x` : 'x', '0');
        append(control.name ? `${control.name}.y` : 'y', '0');
      } else if (control.name) append(control.name, control.value);
      continue;
    }
    if (!control.name) continue;
    if (control.type === 'file') fail('UNSUPPORTED_FORM_CONTROL', 'File uploads are not supported.');
    if (['radio', 'checkbox'].includes(control.type) && !control.checked) continue;
    if (control.type === 'select') {
      for (const option of control.options) if (option.selected && !option.disabled) append(control.name, option.value);
    } else append(control.name, control.type === 'hidden' && control.name.toLowerCase() === '_charset_' ? 'UTF-8' : control.value);
    if (control.dirname && ['text', 'search', 'tel', 'url', 'email', 'textarea'].includes(control.type)) append(control.dirname, control.direction);
  }
  if (method === 'GET') {
    url.search = entries.toString();
    return { url: url.href, method, form: undefined };
  }
  return { url: url.href, method, form: entries };
}
