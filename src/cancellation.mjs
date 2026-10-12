import { authenticatedOperation } from './client.mjs';
import { cancellationInfoRequest,normalizeCancellationInfo,riderCancelRequest } from './cancellation-protocol.mjs';
import { executeMutation } from './mutations.mjs';
import { savePlan,loadPlan,requireUUID } from './plans.mjs';

export async function prepareCancellation({tripId,reason,refundStrategy,fulfillmentOrderId,comment}) {
  requireUUID(tripId,'Trip ID');
  if (fulfillmentOrderId!==undefined) requireUUID(fulfillmentOrderId,'Fulfillment order ID');
  const body=riderCancelRequest({reason,refundStrategy,fulfillmentOrderId,comment});
  return authenticatedOperation(async({session,send})=>{
    const preview=normalizeCancellationInfo(await send(`/rt/trips/${tripId}/cancellation-info`,cancellationInfoRequest({reasonId:reason})));
    if (preview.chargeFee===null) throw new Error('Uber did not identify the cancellation fee decision; inspect status and the private response before cancelling');
    const plan=await savePlan('cancellation',session,{tripId,body,preview});
    return {planId:plan.id,operationId:plan.operationId,expiresAt:plan.expiresAt,tripId,preview,next:`uber cancel --plan-id ${plan.id} --confirm`};
  });
}

export async function confirmCancellation(planId,{raw=false}={}) {
  return authenticatedOperation(async({session,send})=>{
    const plan=await loadPlan(planId,'cancellation',session);
    const current=normalizeCancellationInfo(await send(`/rt/trips/${plan.tripId}/cancellation-info`,cancellationInfoRequest({reasonId:plan.body.reason})));
    if (JSON.stringify(current)!==JSON.stringify(plan.preview)) throw new Error('Cancellation terms changed; prepare and review a new cancellation plan');
    const response=await executeMutation({id:plan.operationId,kind:'cancellation',endpoint:`/rt/trips/${plan.tripId}/rider-cancel`,body:plan.body,context:{tripId:plan.tripId,preview:plan.preview},validate:payload=>{
      if (!payload || !['trip','clientStatus','singleRiderAppOrderResponse'].some(key=>Object.hasOwn(payload,key))) throw new Error('Unrecognized cancellation result');
    }},send);
    return {operationId:plan.operationId,tripId:plan.tripId,clientStatus:response.clientStatus??null,
      receipt:response.authHoldPayload?{title:response.authHoldPayload.title??null,message:response.authHoldPayload.message??null}:null,
      paymentInfo:response.tripCancellationPaymentInfoPayload??null,...(raw?{response}:{})};
  });
}
