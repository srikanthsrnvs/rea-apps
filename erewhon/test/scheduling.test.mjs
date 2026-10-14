import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseTime,checkoutForm} from '../src/ordering-protocol.mjs';

const quote={schedule_types:[{_id:'ahead',is_selected:true,day_hours:['10-14-2026','10-15-2026'].map(date=>({hours:[{time:'01:00 PM - 01:10 PM',date_mdy:date,is_default:false,is_selected:false}]})),order_time:{time:'unselected',is_default:false}}]};
test('repeated daily time windows require a matching server date',()=>{
 assert.throws(()=>chooseTime(quote,{time:'01:00 PM - 01:10 PM'}),{code:'INVALID_SCHEDULE'});
 const chosen=chooseTime(quote,{time:'01:00 PM - 01:10 PM',scheduleDate:'10-15-2026'});
 assert.equal(chosen.time.date_mdy,'10-15-2026');assert.equal(chosen.time.is_default,true);
 assert.equal(chosen.schedules[0].day_hours[0].hours[0].is_selected,false);
 assert.equal(chosen.schedules[0].day_hours[1].hours[0].is_selected,true);
 assert.equal(quote.schedule_types[0].day_hours[1].hours[0].is_selected,false);
 const form=checkoutForm({cartId:'cart',cartTypeId:'primary'},quote,{time:'01:00 PM - 01:10 PM',scheduleDate:'10-15-2026'});
 assert.equal(JSON.parse(form.schedule_types)[0].order_time.date_mdy,'10-15-2026');
});
test('dates without a time or outside returned availability are rejected',()=>{
 for(const options of [{scheduleDate:'10-15-2026'},{time:'01:00 PM - 01:10 PM',scheduleDate:'10-16-2026'},{time:'01:00 PM - 01:10 PM',scheduleDate:'not-a-date'}])assert.throws(()=>chooseTime(quote,options),{code:'INVALID_SCHEDULE'});
});
