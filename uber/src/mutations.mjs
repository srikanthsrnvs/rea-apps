import { createHash } from 'node:crypto';
import { readState, saveState } from './state.mjs';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const definitelyRejected = new Set([400, 401, 403, 404, 422]);

function uncertainOperation(id, cause) {
  const error = new Error(
    `Uber may have accepted this operation. Do not repeat it; check trip status and inspect operation ${id}.`,
    { cause },
  );
  error.code = 'outcome_unknown';
  error.operationId = id;
  return error;
}

/** Must run inside the authenticated state lock. Never retries a mutation. */
export async function executeMutation(
  { id, kind, endpoint, body, validate, context },
  send,
  { read = readState, write = saveState } = {},
) {
  if (!uuid.test(id ?? '')) throw new Error('Operation ID must be a UUID');
  if (!['booking', 'cancellation'].includes(kind))
    throw new Error('Unknown mutation type');
  const key = `operation-${id}`;
  const digest = createHash('sha256')
    .update(JSON.stringify({ kind, endpoint, body }))
    .digest('hex');
  const existing = await read(key);
  if (existing) {
    if (existing.digest !== digest)
      throw new Error(
        'An operation ID cannot be reused for a different request',
      );
    if (existing.state === 'accepted') return existing.response;
    if (existing.state === 'rejected') {
      const error = new Error(
        'This operation was rejected. Prepare a new operation after fixing the reported error.',
      );
      error.code = 'operation_rejected';
      error.operationId = id;
      throw error;
    }
    throw uncertainOperation(id);
  }
  const record = {
    id,
    kind,
    endpoint,
    digest,
    state: 'submitting',
    createdAt: new Date().toISOString(),
    ...(context ? { context } : {}),
  };
  // If this write fails, nothing is sent. A killed process leaves a recoverable record.
  await write(key, record);
  let response;
  try {
    response = await send(endpoint, body, { readOnly: false, callUuid: id });
    if (validate) validate(response);
  } catch (cause) {
    const rejected = definitelyRejected.has(cause.status);
    try {
      await write(key, {
        ...record,
        state: rejected ? 'rejected' : 'unknown',
        updatedAt: new Date().toISOString(),
        error: {
          message: cause.message,
          status: cause.status ?? null,
          code: cause.code ?? null,
        },
      });
    } catch {
      throw uncertainOperation(id, cause);
    }
    if (rejected) {
      cause.operationId = id;
      throw cause;
    }
    throw uncertainOperation(id, cause);
  }
  try {
    await write(key, {
      ...record,
      state: 'accepted',
      updatedAt: new Date().toISOString(),
      response,
    });
  } catch (cause) {
    throw uncertainOperation(id, cause);
  }
  return response;
}

export async function inspectOperation(id) {
  if (!uuid.test(id ?? '')) throw new Error('Operation ID must be a UUID');
  const record = await readState(`operation-${id}`);
  if (!record) throw new Error('Operation was not found');
  return record;
}
