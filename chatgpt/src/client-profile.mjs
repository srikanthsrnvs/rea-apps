import { AUTH_CONFIG } from './auth-protocol.mjs';

// Public native protocol identity; no physical Android device is required.
export function nativeHeaders(deviceId) {
  return {
    'user-agent': `ChatGPT/${AUTH_CONFIG.appVersion} (Android; build 2628614)`,
    'oai-package-name': 'com.openai.chatgpt',
    'oai-client-type': 'android',
    'accept-language': 'en-US',
    ...(deviceId ? { 'oai-device-id': deviceId } : {}),
  };
}
