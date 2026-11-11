// A renderer receives all plot rows through structuredContent. The language
// model gets the exact summary/preview instead of thousands of numeric cells.
export function modelView(result, location = 'structuredContent.data.chart') {
  const chart=result?.data?.chart;
  if(chart?.kind!=='line_overlay')return result;
  const {rows,rawRows,preview,...metadata}=chart;
  return{...result,data:{...result.data,chart:{...metadata,...(chart.dataIncluded?{fullDataLocation:location}:{}),
    dataNote:'All plot rows and exact sample observations are for the renderer. Answer from the returned series summaries and correlations; do not invent intermediate observations, causes, or leverage ratios.'}}};
}
