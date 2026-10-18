import { authenticatedOperation } from '../client.mjs';
import { readState, saveState } from '../state.mjs';
import { requireUUID } from '../plans.mjs';
import { normalizeEatsHistory } from './orders.mjs';
import {
  trackingId,
  normalizeEatsTracking,
  selectTrackedOrder,
  deliveryChanges,
} from './tracking.mjs';

export function createEatsTrackingReader({
  operation = authenticatedOperation,
  read = readState,
  write = saveState,
  now = Date.now,
} = {}) {
  return async function readTracking({ orderId, raw = false } = {}) {
    requireUUID(orderId, 'Order ID');
    const selected = trackingId(orderId);
    return operation(async ({ session, send }) => {
      const response = await send(
        '/rt/eats/v2/eaters/active-orders',
        { request: {} },
        { readOnly: true },
      );
      const order = selectTrackedOrder(response, selected);
      const alias = await read(`eats-tracking-alias-${selected}`);
      const workflowId =
        trackingId(order?.uuid) ??
        (alias?.userUUID === session.userUUID
          ? trackingId(alias.workflowId)
          : selected);
      const key = `eats-tracking-v1-${workflowId}`;
      const saved = await read(key);
      const previous = saved?.userUUID === session.userUUID ? saved : null;
      if (previous?.scene?.state === 'ended')
        return raw
          ? { scene: previous.scene, native: order ?? null }
          : previous.scene;
      let scene;
      if (order) {
        if (
          order.orderInfo?.eaterUUID &&
          order.orderInfo.eaterUUID !== session.userUUID
        )
          throw new Error('Delivery belongs to a different account');
        scene = normalizeEatsTracking(order, { now: now() });
        for (const id of [scene.tripId, scene.orderId])
          await write(`eats-tracking-alias-${id}`, {
            userUUID: session.userUUID,
            workflowId: scene.tripId,
          });
      }
      const terminalPhase = ['COMPLETED', 'UNFULFILLED'].includes(
        order?.orderInfo?.orderPhase,
      );
      if (!order || terminalPhase || scene?.delivery.stage === 'arrived') {
        // Absence is not completion. Verify a terminal history record before
        // stopping a subscription, and never switch to another active order.
        const history = normalizeEatsHistory(
          await send(
            `/rt/eats/v1/eaters/${session.userUUID}/orders?limit=100`,
            undefined,
            { method: 'GET', readOnly: true },
          ),
        );
        const identities = new Set(
          [
            selected,
            workflowId,
            scene?.orderId,
            previous?.scene?.orderId,
          ].filter(Boolean),
        );
        const completed = history.orders.find((o) =>
          identities.has(trackingId(o.orderId)),
        );
        const state = completed?.completionStatus?.completionState;
        const stages = {
          SUCCESS: 'delivered',
          EATER_CANCELLED: 'cancelled',
          OPS_CANCELLED: 'cancelled',
          RESTAURANT_CANCELLED: 'cancelled',
          RESTAURANT_UNFULFILLED: 'failed',
          DELIVERY_FAILED: 'failed',
          COULD_NOT_FIND_EATER: 'failed',
        };
        const stage = stages[state];
        const old = scene ?? previous?.scene;
        if (stage || !order || terminalPhase)
          scene = {
            ...(old ?? {
              schemaVersion: 1,
              kind: 'eats',
              tripId: workflowId,
              orderId: selected,
              waypoints: [],
              routes: [],
              driver: { position: null, path: [] },
              eta: {},
              pollingIntervalMs: 8000,
            }),
            observedAt: new Date(now()).toISOString(),
            state: stage ? 'ended' : 'unavailable',
            status: stage ?? 'Delivery status unavailable',
            driver: { position: null, path: [] },
            routes: [],
            delivery: {
              ...(old?.delivery ?? {
                orderId: selected,
                workflowId,
                storeName: completed?.storeName,
              }),
              stage: stage ?? 'unknown',
              stageSource: stage
                ? 'history.completionStatus'
                : 'active_order_absent',
              statusTitle: stage
                ? `Order ${stage}`
                : 'Delivery status unavailable',
              statusDetail: null,
              ...(stage
                ? {
                    eta: { display: null, detail: null },
                    delay: null,
                    progress: {
                      ...old?.delivery?.progress,
                      current: old?.delivery?.progress?.total ?? null,
                      animated: false,
                    },
                  }
                : {}),
              completionStatus: completed?.completionStatus
                ? {
                    completionState: state,
                    completionTime: Number.isFinite(
                      completed.completionStatus.completionTime,
                    )
                      ? completed.completionStatus.completionTime
                      : null,
                  }
                : null,
            },
            warnings: stage
              ? []
              : [
                  'The selected order is absent from active orders; completion has not been verified.',
                ],
          };
      }
      let sequence = previous?.sequence ?? 0;
      const events = deliveryChanges(previous?.scene, scene).map((change) => ({
        id: `${workflowId}:${++sequence}`,
        sequence,
        orderId: scene.orderId,
        workflowId,
        observedAt: scene.observedAt,
        ...change,
      }));
      const deliveryEvents = [
        ...(previous?.scene?.deliveryEvents ?? []),
        ...events,
      ].slice(-128);
      scene = { ...scene, deliveryEvents, eventCursor: sequence };
      await write(key, { userUUID: session.userUUID, sequence, scene });
      return raw ? { scene, native: order ?? null } : scene;
    });
  };
}
export const getEatsTracking = createEatsTrackingReader();
