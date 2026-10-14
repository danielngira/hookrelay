export type RunMetricInput = { durationMs: number; status: string };
export type RunMetrics = { p50Ms:number;p95Ms:number;p99Ms:number;rps:number;errorRate:number;total:number;completed:number;succeeded:number;pending:number };
export function calculateRunMetrics(deliveries: RunMetricInput[], elapsedMs: number): RunMetrics {
  const latencies=deliveries.map(d=>d.durationMs).filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b);
  const percentile=(p:number)=>latencies.length?latencies[Math.min(latencies.length-1,Math.ceil(p*latencies.length)-1)]??0:0;
  const completed=deliveries.filter(d=>d.status==="succeeded"||d.status==="dead_letter").length;
  const succeeded=deliveries.filter(d=>d.status==="succeeded").length;
  return {p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),rps:Number((completed/Math.max(1,elapsedMs/1000)).toFixed(2)),errorRate:deliveries.length?Number(((deliveries.length-succeeded)/deliveries.length*100).toFixed(1)):0,total:deliveries.length,completed,succeeded,pending:deliveries.length-completed};
}
export type MetricComparison={absolute:number;percent:number|null;direction:"up"|"down"|"same"};
export function compareRunMetrics(current:RunMetrics,baseline:RunMetrics):Record<"p50Ms"|"p95Ms"|"p99Ms"|"rps"|"errorRate",MetricComparison>{
  const keys:[keyof RunMetrics,...(keyof RunMetrics)[]]=["p50Ms","p95Ms","p99Ms","rps","errorRate"];
  return Object.fromEntries(keys.map(key=>{const a=current[key],b=baseline[key];const delta=Number(a)-Number(b);return [key,{absolute:delta,percent:Number(b)===0?null:Number(((delta/Number(b))*100).toFixed(1)),direction:delta===0?"same":delta>0?"up":"down"}];})) as Record<"p50Ms"|"p95Ms"|"p99Ms"|"rps"|"errorRate",MetricComparison>;
}
