import { randomBytes } from 'node:crypto';

export const widgetOrigin = 'https://widgets.resy.com';
// Resy's phone-prefill parser treats a blank space as an empty US number.
// This avoids its null-country startup fallback into email/password. Both
// parameters are consumed by the shipped first-party widget; no number is sent.
export const widgetLoginUrl = `${widgetOrigin}/#/login?authSuccessRedirectUrl=https%3A%2F%2Fresy.com%2F&phone=%20`;

export function loginPage(loginId) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(loginId)) throw new Error('Invalid login identifier');
  const nonce = randomBytes(24).toString('base64');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title></title><style nonce="${nonce}">html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body><iframe id="resy" title="Resy" src="${widgetLoginUrl}" referrerpolicy="no-referrer"></iframe><script nonce="${nonce}">
const frame=document.getElementById('resy');
const secret=new URLSearchParams(location.hash.slice(1)).get('key'),validSecret=Boolean(secret&&/^[A-Za-z0-9_-]{43}$/.test(secret));let busy=false,done=false;
if(!validSecret)frame.remove();
window.addEventListener('message',async event=>{
 if(done||busy||!validSecret||event.origin!==${JSON.stringify(widgetOrigin)}||event.source!==frame.contentWindow||event.data?.event!=='loginSync'||typeof event.data?.token!=='string'||!/^[A-Za-z0-9._~+\\/=-]{16,4096}$/.test(event.data.token))return;
 busy=true;
 try{const response=await fetch('/pair/${loginId}/complete',{method:'POST',headers:{'Content-Type':'application/json','X-REA-Pair-Key':secret},credentials:'omit',body:JSON.stringify({token:event.data.token})});const result=await response.json();if(!response.ok||result.status!=='authenticated')throw new Error();done=true;history.replaceState(null,'',location.pathname);location.replace('https://resy.com/');}
 catch{}finally{busy=false;}
});
</script></body></html>`;
  return { html, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; frame-src ${widgetOrigin}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  } };
}
