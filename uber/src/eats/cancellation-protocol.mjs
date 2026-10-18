// Native ES4 resolution actions. Paths and source evidence are documented in
// docs/eats-protocol.md; the caller owns account/order binding and approval.
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonempty = (value) =>
  typeof value === 'string' && value.trim().length > 0;

function fail(message, code = 'EATS_RESPONSE_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function uuid(value, label, code = 'EATS_INVALID_ARGUMENT') {
  if (typeof value !== 'string' || !uuidPattern.test(value))
    fail(`${label} must be a UUID`, code);
  return value;
}

// Keep server-authorized actions intact, including unknown fields, while
// rejecting non-JSON or unbounded values before they enter a saved plan.
function copy(value) {
  let nodes = 0;
  const seen = new Set();
  function check(item, depth) {
    if (++nodes > 20000 || depth > 32)
      fail('Uber Eats returned oversized cancellation data');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      if (item.length > 131072)
        fail('Uber Eats returned oversized cancellation text');
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (
      typeof item !== 'object' ||
      seen.has(item) ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      fail('Uber Eats returned non-JSON cancellation data');
    seen.add(item);
    for (const child of Object.values(item)) check(child, depth + 1);
    seen.delete(item);
  }
  check(value, 0);
  const encoded = JSON.stringify(value);
  if (encoded.length > 1048576)
    fail('Uber Eats returned oversized cancellation data');
  return JSON.parse(encoded);
}

function body(payload) {
  const value = object(payload?.body) ? payload.body : payload;
  if (!object(value)) fail('Uber Eats returned invalid cancellation data');
  return copy(value);
}

function actionIdentity(action, type = 'AUTH_CANCEL') {
  if (
    !object(action) ||
    action.actionType !== type ||
    !nonempty(action.token) ||
    action.token.length > 131072
  )
    fail('Uber Eats returned no valid authorized cancellation action');
  uuid(action.uuid, 'Cancellation action ID', 'EATS_RESPONSE_INVALID');
  return action;
}

// RichText -> RichTextElement.text -> TextElement.text -> StyledText.text.
// Preserve the original tree; this only checks that a modal has readable terms.
function hasText(value) {
  if (Array.isArray(value)) return value.some(hasText);
  if (!object(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      ((key === 'text' || key === 'accessibilityText') && nonempty(child)) ||
      (typeof child === 'object' && child !== null && hasText(child)),
  );
}

function termsFor(action) {
  const text = action.text;
  const modal = action.overridingResolutionModal;
  if (text !== undefined && text !== null && !object(text))
    fail('Uber Eats returned malformed cancellation terms');
  if (modal !== undefined && modal !== null && !object(modal))
    fail('Uber Eats returned malformed cancellation confirmation');
  const finalCharges = text?.finalCharges;
  if (
    finalCharges !== undefined &&
    finalCharges !== null &&
    (!Array.isArray(finalCharges) ||
      finalCharges.some(
        (charge) =>
          !object(charge) ||
          ['label', 'value', 'key', 'type'].some(
            (field) =>
              charge[field] !== undefined &&
              charge[field] !== null &&
              typeof charge[field] !== 'string',
          ),
      ))
  )
    fail('Uber Eats returned malformed final cancellation charges');
  if (object(modal)) {
    if (!hasText(modal.header) && !hasText(modal.description))
      fail('Uber Eats returned no readable cancellation confirmation');
    if (!object(modal.primaryButton))
      fail('Uber Eats returned no cancellation confirmation button');
  } else if (!nonempty(text?.title) || !nonempty(text?.confirmation)) {
    fail('Uber Eats returned no complete cancellation terms');
  }
  // Missing charges never imply free cancellation. Preserve all supplied terms.
  return {
    text: text ?? null,
    finalCharges: finalCharges ?? null,
    overridingResolutionModal: modal ?? null,
    value: action.value ?? null,
  };
}

export function eatsCancellationOptionsRequest(orderId) {
  return {
    request: {
      issues: [
        {
          issueType: 'CANCEL',
          order: { uuid: uuid(orderId, 'Order ID') },
        },
      ],
    },
  };
}

export function normalizeEatsCancellationOptions(payload, orderId) {
  uuid(orderId, 'Order ID');
  const value = body(payload);
  if (!Array.isArray(value.actions) || !value.actions.length)
    fail(
      'Uber Eats did not authorize cancellation for this order',
      'EATS_CANCELLATION_UNAVAILABLE',
    );
  const actions = value.actions.filter(
    (action) => object(action) && action.actionType === 'AUTH_CANCEL',
  );
  const feedback = value.actions.filter(
    (action) => object(action) && action.actionType === 'CANCEL_FEEDBACK',
  );
  if (actions.length !== 1 || feedback.length !== 1)
    fail(
      'Uber Eats returned unavailable or ambiguous cancellation options',
      'EATS_CANCELLATION_UNAVAILABLE',
    );
  const action = actionIdentity(actions[0]);
  const feedbackAction = actionIdentity(feedback[0], 'CANCEL_FEEDBACK');
  if (action.uuid.toLowerCase() === feedbackAction.uuid.toLowerCase())
    fail('Uber Eats returned conflicting cancellation action identities');
  return {
    // This is request-context binding. The native response DTO does not echo
    // an order ID; action.uuid identifies the authorization, not the order.
    orderId,
    actionId: action.uuid,
    action,
    feedbackAction,
    terms: termsFor(action),
  };
}

export function eatsFulfillCancellationRequest(action) {
  const authorized = actionIdentity(copy(action));
  termsFor(authorized);
  return { request: { actions: [authorized] } };
}

export function normalizeEatsCancellationResult(payload, expectedAction) {
  const expected = actionIdentity(copy(expectedAction));
  const value = body(payload);
  if (value.failedActions !== undefined && value.failedActions !== null) {
    if (!Array.isArray(value.failedActions))
      fail('Uber Eats returned malformed cancellation failures');
    if (value.failedActions.length)
      fail(
        'Uber Eats did not fulfill the cancellation',
        'EATS_CANCELLATION_FAILED',
      );
  }
  if (
    !Array.isArray(value.completedActions) ||
    value.completedActions.length !== 1
  )
    fail(
      'Cancellation completion is uncertain; check this order before retrying',
      'EATS_CANCELLATION_UNCERTAIN',
    );
  const completed = value.completedActions[0];
  const actual = completed?.action;
  if (
    !object(completed) ||
    (completed.error !== undefined &&
      completed.error !== null &&
      completed.error !== '') ||
    (completed.errorCode !== undefined &&
      completed.errorCode !== null &&
      completed.errorCode !== '') ||
    !object(actual) ||
    actual.actionType !== 'AUTH_CANCEL' ||
    typeof actual.uuid !== 'string' ||
    actual.uuid.toLowerCase() !== expected.uuid.toLowerCase() ||
    actual.token !== expected.token
  )
    fail(
      'Uber Eats did not confirm the expected cancellation action',
      'EATS_CANCELLATION_UNCERTAIN',
    );
  return {
    actionId: expected.uuid,
    fulfilled: true,
    requiresOrderVerification: true,
  };
}
