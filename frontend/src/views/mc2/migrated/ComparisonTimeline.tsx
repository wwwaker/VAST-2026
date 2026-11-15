import { WorkspaceSelect } from "./WorkspaceSelect";
import { useEffect, useRef, useState } from "react";
import { EMPTY_FILTERS } from "../../../data/filterContext";
import type { TypeInfo } from "../../../data/api";
import { query, type Comparison } from "./workspaceApi";
import { fileActionColor } from "./mc2Visuals";
import { ProcessSymbol } from "./LocalProcess";
import { duration, relativeTime, timeTicks } from "./timeDisplay";
import { PendingRegion, RequestStatus, actor, displayId, time, typeLabel, useRequest, type ReaderTarget } from "./shared";

export { relativeTime } from "./timeDisplay";
type Item = Comparison['items'][number];
type Operation = Item['operations'][number];
const status = (i:Item) => i.content_status==='available'?'可定位正文':i.content_status==='metadata_only'?'只有元数据':'尚无法解析';
export const creationSummary = (i:Item) => i.create_lag_us===null?'未见创建记录':`创建早于发布 ${duration(i.create_lag_us)}`;
const deletionSummary = (i:Item) => i.delete_lag_us===null?'未见删除记录':`首次删除晚于发布 ${duration(i.delete_lag_us)}`;
export function deletionConclusion(items:Item[]) {
  if(!items.length)return '';
  const known=items.filter(i=>i.delete_lag_us!==null),missing=items.length-known.length;
  if(known.length===items.length&&known.every(i=>i.delete_lag_us===known[0].delete_lag_us))return `所选 ${items.length} 例均记录发布后 ${duration(known[0].delete_lag_us!)} 首次删除。`;
  return `${known.length} 例有明确首次删除记录${missing?`，${missing} 例未见删除记录，不等于行为未发生`:'，间隔存在差异'}。`;
}
export function HistoricalComparison({ open, types, anchorTime }: { open:(t:ReaderTarget,e:HTMLElement)=>void;types:TypeInfo[];anchorTime?:number }) {
  const emptyReset=useRef<HTMLButtonElement>(null);
  const [offset,setOffset]=useState(0),[cutoff,setCutoff]=useState(anchorTime!==undefined),[view,setView]=useState('timeline'),[full,setFull]=useState(false);
  const [selection,setSelection]=useState<{key:string;ids:string[]}|null>(null);
  const [point,setPoint]=useState<{key:string;item:Item;op:Operation}|null>(null),[outside,setOutside]=useState<string|null>(null);
  const before=cutoff&&anchorTime!==undefined?anchorTime+1:undefined;
  const requestKey=`compare:${offset}:${before}`;
  const resource=useRequest(requestKey,s=>query<Comparison>('comparison',{offset,before_us:before},s));
  const data=!resource.loading&&!resource.error?resource.data:undefined;
  const groupKey=data?`${data.meta.data_version}:${data.meta.before_us}:${data.offset}`:'';
  const selected=selection?.key===groupKey?selection.ids:data?.items.slice(0,3).map(i=>i.event_id)??[];
  useEffect(()=>{if(data&&selection?.key!==groupKey){setSelection({key:groupKey,ids:data.items.slice(0,3).map(i=>i.event_id)});setPoint(null);setOutside(null);}},[data,groupKey,selection?.key]);
  const displayed=data?.items.filter(i=>selected.includes(i.event_id))??[];
  const activePoint=point?.key===groupKey&&displayed.some(i=>i.event_id===point.item.event_id)?point:null;
  const toggle=(id:string)=>{setSelection({key:groupKey,ids:selected.includes(id)?selected.filter(v=>v!==id):[...selected,id].slice(0,3)});if(point?.item.event_id===id)setPoint(null);if(outside===id)setOutside(null);};
  const read=(id:string,kind:'event'|'file',el:HTMLElement)=>open({kind,id,reading:{filters:{...EMPTY_FILTERS},label:'发布实例比较 · 精确文件全历史',independent:true}},el);
  const deltas=displayed.flatMap(i=>i.operations.map(o=>o.time_sort_us-i.time_sort_us));
  const min=full?Math.min(-60e6,...deltas):-60e6,max=full?Math.max(10e6,...deltas):10e6;
  const x=(t:number)=>20+(t-min)/Math.max(1,max-min)*700;
  const rows=displayed.map(item=>{
    const ends:number[]=[],marks=item.operations.filter(o=>o.time_sort_us-item.time_sort_us>=min&&o.time_sort_us-item.time_sort_us<=max).map(op=>{
      const px=x(op.time_sort_us-item.time_sort_us);let track=ends.findIndex(v=>v<px-20);if(track<0)track=ends.length;ends[track]=px+20;
      return {op,px,track};
    });
    return {item,marks,height:Math.max(104,ends.length*26+35)};
  });
  const ticks=timeTicks(min,max,700);
  return <div className="w-comparison-workspace">
    <div className="w-process-tools"><label>候选范围<WorkspaceSelect aria-label="比较候选范围" value={cutoff?'anchor':'all'} onChange={e=>{setCutoff(e.target.value==='anchor');setOffset(0);setSelection(null);setPoint(null);setOutside(null);}}><option value="all">全库明确来源发布</option><option value="anchor" disabled={anchorTime===undefined}>截至进入时锚点（含）</option></WorkspaceSelect></label><div className="w-tabs"><button aria-pressed={view==='timeline'} onClick={()=>setView('timeline')}>时间对齐</button><button aria-pressed={view==='table'} onClick={()=>setView('table')}>字段表</button></div><button aria-pressed={full} onClick={()=>setFull(v=>!v)}>{full?'返回发布前60秒/后10秒':'完整真实时间'}</button><details><summary>比较范围说明</summary><p>仅比较明确引用内容来源的发布子集。文件操作取全历史，相同文件可能出现在多行；不代表全部发布或完整因果链。创建取发布前最近一次，删除取发布后首次。未见记录不等于行为未发生。</p>{anchorTime!==undefined&&<p>进入时锚点 {time(anchorTime)}</p>}</details></div>
    <div className="w-fingerprint-legend">{['create_file','read_file','delete_file','saidit_post'].map(action=><span key={action}><svg width={18} height={18}><ProcessSymbol x={9} y={9} type={action} color={fileActionColor(action)}/></svg>{typeLabel(action,types)}</span>)}<span>橙色虚线＝发布时刻 · 点击标记核对记录</span></div>
    <RequestStatus {...resource} maskWhileLoading loadingLabel="正在加载发布实例比较…"/><PendingRegion {...resource} minimum={250} maskWhileLoading>
    {data&&<><p>候选 {data.total} 例 · 已选 {displayed.length}/3 · 有明确来源引用的发布</p><div className="w-compare-picks">{data.items.map(i=><label key={i.event_id} className="check"><input type="checkbox" checked={selected.includes(i.event_id)} disabled={!selected.includes(i.event_id)&&selected.length===3} onChange={()=>toggle(i.event_id)}/><span title={i.path}>{i.path}</span></label>)}<button disabled={!selected.length} onClick={()=>{setSelection({key:groupKey,ids:[]});setPoint(null);setOutside(null);requestAnimationFrame(()=>emptyReset.current?.focus());}}>清空选择</button><span>同时最多 3 例</span></div>
    {!displayed.length?<div className="mc2-empty">尚未选择实例 <button ref={emptyReset} disabled={!data.items.length} onClick={()=>setSelection({key:groupKey,ids:data.items.slice(0,3).map(i=>i.event_id)})}>选择前三例</button></div>:<>
    {view==='timeline'?<><p className="mc2-note">发布为0秒；所选行共用真实比例。{full?'共同完整跨度':'共同视窗：−60秒至＋10秒'}；同秒事件纵向错开，时间坐标不移动。</p><div className="w-comparison-scroll" aria-label="发布实例真实时间对齐" role="group"><div className="w-compare-axis"><span>明确关联文件与间隔</span><svg width={740} height={38}>{ticks.map(t=><text key={t.value} x={x(t.value)} y={24} textAnchor="middle">{t.label}</text>)}</svg></div>
    {rows.map(({item:i,marks,height})=><div className="w-compare-row" key={i.event_id} data-event-id={i.event_id}><div className="w-compare-row-tools"><div className="w-compare-file"><button className="w-text-link" title={i.path} onClick={e=>read(i.file_id,'file',e.currentTarget)}>{i.path} · 阅读全历史</button><span>{status(i)}</span></div><div className="w-compare-lag"><span>{creationSummary(i)}</span>{!full&&i.operations.some(o=>o.time_sort_us-i.time_sort_us<min||o.time_sort_us-i.time_sort_us>max)&&<button aria-expanded={outside===i.event_id} onClick={()=>setOutside(outside===i.event_id?null:i.event_id)}>窗外 {i.operations.filter(o=>o.time_sort_us-i.time_sort_us<min).length} 早 / {i.operations.filter(o=>o.time_sort_us-i.time_sort_us>max).length} 晚</button>}</div><span>{deletionSummary(i)}</span></div><svg width={740} height={height} aria-label={`${i.path} 相对时间操作`}>
      {ticks.map(t=><line key={t.value} x1={x(t.value)} x2={x(t.value)} y1={0} y2={height} stroke="#d5e0ea"/>)}<line x1={20} x2={720} y1={25} y2={25} stroke="#8b9eaf"/><line x1={x(0)} x2={x(0)} y1={0} y2={height} stroke="#a56817" strokeDasharray="4 3"/>
      {marks.map(({op:o,px,track})=><g key={o.event_id} role="button" tabIndex={0} aria-label={`${i.path} ${typeLabel(o.event_type,types)} ${relativeTime(o.time_sort_us-i.time_sort_us)}`} onClick={()=>setPoint({key:groupKey,item:i,op:o})} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setPoint({key:groupKey,item:i,op:o});}}}><title>{time(o.time_sort_us)} · {relativeTime(o.time_sort_us-i.time_sort_us)} · {o.event_type} · {o.event_id}</title><circle cx={px} cy={25+track*26} r={13} fill="transparent"/><ProcessSymbol x={px} y={25+track*26} type={o.event_type} color={activePoint?.op.event_id===o.event_id?'#2469b5':fileActionColor(o.event_type)}/></g>)}
    </svg>{outside===i.event_id&&!full&&<ul className="w-compare-outside">{i.operations.filter(o=>o.time_sort_us-i.time_sort_us<min||o.time_sort_us-i.time_sort_us>max).map(o=><li key={o.event_id}><button onClick={()=>setPoint({key:groupKey,item:i,op:o})}>{relativeTime(o.time_sort_us-i.time_sort_us)} · {typeLabel(o.event_type,types)} · {displayId(o.event_id)}</button></li>)}</ul>}</div>)}</div></>:<div className="w-comparison-scroll"><table className="w-comparison"><thead><tr><th>比较字段</th>{displayed.map(i=><th key={i.event_id}><button onClick={e=>read(i.file_id,'file',e.currentTarget)}>{i.path}</button></th>)}</tr></thead><tbody>{['发布记录','正文可用性','创建 → 发布（最近一次）','发布 → 删除（首次）','全历史明确文件操作'].map((label,index)=><tr key={label}><th>{label}</th>{displayed.map(i=><td key={i.event_id}>{index===0?<><button onClick={e=>read(i.event_id,'event',e.currentTarget)}>{displayId(i.event_id)}</button>{time(i.time_sort_us)} · {actor(i.actor_id)}</>:index===1?<>{status(i)} · {i.content_note}</>:index===2?creationSummary(i):index===3?deletionSummary(i):i.operations.map(o=><button key={o.event_id} onClick={e=>read(o.event_id,'event',e.currentTarget)}>{typeLabel(o.event_type,types)} · {time(o.time_sort_us)}</button>)}</td>)}</tr>)}</tbody></table></div>}
    {activePoint&&<div className="w-event-inspector"><b>{activePoint.item.path} · {typeLabel(activePoint.op.event_type,types)}</b><p>{time(activePoint.op.time_sort_us)} · 相对发布 {relativeTime(activePoint.op.time_sort_us-activePoint.item.time_sort_us)}</p><button onClick={e=>read(activePoint.op.event_id,'event',e.currentTarget)}>阅读对齐记录 · {displayId(activePoint.op.event_id)}</button></div>}
    <div className="w-notice" data-testid="comparison-conclusion">{deletionConclusion(displayed)}{displayed.filter(i=>i.create_lag_us===null).map(i=><p key={i.event_id}>{i.path}：未见创建记录，不等于行为未发生。</p>)}<details><summary>结论依据</summary>{displayed.map(i=><p key={i.event_id}>{i.path}：<button onClick={e=>read(i.event_id,'event',e.currentTarget)}>发布记录</button>{i.operations.filter(o=>o.event_type==='delete_file'&&o.time_sort_us-i.time_sort_us===i.delete_lag_us).slice(0,1).map(o=><button key={o.event_id} onClick={e=>read(o.event_id,'event',e.currentTarget)}>首次删除记录</button>)}</p>)}</details></div>
    </>}
    <div className="mc2-pagination"><button disabled={offset===0} onClick={()=>{setOffset(v=>v-20);setPoint(null);setOutside(null);}}>上一组实例</button><span>换组后默认选择前三例</span><button disabled={offset+20>=data.total} onClick={()=>{setOffset(v=>v+20);setPoint(null);setOutside(null);}}>下一组实例</button></div></>}
    </PendingRegion>
  </div>;
}
