import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCartPage,parseCheckoutPage,primeDeclineURL,addToCartSubmission,removeFromCartSubmission,cancellationForm,parseCancellationResult,parsePurchaseResult} from '../src/commerce-protocol.mjs';
import {cart,checkout,cancellation,url} from './commerce-fixtures.mjs';
test('cart separates active items from script templates and preserves private checkout fields only internally',()=>{
 const r=parseCartPage(cart()+`<script>Cancelled</script>`,{url});
 assert.equal(r.summary.items[0].quantity,1);assert.equal(r.summary.items[0].selected,true);assert.equal(r.summary.subtotal.amount,10);
 assert.equal(JSON.stringify(r.summary).includes('private-'),false);assert.match(r.checkout.url,/sessionID=private-session/);
 assert.equal(removeFromCartSubmission(r,r.summary.items[0].itemRef).form.get('submit.delete-active.invented-item'),'Delete');
 assert.throws(()=>removeFromCartSubmission(r,'another-item'),{code:'REMOVE_NOT_AVAILABLE'});
});
test('unknown, sign-in and challenge carts never become an empty cart',()=>{
 assert.throws(()=>parseCartPage('<div id="sc-active-cart"></div>',{url}),{code:'UNRECOGNIZED_CART'});
 assert.throws(()=>parseCartPage('<input id="ap_password">',{url}),{code:'AUTH_REQUIRED'});
 assert.throws(()=>parseCartPage('Automated access',{url}),{code:'AMAZON_CHALLENGE'});
 assert.equal(parseCartPage('<div id="sc-active-cart">Your Amazon Cart is empty</div>',{url}).summary.empty,true);
});
test('review uses exact total, item quantity, address, payment and selected shipping',()=>{
 const r=parseCheckoutPage(checkout(),{url});
 assert.equal(r.review.total.amount,10);assert.equal(r.review.items[0].quantity,1);assert.deepEqual(r.review.deliveryOptions,['Tomorrow FREE Delivery']);
 assert.equal(r.submission.form.get('anti-csrftoken-a2z'),'private-csrf');assert.equal(r.submission.form.get('placeYourOrder1'),'Place your order');
 assert.equal(JSON.stringify(r.review).includes('private-csrf'),false);
 assert.throws(()=>parseCheckoutPage(checkout({disabled:true}),{url}),{code:'CHECKOUT_NOT_READY'});
 assert.throws(()=>parseCheckoutPage(checkout().replace('id="deliver-to-address-text"','id="unknown"'),{url}),{code:'CHECKOUT_NOT_READY'});
});
test('only the exact source No thanks link can decline an optional Prime prompt',()=>{
 assert.match(primeDeclineURL('<a id="prime-decline-button" href="/checkout/p/example/prime/handler?action=decline">No thanks</a>',{url}),/action=decline/);
 assert.throws(()=>primeDeclineURL('<a id="prime-decline-button" href="/checkout/p/example/prime/handler?action=signup">No thanks</a>',{url}),{code:'UNRECOGNIZED_CHECKOUT'});
});
test('cancellation adapter requires an exact order identity and an enabled cancellation button',()=>{
 const r=cancellationForm(cancellation,{url,orderId:'111-1111111-1111111'});
 assert.equal(r.choices.length,2);assert.equal(JSON.stringify(r.choices).includes('private-csrf'),false);
 assert.throws(()=>cancellationForm(cancellation,{url,orderId:'222-2222222-2222222'}),{code:'CANCELLATION_NOT_AVAILABLE'});
 assert.throws(()=>cancellationForm(cancellation.replace('Cancel checked items','Return items'),{url,orderId:'111-1111111-1111111'}),{code:'CANCELLATION_NOT_AVAILABLE'});
});
test('Add to Cart excludes bundles, subscriptions and business-action overrides',()=>{
 const form='<html><body><form id="addToCart" action="/cart/add-to-cart/example" method="POST"><input type="hidden" name="items[0.base][asin]" value="B012345678"><input type="hidden" name="items[0.base][quantity]" value="1"><input type="submit" name="submit.add-to-cart"></form></body></html>';
 assert.equal(addToCartSubmission(form,{url,asin:'B012345678'}).method,'POST');
 assert.equal(addToCartSubmission(form.replace('</form>','<input type="hidden" name="mbba" value=""><input type="hidden" name="mbbq" value="1"></form>'),{url,asin:'B012345678'}).method,'POST');
 assert.throws(()=>addToCartSubmission(form.replace('</form>','<input type="hidden" name="snsOptIn" value="1"></form>'),{url,asin:'B012345678'}),{code:'ADD_NOT_AVAILABLE'});
 assert.throws(()=>addToCartSubmission(form.replace('</form>','<input type="hidden" name="mbba" value="B087654321"></form>'),{url,asin:'B012345678'}),{code:'ADD_NOT_AVAILABLE'});
 assert.throws(()=>addToCartSubmission(form,{url,asin:'B087654321'}),{code:'ADD_NOT_AVAILABLE'});
 assert.throws(()=>addToCartSubmission(form.replace('</form>','<input type="hidden" name="items[1.base][asin]" value="B087654321"></form>'),{url,asin:'B012345678'}),{code:'ADD_NOT_AVAILABLE'});
 assert.throws(()=>addToCartSubmission(form.replace('name="submit.add-to-cart"','name="submit.subscribe"'),{url,asin:'B012345678'}),{code:'ADD_NOT_AVAILABLE'});
 assert.throws(()=>addToCartSubmission(form.replace('name="submit.add-to-cart"','formaction="/checkout/place-order" name="submit.add-to-cart"'),{url,asin:'B012345678'}),{code:'INVALID_SUBMISSION'});
});
test('submission responses require explicit confirmation and order identity',()=>{
 assert.equal(parsePurchaseResult('<html><body>Place your order</body></html>').status,'outcome_unknown');
 assert.equal(parsePurchaseResult('<html><body>Thank you for your order. 111-1111111-1111111</body></html>').status,'confirmed');
 assert.equal(parseCancellationResult('<html><body>Order has been cancelled 111-1111111-1111111</body></html>',{orderId:'111-1111111-1111111'}).status,'confirmed');
 assert.equal(parseCancellationResult('<html><body>Return initiated 111-1111111-1111111</body></html>',{orderId:'111-1111111-1111111'}).status,'outcome_unknown');
});
