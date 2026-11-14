import { WorkspaceSelect } from "./WorkspaceSelect";
import { useState } from "react";
import { EMPTY_FILTERS } from "../../../data/filterContext";
import type { TypeInfo } from "../../../data/api";
import { query, type Comparison } from "./workspaceApi";
import { fileActionColor } from "./mc2Visuals";
import { ProcessSymbol } from "./LocalProcess";
import { PendingRegion, RequestStatus, actor, displayId, time, typeLabel, useRequest, type ReaderTarget } from "./shared";

type Item = Comparison['items'][number];
type Operation = Item['operations'][number];
export const relativeTime = (us: number) => `${us<0?'−':'+'}${Math.abs(us)/86400e6>=1?`${Math.floor(Math.abs(us)/86400e6)}天 `:''}${(Math.abs(us)%86400e6/1e6).toLocaleString('zh-CN',{maximumFractionDigits:6})}秒`;
const status = (i:Item) => i.content_status==='available'?'可定位正文':i.content_status==='metadata_only'?'只有元数据':'尚无法解析';
export function HistoricalComparison({ open, types, anchorTime }: { open:(t:ReaderTarget,e:HTMLElement)=>void;types:TypeInfo[];anchorTime?:number }) {
  const [offset,setOffset]=useState(0),[selected,setSelected]=useState<string[]>([]),[cutoff,setCutoff]=useState(anchorTime!==undefined),[view,setView]=useState('timeline'),[full,setFull]=useState(false);
  const [point,setPoint]=useState<{item:Item;op:Operation}|null>(null),[outside,setOutside]=useState<string|null>(null);
  const resource=useRequest(`compare:${offset}:${cutoff}:${anchorTime}`,s=>query<Comparison>('comparison',{offset,before_us:cutoff&&anchorTime!==undefined?anchorTime+1:undefined},s));
  const displayed=resource.data?.items.filter(i=>selected.length?selected.includes(i.event_id):true).slice(0,3)??[];
  const read=(id:string,kind:'event'|'file',el:HTMLElement)=>open({kind,id,reading:{filters:{...EMPTY_FILTERS},label:'发布实例比较 · 精确文件全历史',independent:true}},el);
  const deltas=displayed.flatMap(i=>i.operations.map(o=>o.time_sort_us-i.time_sort_us));
  const min=full?Math.min(-60e6,...deltas):-60e6,max=full?Math.max(10e6,...deltas):10e6;
  const x=(t:number)=>230+(t-min)/Math.max(1,max-min)*740;
  let rowTop=90;
  const rows=displayed.map(item=>{
    const ends:number[]=[], marks=item.operations.filter(o=>o.time_sort_us-item.time_sort_us>=min&&o.time_sort_us-item.time_sort_us<=max).map(op=>{
      const px=x(op.time_sort_us-item.time_sort_us);let track=ends.findIndex(v=>v<px-20);if(track<0)track=ends.length;ends[track]=px+20;
      return {op,px,track};
    });
    const y=rowTop;rowTop+=Math.max(125,ends.length*24+65);return {item,y,marks};
  });
  const height=rowTop+20;
  return <>
    <p className="w-notice">用于核对不同发布的操作节奏：发布时刻对齐为0秒，比较创建、读取和删除发生在发布前后多久。仅比较有明确来源引用的实例；文件操作取全历史，相同文件可能出现在多行。</p>
    <div className="w-process-tools"><label>候选范围<WorkspaceSelect aria-label="比较候选范围" value={cutoff?'anchor':'all'} onChange={e=>{setCutoff(e.target.value==='anchor');setOffset(0);setSelected([]);setPoint(null);}}><option value="all">全库明确来源发布</option><option value="anchor" disabled={anchorTime===undefined}>截至进入时锚点（含）</option></WorkspaceSelect></label><div className="w-tabs"><button aria-pressed={view==='timeline'} onClick={()=>setView('timeline')}>时间对齐</button><button aria-pressed={view==='table'} onClick={()=>setView('table')}>字段表</button></div><button aria-pressed={full} onClick={()=>setFull(v=>!v)}>{full?'返回发布前60秒/后10秒':'完整真实时间'}</button></div>
    <div className="w-fingerprint-legend">{['create_file','read_file','delete_file','saidit_post'].map(action=><span key={action}><svg width={18} height={18}><ProcessSymbol x={9} y={9} type={action} color={fileActionColor(action)}/></svg>{typeLabel(action,types)}</span>)}<span>橙色虚线＝发布时刻 · 点击标记核对记录</span></div>
    <RequestStatus {...resource} maskWhileLoading loadingLabel="正在加载发布实例比较…"/><PendingRegion {...resource} minimum={250} maskWhileLoading>
    {resource.data&&<><p>{resource.data.total} 个有明确来源的发布实例 · 同时最多3例 · {cutoff&&anchorTime!==undefined?`截至 ${time(anchorTime)}`:'全历史'}</p><div className="w-compare-picks">{resource.data.items.map(i=><label key={i.event_id} className="check"><input type="checkbox" checked={selected.includes(i.event_id)} disabled={!selected.includes(i.event_id)&&selected.length===3} onChange={()=>{setSelected(a=>a.includes(i.event_id)?a.filter(id=>id!==i.event_id):[...a,i.event_id]);setPoint(null);}}/>{i.path}</label>)}</div>
    {view==='timeline'?<><p className="mc2-note">发布为0秒；三行共用真实比例。{full?'共同完整跨度':'共同视窗：−60秒至＋10秒'}；创建取发布前最近一次记录，删除取发布后首次记录。同秒事件纵向错开，时间坐标不移动。</p><div className="w-comparison-scroll"><svg width="100%" style={{minWidth:1020}} height={height} viewBox={`0 0 1020 ${height}`} aria-label="发布实例真实时间对齐" role="group">
      {[0,.25,.5,.75,1].map(f=><g key={f}><line x1={230+f*740} x2={230+f*740} y1={35} y2={height-10} stroke="#e3eaf0"/><text x={230+f*740} y={22} fontSize={11} textAnchor="middle">{relativeTime(min+f*(max-min))}</text></g>)}<line x1={x(0)} x2={x(0)} y1={30} y2={height-10} stroke="#d58c27" strokeDasharray="4 3"/>
      {rows.map(({item:i,y,marks})=>{return <g key={i.event_id}><text x={10} y={y-15} fontSize={12}>{i.path.slice(0,27)}<title>{i.path}</title></text><text x={10} y={y+3} fontSize={11} fill="#63768a">{status(i)}</text>{i.create_lag_us===null&&<text x={10} y={y+22} fontSize={10} fill="#a16d42">未见创建记录</text>}<line x1={230} x2={970} y1={y} y2={y} stroke="#b6c7d3"/>{marks.map(({op:o,px,track})=>{const py=y+track*24;return <g key={o.event_id} role="button" tabIndex={0} aria-label={`${i.path} ${typeLabel(o.event_type,types)} ${relativeTime(o.time_sort_us-i.time_sort_us)}`} onClick={()=>setPoint({item:i,op:o})} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setPoint({item:i,op:o});}}}><title>{time(o.time_sort_us)} · {relativeTime(o.time_sort_us-i.time_sort_us)} · {o.event_type} · {o.event_id}</title><circle cx={px} cy={py} r={13} fill="transparent"/><ProcessSymbol x={px} y={py} type={o.event_type} color={point?.op.event_id===o.event_id?'#3188b5':fileActionColor(o.event_type)}/></g>;})}</g>;})}
    </svg></div>{displayed.map(i=><div className="w-compare-row-tools" key={i.event_id}><button className="w-text-link" onClick={e=>read(i.file_id,'file',e.currentTarget)}>{i.path} · 阅读全历史</button>{!full&&<><button onClick={()=>setOutside(outside===i.event_id?null:i.event_id)}>更早 {i.operations.filter(o=>o.time_sort_us-i.time_sort_us<min).length} 条 / 更晚 {i.operations.filter(o=>o.time_sort_us-i.time_sort_us>max).length} 条</button>{outside===i.event_id&&<ul>{i.operations.filter(o=>o.time_sort_us-i.time_sort_us<min||o.time_sort_us-i.time_sort_us>max).map(o=><li key={o.event_id}><button onClick={()=>setPoint({item:i,op:o})}>{relativeTime(o.time_sort_us-i.time_sort_us)} · {typeLabel(o.event_type,types)} · {displayId(o.event_id)}</button></li>)}</ul>}</>}</div>)}</>:<div className="w-comparison-scroll"><table className="w-comparison"><thead><tr><th>比较字段</th>{displayed.map(i=><th key={i.event_id}><button onClick={e=>read(i.file_id,'file',e.currentTarget)}>{i.path}</button></th>)}</tr></thead><tbody>{['发布记录','正文可用性','创建 → 发布（最近一次）','发布 → 删除（首次）','全历史明确文件操作'].map((label,index)=><tr key={label}><th>{label}</th>{displayed.map(i=><td key={i.event_id}>{index===0?<><button onClick={e=>read(i.event_id,'event',e.currentTarget)}>{displayId(i.event_id)}</button>{time(i.time_sort_us)} · {actor(i.actor_id)}</>:index===1?<>{status(i)} · {i.content_note}</>:index===2?i.create_lag_us===null?'未见明确创建记录':relativeTime(i.create_lag_us):index===3?i.delete_lag_us===null?'未见明确删除记录':relativeTime(i.delete_lag_us):i.operations.map(o=><button key={o.event_id} onClick={e=>read(o.event_id,'event',e.currentTarget)}>{typeLabel(o.event_type,types)} · {time(o.time_sort_us)}</button>)}</td>)}</tr>)}</tbody></table></div>}
    {point&&<div className="w-event-inspector"><b>{point.item.path} · {typeLabel(point.op.event_type,types)}</b><p>{time(point.op.time_sort_us)} · 相对发布 {relativeTime(point.op.time_sort_us-point.item.time_sort_us)}</p><button onClick={e=>read(point.op.event_id,'event',e.currentTarget)}>阅读对齐记录 · {displayId(point.op.event_id)}</button></div>}
    <div className="w-notice">{displayed.length>0&&displayed.every(i=>i.delete_lag_us===2e6)?`${displayed.length}例均记录发布后2秒首次删除。`:'所选实例的发布后首次删除间隔并非全部为2秒。'}{displayed.filter(i=>i.create_lag_us===null).map(i=><p key={i.event_id}>{i.path}：未见创建记录，不等于行为未发生。</p>)}{displayed.map(i=><p key={i.event_id}>依据 {i.path}：<button onClick={e=>read(i.event_id,'event',e.currentTarget)}>发布记录</button>{i.operations.filter(o=>o.event_type==='delete_file'&&o.time_sort_us-i.time_sort_us===i.delete_lag_us).slice(0,1).map(o=><button key={o.event_id} onClick={e=>read(o.event_id,'event',e.currentTarget)}>首次删除记录</button>)}</p>)}</div>
    <p className="mc2-note">{resource.data.note}</p><div className="mc2-pagination"><button disabled={offset===0} onClick={()=>{setOffset(v=>v-20);setSelected([]);setPoint(null);}}>上一组实例</button><span>翻组将清空本组选中实例</span><button disabled={offset+20>=resource.data.total} onClick={()=>{setOffset(v=>v+20);setSelected([]);setPoint(null);}}>下一组实例</button></div></>}
    </PendingRegion>
  </>;
}
