import { ChatGptError } from './errors.mjs';

// Native tw2.invokeSuspend case 6; this is a request specification, not I/O.
export function chatRequirementsRequest() {
  return { method: 'POST', path: 'sentinel/chat-requirements', body: {} };
}

function headerValue(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new ChatGptError('INVALID_SENTINEL_RESPONSE', `${name} must be a nonempty single-line string.`);
  }
  return value;
}

function requiredChallenges(value, prefix = '', depth = 0) {
  if (depth > 16) throw new ChatGptError('INVALID_SENTINEL_RESPONSE', 'The verification response is too deeply nested.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const challenges = [];
  for (const [name, child] of Object.entries(value)) {
    if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    if (child.required === true) challenges.push(path);
    challenges.push(...requiredChallenges(child, path, depth + 1));
  }
  return [...new Set(challenges)];
}

// A token is not proof that any requested verification has been satisfied.
export function parseChatRequirements(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new ChatGptError('INVALID_SENTINEL_RESPONSE', 'ChatGPT returned invalid verification requirements.');
  }
  return {
    token: headerValue(response.token, 'Chat requirements token'),
    requiredChallenges: requiredChallenges(response),
  };
}

// Never invent an integrity payload. An opaque value supplied here must come
// from a genuine verification provider and may still be rejected by the server.
export function sentinelHeaders(requirements, { integrityPayload } = {}) {
  const token = headerValue(requirements?.token, 'Chat requirements token');
  const challenges = requirements?.requiredChallenges;
  if (!Array.isArray(challenges)) {
    throw new ChatGptError('INVALID_SENTINEL_RESPONSE', 'Parse the verification requirements before preparing headers.');
  }
  if (challenges.length) {
    throw new ChatGptError('VERIFICATION_REQUIRED', 'ChatGPT requires additional verification before this request can continue.', {
      challenges: challenges.map(name => String(name).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 120)),
    });
  }
  const headers = { 'OpenAI-Sentinel-Chat-Requirements-Token': token };
  if (integrityPayload !== undefined) headers['X-Sentinel-Payload'] = headerValue(integrityPayload, 'Integrity payload');
  return headers;
}
