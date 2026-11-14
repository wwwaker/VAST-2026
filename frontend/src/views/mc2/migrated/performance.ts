type Sample = {name:string;ms:number;at:number;detail?:string};
const samples:Sample[]=[];
let scenario="initial-entry", dataVersion="unknown", startedAt=Date.now();
export function recordTiming(name:string,ms:number,detail?:string){samples.push({name,ms,at:Date.now(),detail});if(samples.length>2000)samples.splice(0,samples.length-2000);}
export function beginDiagnostics(label:string){scenario=label;startedAt=Date.now();samples.length=0;}
export function setDiagnosticVersion(version:string){dataVersion=version;}
export function diagnostics(){
  const keys=new Map<string,number>();samples.filter(s=>s.name==='request').forEach(s=>keys.set(s.detail??'',(keys.get(s.detail??'')??0)+1));
  return {scenario,startedAt,dataVersion,userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,viewport:{width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio},
    requestCount:[...keys.values()].reduce((a,b)=>a+b,0),duplicateQueryKeys:[...keys].filter(([,n])=>n>1),samples:[...samples],
    caveat:"interactive-frame measures the next animation callback after a commit; visual readiness and frame smoothness require browser acceptance. Cache-hit/shared-request samples identify client cache state."};
}
export function exportDiagnostics(){const url=URL.createObjectURL(new Blob([JSON.stringify(diagnostics(),null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`mc2-experience-${Date.now()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
declare global { interface Window { __mc2Diagnostics?: typeof diagnostics; } }
if(typeof window!=="undefined") {
  window.__mc2Diagnostics=diagnostics;
  if(typeof PerformanceObserver!=="undefined")try{const observer=new PerformanceObserver(list=>list.getEntries().forEach(e=>recordTiming('long-task',e.duration)));observer.observe({type:'longtask',buffered:true});}catch{/* Unsupported browsers still record requests and commits. */}
}
