import { parseHTML } from 'linkedom';
import { createHash } from 'node:crypto';
import { AmazonError } from './errors.mjs';
import { retailURL } from './shopping-protocol.mjs';
import { parseForms, buildFormSubmission } from './form-protocol.mjs';

const fail = (code, message) => { throw new AmazonError(code, message); };
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
function rawText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent;
  if (['SCRIPT', 'STYLE', 'TEMPLATE'].includes(node.tagName)) return '';
  return [...node.childNodes].map(rawText).join('');
}
const text = (root, selector) => clean(rawText(selector ? root.querySelector(selector) : root));
function documentFor(html) {
  const { document } = parseHTML(html);
  if (document.querySelector('form[action*="validateCaptcha"], #captchacharacters') || /automated access|robot check/i.test(text(document).slice(0,12000))) fail('AMAZON_CHALLENGE', 'Amazon returned an automated-access or verification page.');
  if (document.querySelector('form[name="signIn"], #ap_signin_form, #ap_password')) fail('AUTH_REQUIRED', 'Amazon requires fresh authentication.');
  return document;
}
export function money(display) {
  const normalized = clean(display), match = normalized.match(/^\$([\d,]+\.\d{2})$/);
  return match ? { display: normalized, amount: Number(match[1].replaceAll(',', '')), currency: 'USD' } : null;
}
function price(root) {
  const amount = money(text(root, '.apex-price-to-pay-value .a-offscreen')) || money(text(root, '.sc-product-price'));
  if (amount) return amount;
  const whole = text(root, '.a-price-whole').replace(/[^\d]/g,''), fraction = text(root, '.a-price-fraction');
  return whole && /^\d{2}$/.test(fraction) && text(root,'.a-price-symbol') === '$' ? money(`$${whole}.${fraction}`) : null;
}
const positiveInteger = value => /^[1-9]\d*$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : null;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceSubmission(form,submitter){
  const submission=buildFormSubmission(form,{submitter});
  if(submission.url!==form.url||submission.method!==form.method)fail('INVALID_SUBMISSION','A submit button overrides the recognized action.');
  return submission;
}

export function parseCartPage(html, { url } = {}) {
  const document = documentFor(html), forms = parseForms(html, { url });
  const active = document.querySelector('#sc-active-cart');
  if (!active) fail('UNRECOGNIZED_CART', 'Amazon returned no recognized shopping cart.');
  const items = [...active.querySelectorAll('.sc-list-item[data-itemtype="active"]')].map(element => {
    const asin = element.getAttribute('data-asin'), itemId = element.getAttribute('data-itemid');
    const quantity = positiveInteger(element.getAttribute('data-quantity'));
    if (!/^[A-Z0-9]{10}$/.test(asin ?? '') || !itemId || !quantity) fail('UNRECOGNIZED_CART', 'A cart item has no complete source identity or quantity.');
    return { itemRef: fingerprint(itemId).slice(0,24), asin, title: element.getAttribute('data-producttitle') || text(element,'.sc-product-title'), quantity,
      selected: element.getAttribute('data-isSelected') === '1', unitPrice: price(element),
      availability: text(element,'.sc-product-availability') || null, seller: text(element,'.sc-seller') || null,
      delivery: text(element,'.sc-delivery-messaging') || null };
  });
  const empty = !items.length && /your amazon cart is empty|your shopping cart is empty/i.test(text(active));
  if (!items.length && !empty) fail('UNRECOGNIZED_CART', 'Amazon did not confirm an empty cart.');
  const summary = { items, empty, subtotal: money(text(document,'#sc-subtotal-amount-buybox')) };
  const form = forms.find(form => form.id === 'gutterCartViewForm' && form.method === 'GET' && new URL(form.url).pathname === '/checkout/entry/cart');
  const submitter = form?.submitters.find(control => control.name === 'proceedToRetailCheckout' && !control.disabled);
  const checkout = form && submitter ? buildFormSubmission(form, { submitter: submitter.controlId }) : null;
  if(checkout && (checkout.method!=='GET'||new URL(checkout.url).pathname!=='/checkout/entry/cart'))fail('INVALID_SUBMISSION','The checkout button overrides its recognized action.');
  return { summary, fingerprint: fingerprint(summary), checkout, forms };
}

export function primeDeclineURL(html, { url } = {}) {
  const document = documentFor(html), link = document.querySelector('a#prime-decline-button[href]');
  if (!link) return null;
  const result = retailURL(link.getAttribute('href'), url), parsed = new URL(result);
  if (!/^\/checkout\/p\/[^/]+\/prime\/handler$/.test(parsed.pathname) || parsed.searchParams.get('action') !== 'decline' || !/^no thanks$/i.test(text(link))) fail('UNRECOGNIZED_CHECKOUT', 'Amazon returned an unrecognized membership prompt.');
  return result;
}

export function parseCheckoutPage(html, { url } = {}) {
  const document = documentFor(html), totals = [...document.querySelectorAll('#subtotals-marketplace-table li')].map(row => text(row));
  const orderTotal = totals.find(row => /^Order total:\s*/i.test(row));
  const total = orderTotal ? money(orderTotal.replace(/^Order total:\s*/i,'')) : null;
  const forms = parseForms(html,{url}), candidates = forms.filter(form => form.id === 'spc-form' && form.method === 'POST' && /^\/checkout\/p\/[^/]+\/spc\/place-order$/.test(new URL(form.url).pathname));
  const form = candidates.find(form => form.submitters.some(s => s.name === 'placeYourOrder1' && !s.disabled));
  const submitter = form?.submitters.find(s => s.name === 'placeYourOrder1' && !s.disabled);
  if (!total || !form || !submitter || !form.controls.some(c => c.name === 'anti-csrftoken-a2z' && c.value)) fail('CHECKOUT_NOT_READY', 'Amazon did not return an enabled order review with a precise total.');
  const items = [...document.querySelectorAll('#checkout-item-block-panel .lineitem-container')].map(item => {
    const block=item.closest('[id="col-item-block-description"]')||item;
    const asins=[...new Set([...block.querySelectorAll('span.aok-hidden')].map(e=>text(e)).filter(v=>/^[A-Z0-9]{10}$/.test(v)))];
    return { asin:asins.length===1?asins[0]:null,
    title: text(item,'.lineitem-title-text'), quantity: positiveInteger(text(item,'[data-a-selector="inner-value"]') || text(item,'[data-a-selector="value"]')),
    unitPrice: price(item), seller: text(item,'.product-description-column a[href^="/sp"]') || null,
  };});
  const address = text(document,'#deliver-to-address-text'), payment = text(document,'#payment-option-text-default');
  if (!items.length || items.some(item => !item.asin || !item.title || !item.quantity || !item.unitPrice) || !address || !payment) fail('CHECKOUT_NOT_READY', 'The review is missing item, address or payment details.');
  const deliveryOptions = [...document.querySelectorAll('#checkout-item-block-panel input[type="radio"]')].filter(e => e.hasAttribute('checked')).map(e => {
    const label = document.getElementById(e.getAttribute('aria-labelledby'));
    return text(label || e.closest('label')) || null;
  });
  if (deliveryOptions.some(value => !value)) fail('CHECKOUT_NOT_READY', 'The selected delivery option could not be read.');
  const review = { items, total, totals, deliveryAddress: address, payment, deliveryOptions };
  return { review, fingerprint: fingerprint(review), submission: sourceSubmission(form,submitter.controlId) };
}

export function addToCartSubmission(html, { url, asin } = {}) {
  documentFor(html);
  const form = parseForms(html,{url}).find(form => form.id === 'addToCart' && form.method === 'POST' && /^\/cart\/add-to-cart(?:\/|$)/.test(new URL(form.url).pathname));
  if (!form || form.controls.find(c=>c.name==='items[0.base][asin]')?.value !== asin || form.controls.some(c=>/^items\[[1-9]/.test(c.name))) fail('ADD_NOT_AVAILABLE', 'No matching single-product Add to Cart form was returned.');
  const submitter = form.submitters.find(c=>c.name==='submit.add-to-cart' && !c.disabled);
  const quantity = positiveInteger(form.controls.find(c=>c.name==='items[0.base][quantity]')?.value);
  const subscription=form.controls.some(c=>/^sns/i.test(c.name)&&!['','0','false'].includes(String(c.value)));
  // The observed single-item form also carries fallback mbboid/mbbq fields;
  // an additional bundle ASIN, rather than that fallback quantity, selects it.
  const bundle=form.controls.some(c=>c.name==='mbba'&&String(c.value)!=='');
  const alternateQuantity=form.controls.find(c=>c.name==='quantity')?.value;
  if (!submitter || quantity !== 1 || subscription || bundle || alternateQuantity && alternateQuantity!=='1') fail('ADD_NOT_AVAILABLE', 'The source Add to Cart form is not an enabled single-item action.');
  return sourceSubmission(form,submitter.controlId);
}

export function removeFromCartSubmission(cart, itemRef) {
  const form = cart.forms.find(form=>form.id==='activeCartViewForm' && form.method==='POST' && /^\/cart(?:\/|$)/.test(new URL(form.url).pathname));
  const submitter = form?.submitters.find(c=>c.name.startsWith('submit.delete-active.') && fingerprint(c.name.slice('submit.delete-active.'.length)).slice(0,24)===itemRef && !c.disabled);
  if (!submitter || !cart.summary.items.some(i=>i.itemRef===itemRef)) fail('REMOVE_NOT_AVAILABLE','No matching cart delete action was returned.');
  return sourceSubmission(form,submitter.controlId);
}

export function parsePurchaseResult(html) {
  const document = documentFor(html);
  const content = text(document.body);
  if (!/thank you.{0,25}(?:order|shopping)|order (?:placed|confirmed)|successfully placed/i.test(content)) return { status:'outcome_unknown' };
  const orderIds = [...new Set(content.match(/\b\d{3}-\d{7}-\d{7}\b/g) || [])];
  return orderIds.length ? { status:'confirmed', orderIds } : { status:'outcome_unknown' };
}

// Cancellation actions are discovered from a particular order, never built
// from a guessed URL. Unsupported JavaScript-only flows stay unavailable.
export function cancellationForm(html, { url, orderId } = {}) {
  documentFor(html);
  const forms=parseForms(html,{url});
  for(const form of forms){
    if(form.method!=='POST'||form.blockedReason)continue;
    const action=new URL(form.url);
    if(!/^\/(?:your-orders\/|gp\/your-account\/|gp\/aw\/ya(?:\/|$))/.test(action.pathname))continue;
    const ids=[...['orderID','orderId','oid'].flatMap(key=>action.searchParams.getAll(key)),...form.controls.filter(c=>['orderID','orderId','oid'].includes(c.name)).map(c=>c.value)];
    if(!ids.length||ids.some(id=>id!==orderId))continue;
    const submitter=form.submitters.find(c=>!c.disabled&&/^cancel (?:checked items|selected items|items|order|this order)$/i.test(clean(c.label||c.value)));
    if(!submitter)continue;
    const choices=form.controls.filter(c=>c.editable&&!c.disabled).map(c=>({name:c.name,type:c.type,label:c.label,required:c.required,...(c.options?{options:c.options.map(o=>({value:o.value,label:o.label,disabled:o.disabled}))}:{}),...(['checkbox','radio'].includes(c.type)?{value:c.value,checked:c.checked}:{})}));
    return {form,submitter:submitter.controlId,choices};
  }
  fail('CANCELLATION_NOT_AVAILABLE','Amazon returned no supported cancellation form identifying this order.');
}
export function parseCancellationResult(html,{orderId}={}){
  const document=documentFor(html),content=text(document.body);
  if(!content.includes(orderId))return {status:'outcome_unknown'};
  if(/cancellation (?:has been )?requested|cancel(?:lation)? request (?:was )?submitted/i.test(content))return {status:'cancellation_requested',orderId};
  if(/successfully cancell?ed|(?:order|items?) (?:has|have) been cancell?ed/i.test(content))return {status:'confirmed',orderId};
  return {status:'outcome_unknown'};
}
