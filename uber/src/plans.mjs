import { randomUUID } from 'node:crypto';
import { readState, saveState } from './state.mjs';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requireUUID(value, label) {
  if (!uuidPattern.test(value ?? ''))
    throw new Error(`${label} must be a UUID`);
  return value;
}

// Called under the authenticated state lock. Plans are private snapshots shown
// for approval; the server price/fee must be rechecked before execution.
export async function savePlan(
  kind,
  session,
  data,
  { ttlMs = 60_000, write = saveState } = {},
) {
  if (!session.userUUID)
    throw new Error('Session has no rider ID; sign in again');
  const plan = {
    ...data,
    id: randomUUID(),
    kind,
    userUUID: session.userUUID,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    operationId: randomUUID(),
  };
  await write(`plan-${plan.id}`, plan);
  return plan;
}
export async function loadPlan(
  id,
  kind,
  session,
  { read = readState, now = Date.now() } = {},
) {
  requireUUID(id, 'Plan ID');
  const plan = await read(`plan-${id}`);
  if (!plan || plan.kind !== kind)
    throw new Error(`No ${kind} plan with that ID`);
  if (plan.userUUID !== session.userUUID)
    throw new Error('Plan belongs to another signed-in rider');
  if (!Number.isFinite(plan.expiresAt) || plan.expiresAt <= now)
    throw new Error(
      'Plan expired; prepare it again for the current price or fee',
    );
  return plan;
}
