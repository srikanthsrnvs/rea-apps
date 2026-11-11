import { ChartsError } from './errors.mjs';
export const periods = ['year_to_date','last_calendar_month','last_30_days','last_90_days','last_365_days'];
export function periodBounds(period, now = Date.now()) {
  if(!periods.includes(period)||!Number.isFinite(now))throw new ChartsError('INVALID_ARGUMENT','Choose a supported calendar period.');
  const current=new Date(now),y=current.getUTCFullYear(),m=current.getUTCMonth();
  let from,to=Math.floor(now/1000);
  if(period==='year_to_date')from=Date.UTC(y,0,1)/1000;
  else if(period==='last_calendar_month'){from=Date.UTC(y,m-1,1)/1000;to=Date.UTC(y,m,1)/1000-1;}
  else from=to-Number(period.match(/\d+/u)[0])*86400;
  return{from,to};
}
