const hidden = new Set(['token','accesstoken','refreshtoken','authtoken','authorization','cookie','cookies','password','secret','clientsecret','fortertoken','cardtoken','cardnumber','cvc','cvv','fingerprint','stripepaymentmethod','stripecustomerid','sharedpaymentgrantedtoken']);
const normalize = key => key.toLowerCase().replace(/[^a-z0-9]/g,'');

// Payment method IDs remain selectable; credentials and full billing records do
// not belong in a model's checkout response. Exact delivery locations do.
export function commerceData(value, { raw = false } = {}) {
  if (Array.isArray(value)) return value.map(item=>commerceData(item,{raw}));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key,item])=> {
    if (hidden.has(normalize(key)) || ['billingdetails','billingaddress'].includes(normalize(key)) || (!raw && key==='user')) return [];
    return [[key,commerceData(item,{raw})]];
  }));
}
