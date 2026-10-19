import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ClaudeError } from './errors.mjs';

export const API_ORIGIN='https://claude.ai';
// Public compatibility values recovered from the installed app. These are not
// hardware attestation; each CLI installation creates its own device ID.
export function createProfile(){return {deviceId:randomUUID(),createdAt:new Date().toISOString(),host:{platform:os.platform(),arch:os.arch(),release:os.release()},androidAPI:'36'};}
export function nativeHeaders(profile){
  if(!/^[0-9a-f-]{36}$/i.test(profile?.deviceId??'')||!/^\d{1,3}$/.test(profile.androidAPI??''))throw new ClaudeError('INVALID_PROFILE','The saved CLI device profile is invalid.');
  return {
    'user-agent':`Claude com.anthropic.claude/1.261016.51 (Android ${profile.androidAPI}) Claude/1.261016.51`,
    'Anthropic-Client-Platform':'android','Anthropic-Client-App':'com.anthropic.claude',
    'Anthropic-Client-Version':'1.261016.51','Anthropic-Client-Build':'26101651',
    'Anthropic-Client-OS-Version':profile.androidAPI,'Anthropic-Device-ID':profile.deviceId,
    'accept-language':'en-US',
  };
}
// Verification is the official web attestation protocol. Keep the tested
// public compatibility user agent; no Android integrity proof is claimed.
export function verificationHeaders(profile){
 const headers=nativeHeaders(profile);
 headers['Anthropic-Client-Platform']='web_claude_ai';
 for(const key of ['Anthropic-Client-App','Anthropic-Client-OS-Version','Anthropic-Client-Version','Anthropic-Client-Build'])delete headers[key];
 headers['anthropic-client-capabilities']='mfa_sms_v1, mfa_email_v1';
 return headers;
}
