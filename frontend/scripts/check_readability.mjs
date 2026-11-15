/** Meaningful behavior checks for source separation, display precision and explicit selection. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','SVGElement','Element','Node','Event','MouseEvent','KeyboardEvent','localStorage'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
const {createRoot}=await import('react-dom/client');
const {Simulate}=await import('react-dom/test-utils');
const built=await build({stdin:{contents:`export {HistoricalComparison,creationSummary,deletionConclusion} from './src/views/mc2/migrated/ComparisonTimeline'; export * from './src/views/mc2/migrated/timeDisplay'; export {StockSentimentLineChart} from './src/views/mc1/reference/components/StockSentimentLineChart';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom'],logLevel:'silent'});
const mod={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const {HistoricalComparison,creationSummary,deletionConclusion,duration,timeTicks,rangeLabels,StockSentimentLineChart}=mod.exports;
const checks=[],check=(name,result)=>{assert.ok(result,name);checks.push(name);console.log('PASS',name);};
const root=createRoot(document.querySelector('#root'));
const flush=()=>act(()=>new Promise(resolve=>setTimeout(resolve,20)));
const click=el=>act(async()=>{assert.ok(el,'click target');el.dispatchEvent(new MouseEvent('click',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,0));});
const button=name=>[...document.querySelectorAll('button')].find(b=>b.textContent===name);
const item=(id,lag=2e6)=>({event_id:id,time_sort_us:100e6,actor_id:'a',file_id:id,path:`${id}.txt`,content_status:'metadata_only',content_note:'仅元数据',operations:[{event_id:`${id}-create`,event_type:'create_file',time_sort_us:90e6},{event_id:`${id}-post`,event_type:'saidit_post',time_sort_us:100e6}],create_lag_us:10e6,delete_lag_us:lag});
check('Long intervals use days, hours, minutes and seconds',duration(677954e6)==='7天20小时19分14秒');
check('Creation duration is explicitly earlier than publication',creationSummary(item('x')).includes('早于发布 10秒'));
check('Unknown deletion is not counted as a different observed lag',deletionConclusion([item('x'),item('y',null)]).includes('1 例未见删除记录'));
check('Empty selection has no generated conclusion',deletionConclusion([])==='');
const micro=timeTicks(-3,8);check('Microsecond ticks remain distinct and contain zero',new Set(micro.map(t=>t.label)).size===micro.length&&micro.some(t=>t.value===0)&&micro.every(t=>t.value>=-3&&t.value<8));
check('Cross-midnight range labels retain both dates',rangeLabels(Date.UTC(2025,0,1,23,59)*1000,Date.UTC(2025,0,2,0,1)*1000).every(s=>s.includes('01-')));
let version='v1',pending=[];
globalThis.fetch=async url=>{
  const u=new URL(url),before=u.searchParams.get('before_us');
  if(before)return await new Promise(resolve=>pending.push(()=>resolve({ok:true,headers:{get(){return null;}},json:async()=>({meta:{data_version:version,before_us:Number(before)},items:[item('late')],total:1,offset:0,note:''})})));
  return {ok:true,headers:{get(){return null;}},json:async()=>({meta:{data_version:version,before_us:null},items:[item('a'),item('b'),item('c')],total:3,offset:0,note:''})};
};
const renderCompare=async anchorTime=>{await act(()=>root.render(React.createElement(HistoricalComparison,{open(){},types:[],anchorTime})));await flush();};
await renderCompare();
check('Initial candidates are explicitly checked and exactly match displayed rows',document.querySelectorAll('.w-compare-picks input:checked').length===3&&document.querySelectorAll('.w-compare-row').length===3);
for(const el of [...document.querySelectorAll('.w-compare-picks input')])await click(el);
check('Unchecking the final item leaves an empty view and no stale conclusion',!document.querySelector('.w-compare-row')&&!document.querySelector('[data-testid="comparison-conclusion"]')&&document.body.textContent.includes('尚未选择实例'));
await click(button('字段表'));check('View changes preserve deliberate empty selection',!document.querySelector('.w-comparison')&&document.querySelectorAll('.w-compare-picks input:checked').length===0);
await click(button('选择前三例'));check('Explicit reset populates the same three table columns',document.querySelectorAll('.w-comparison thead th').length===4&&document.querySelectorAll('.w-compare-picks input:checked').length===3);
await click(button('时间对齐'));await click(document.querySelector('.w-compare-row [role=button]'));await click(document.querySelector('.w-compare-picks input'));
check('Removing a row clears its selected event',!document.querySelector('.w-event-inspector'));
await renderCompare(1);
await act(async()=>{Simulate.change(document.querySelector('select[aria-label="比较候选范围"]'),{target:{value:'anchor'}});await Promise.resolve();});await flush();
await act(async()=>{Simulate.change(document.querySelector('select[aria-label="比较候选范围"]'),{target:{value:'all'}});await Promise.resolve();});await flush();
await act(async()=>{pending.forEach(resolve=>resolve());await new Promise(resolve=>setTimeout(resolve,20));});await flush();
check('Late prior-scope response cannot replace current candidates',!document.body.textContent.includes('late.txt')&&document.querySelectorAll('.w-compare-picks input:checked').length===3);
// Market fixtures isolate the forbidden promotion of evidence into source prices.
const market={time_buckets:['2046-06-05T15:00:00','2046-06-05T16:00:00'],series:[{time_bucket:'2046-06-05T15:00:00',stock_price:180,price_disputed:true,market_sentiment_label:'CRITICAL',market_sentiment_value:-1,computed_change:{value:null,reason:'口径待核对'},price_evidence:[{kind:'model_baseline',value:25.8,recorded_time:'2046-06-05T15:29:00',assumptions:['模型基准']} ]},{time_bucket:'2046-06-05T16:00:00',stock_price:null,market_sentiment_label:'LOW',market_sentiment_value:-.4,computed_change:{value:null,reason:'缺失'},price_evidence:[{kind:'forecast',range:[33,38],recorded_time:'2046-06-05T16:18:00',condition:'获同意后自行公布',assumptions:[]}]}]};
await act(()=>root.render(React.createElement(StockSentimentLineChart,{data:market,granularity:'hourly',showStock:true,showSentiment:true})));
check('Market defaults to raw values with no promoted forecast point',!document.querySelector('[data-evidence-kind]')&&!document.querySelector('[data-testid="raw-stock-path"]').getAttribute('d').includes('L'));
await click(document.querySelector('.market-controls input'));
check('Optional evidence shows distinct model and interval encodings',document.querySelector('[data-evidence-kind=model_baseline]')&&document.querySelector('[data-evidence-kind=forecast] line[stroke-dasharray]'));
await click(document.querySelector('[data-evidence-kind=forecast]'));
check('Forecast detail retains range and premise and excludes computed returns',document.querySelector('.market-details').textContent.includes('$33～$38')&&document.querySelector('.market-details').textContent.includes('获同意后自行公布')&&document.querySelector('.market-details').textContent.includes('不计算：缺失'));
const trend={time_buckets:['a','b','c','d','e','f'],series:[
  {time_bucket:'a',stock_price:38.7,market_sentiment_label:'neutral'},
  {time_bucket:'b',stock_price:31.5,market_sentiment_label:'cautious'},
  {time_bucket:'c',stock_price:180,price_disputed:true,market_sentiment_label:'low'},
  {time_bucket:'d',stock_price:27.2,market_sentiment_label:'critical'},
  {time_bucket:'e',stock_price:18,price_disputed:true,market_sentiment_label:'critical'},
  {time_bucket:'f',stock_price:null,market_sentiment_label:'recovering'},
]};
await act(()=>root.render(React.createElement(StockSentimentLineChart,{data:trend,granularity:'hourly',showStock:true,showSentiment:true})));await flush();
const d=document.querySelector('[data-testid="raw-stock-path"]').getAttribute('d');
check('Focused prices retain disputed values as explicit boundary markers without bridging their positions',document.querySelectorAll('[data-outside-price]').length===2&&document.querySelector('[data-outside-price="180"]')&&document.querySelector('[data-outside-price="18"]')&&(d.match(/M/g)||[]).length===2&&(d.match(/L/g)||[]).length===1);
check('Sentiment restores a categorical staircase without inventing intermediate measurements',document.querySelector('[data-testid="market-sentiment-path"]').getAttribute('d').includes('H')&&document.body.textContent.includes('类别等距排列')&&!document.querySelector('[data-testid="market-sentiment-path"]').getAttribute('d').includes('NaN'));
await click(document.querySelector('[data-market-bucket="c"]'));
check('Out-of-range source price remains accessible with its original value',document.querySelector('.market-details').textContent.includes('原始价格快照：$180'));
await click(button('全部原值'));
check('Full scale restores every source price at its actual height and preserves selected provenance',!document.querySelector('[data-outside-price]')&&document.querySelector('[data-raw-price="180"]')&&document.querySelector('[data-raw-price="18"]')&&document.querySelector('.market-details').textContent.includes('原始价格快照：$180'));
await click(button('走势放大'));
check('Scale changes preserve null price gaps and never replace original values',document.querySelectorAll('[data-missing-price]').length===1&&trend.series[2].stock_price===180&&trend.series[4].stock_price===18&&trend.series[5].stock_price===null);
await act(()=>root.unmount());
console.log(`Passed ${checks.length} readability behavior checks.`);
