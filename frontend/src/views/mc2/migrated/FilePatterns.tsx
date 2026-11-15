import type { CSSProperties } from "react";
import { WorkspaceSelect } from "./WorkspaceSelect";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, FileText } from "lucide-react";
import type { TypeInfo } from "../../../data/api";
import { EMPTY_FILTERS } from "../../../data/filterContext";
import { fileActionColor as actionColor } from "./mc2Visuals";
import { query } from "./workspaceApi";
import { number, time, typeLabel, PendingRegion, RequestStatus, useRequest, type ReaderTarget } from "./shared";

type Pattern = { id:string;segments:{action:string;count:number}[];file_count:number;action_count:number };
type Patterns = { items:Pattern[];total:number;file_total:number;scale_max:number;data_version:string;semantic_version:number };
type Members = {items:{file_id:string;path:string;event_count:number;first_us:number;last_us:number;content_status:string;content_note:string}[];total:number};
const sequenceName=(p:Pattern,types:TypeInfo[])=>p.segments.map(s=>`${typeLabel(s.action,types)}${s.count>1?` ×${s.count}`:''}`).join(' → ');
function Sequence({pattern,types,compact=false}:{pattern:Pattern;types:TypeInfo[];compact?:boolean}){
  const segments=pattern.segments;
  const visible=compact&&segments.length>5?[...segments.slice(0,3),null,segments.at(-1)!]:segments;
  return <span className={`w-fingerprint-sequence ${compact?'is-compact':''}`} aria-label={sequenceName(pattern,types)}>
    {visible.map((s,i)=><span className="w-fingerprint-step" key={i}>{i>0&&<ArrowRight size={12} className="w-fingerprint-arrow"/>}{s?<span className="w-step-body" title={`${i+1}. ${typeLabel(s.action,types)} · 连续 ${s.count} 次`} style={{'--step-color':actionColor(s.action)} as CSSProperties}><span className="w-step-node">{s.count>1?s.count:<FileText size={13}/>}</span><span>{typeLabel(s.action,types)}</span></span>:<span className="w-sequence-more" title={`${segments.length-4} 个中间动作段，选择后查看完整顺序`}>···</span>}</span>)}
  </span>;
}
export function FilePatterns({types,choose,open}:{types:TypeInfo[];choose:(id:string,full:boolean)=>void;open:(t:ReaderTarget,e:HTMLElement)=>void}) {
  const [offset,setOffset]=useState(0),[sort,setSort]=useState('files'),[pattern,setPattern]=useState<Pattern|null>(null);
  const host=useRef<HTMLDivElement>(null),detail=useRef<HTMLElement>(null),listScroll=useRef(0),trigger=useRef<HTMLButtonElement|null>(null);
  const [pane,setPane]=useState('list'),[narrow,setNarrow]=useState(()=>window.matchMedia('(max-width:999px)').matches);
  useEffect(()=>{
    const mq=window.matchMedia('(max-width:999px)');
    const change=()=>{
      const root=host.current?.getRootNode() as ShadowRoot|undefined,active=root?.activeElement as HTMLElement|null;
      if(mq.matches&&pattern)setPane(active?.closest('.w-pattern-browser')?'list':'detail');
      setNarrow(mq.matches);
      requestAnimationFrame(()=>{
        if(active&&(!active.isConnected||!active.getClientRects().length)){
          const target=mq.matches?host.current?.querySelector<HTMLButtonElement>('[data-pattern-back]'):trigger.current;
          target?.focus({preventScroll:true});
        }
      });
    };
    mq.addEventListener('change',change);return()=>mq.removeEventListener('change',change);
  },[pattern]);
  const changePane=(next:string)=>{
    const body=host.current?.closest('.w-research-body');
    if(next==='detail'){listScroll.current=body?.scrollTop??0;setPane(next);requestAnimationFrame(()=>{if(body)body.scrollTop=0;host.current?.querySelector<HTMLButtonElement>('[data-pattern-back]')?.focus({preventScroll:true});});}
    else {setPane(next);requestAnimationFrame(()=>{trigger.current?.focus({preventScroll:true});if(body)body.scrollTop=listScroll.current;});}
  };
  const resource=useRequest(`patterns:${offset}:${sort}`,s=>query<Patterns>('file-patterns',{offset,sort},s));
  return <div ref={host} className={`w-fingerprints ${narrow?`is-narrow pane-${pane}`:''}`}>
    <div className="w-pattern-toolbar"><div className="w-fingerprint-stats"><span><b>{resource.data?number(resource.data.file_total):'…'}</b> 个文件</span><span><b>{resource.data?.total??'…'}</b> 种精确模式</span><small>全历史 · 相同动作顺序与重复次数</small></div><label>排序<WorkspaceSelect aria-label="文件指纹排序" value={sort} onChange={e=>{setSort(e.target.value);setOffset(0);setPattern(null);setPane('list');}}><option value="files">文件数最多</option><option value="actions">操作步骤最多</option></WorkspaceSelect></label></div>
    <div className="w-fingerprint-legend">{['create_file','read_file','delete_file','queue_subordinate_task'].map(a=><span key={a}><i style={{background:actionColor(a)}}/>{typeLabel(a,types)}</span>)}<span>圆内数字＝连续次数 · 箭头＝先后顺序，非耗时</span></div>
    {narrow&&<div className="w-tabs w-pattern-tabs"><button aria-pressed={pane==='list'} onClick={()=>changePane('list')}>模式列表</button><button disabled={!pattern} aria-pressed={pane==='detail'} onClick={()=>changePane('detail')}>模式详情</button></div>}
    <RequestStatus {...resource}/><PendingRegion {...resource} minimum={340}>
      {resource.data&&<div className="w-fingerprint-workbench">
        <section className="w-pattern-browser" hidden={narrow&&pane!=='list'} aria-label="文件指纹分布"><div className="w-pattern-columns"><span>模式 / 操作顺序</span><span>文件数 · 对数条长</span></div>
          <div className="w-pattern-list">{resource.data.items.map((p,index)=><button key={p.id} className="w-pattern-row" aria-pressed={pattern?.id===p.id} aria-label={`${sequenceName(p,types)} · ${p.file_count} 文件 · ${p.action_count} 动作`} onClick={e=>{setPattern(p);trigger.current=e.currentTarget;if(detail.current)detail.current.scrollTop=0;if(narrow)changePane('detail');}}>
            <span className="w-pattern-rank">{offset+index+1}</span><span className="w-pattern-sequence"><Sequence pattern={p} types={types} compact/><small>{p.action_count} 次动作 · {p.segments.length} 个连续动作段</small></span>
            <span className="w-pattern-frequency"><b>{number(p.file_count)}</b><span className="w-pattern-bar"><i style={{width:`${Math.log1p(p.file_count)/Math.log1p(resource.data!.scale_max)*100}%`}}/></span><small>全部文件的 {(p.file_count/resource.data!.file_total*100).toLocaleString('zh-CN',{maximumFractionDigits:2})}%</small></span>
          </button>)}</div>
          <div className="mc2-pagination"><button disabled={offset===0} onClick={()=>{setOffset(v=>v-20);setPattern(null);setPane('list');}}>上一页模式</button><span>{offset+1}–{Math.min(offset+20,resource.data.total)} / {resource.data.total}</span><button disabled={offset+20>=resource.data.total} onClick={()=>{setOffset(v=>v+20);setPattern(null);setPane('list');}}>下一页模式</button></div>
        </section>
        <section ref={detail} className="w-pattern-detail" hidden={narrow&&pane!=='detail'} aria-label="选中指纹详情">{narrow&&<button data-pattern-back onClick={()=>changePane('list')}>返回模式列表</button>}{pattern?<><div className="w-pattern-detail-head"><h3>完整动作指纹</h3><span>{number(pattern.file_count)} 个文件 · {pattern.action_count} 次动作</span></div><div className="w-sequence-scroll"><Sequence pattern={pattern} types={types}/></div><PatternMembers key={`${pattern.id}:${resource.data.data_version}`} pattern={pattern} dataVersion={resource.data.data_version} choose={choose} open={open}/></>:<div className="w-pattern-placeholder"><FileText size={38}/><h3>选择左侧模式</h3><p>查看完整动作顺序和精确文件成员，逐条阅读真实记录。</p><small>条长使用对数刻度，让少量文件的模式也可辨认；稀少不等于异常。</small></div>}</section>
      </div>}
    </PendingRegion>
    <p className="mc2-note w-pattern-footnote">仅使用明确文件关联；按文件与事件去重，时间相同按记录ID排序。分组保留每次动作，连续相同动作只在图中压缩显示。</p>
  </div>;
}
function PatternMembers({pattern,choose,open,dataVersion}:{dataVersion?:string;pattern:Pattern;choose:(id:string,full:boolean)=>void;open:(t:ReaderTarget,e:HTMLElement)=>void}) {
  const [offset,setOffset]=useState(0),[q,setQ]=useState('');
  const args={pattern_id:pattern.id,offset,q,data_version:dataVersion};
  const resource=useRequest(JSON.stringify(args),s=>query<Members>('file-pattern-members',args,s));
  return <section className="w-pattern-members"><div className="w-pattern-member-tools"><h3>文件成员 <small>{resource.loading?'…':resource.data?.total??'…'} / {number(pattern.file_count)}</small></h3><input type="search" aria-label="搜索模式成员" placeholder="搜索精确路径" value={q} onChange={e=>{setQ(e.target.value);setOffset(0);}}/></div><RequestStatus {...resource}/><PendingRegion {...resource} minimum={160}>
    <div className="w-pattern-member-list">{resource.data?.items.map(i=><article key={i.file_id}><b title={i.path}><FileText size={14}/>{i.path}</b><p>{i.event_count} 条记录 · {time(i.first_us).slice(0,19)} → {time(i.last_us).slice(0,19)} UTC</p><span className={`w-content-tag ${i.content_status==='available'?'available':''}`}>{i.content_status==='available'?'可定位正文':i.content_status==='metadata_only'?'只有元数据':'尚无法解析'}</span><details className="w-content-reason"><summary>正文状态说明</summary><p>{i.content_note}</p></details><div className="w-head-actions"><button onClick={e=>open({kind:'file',id:i.file_id,reading:{filters:{...EMPTY_FILTERS},label:'全历史精确模式 · 文件全历史',independent:true}},e.currentTarget)}>阅读真实操作序列</button><button title="关闭浮窗，在主图查看此文件的完整历史" onClick={()=>choose(i.file_id,true)}>全历史文件调查</button><button title="关闭浮窗，保留原筛选条件查看此文件" onClick={()=>choose(i.file_id,false)}>在当前筛选中查看此文件</button></div></article>)}{resource.data?.total===0&&<p className="mc2-empty">此模式没有匹配路径的文件。</p>}</div>
  </PendingRegion><div className="mc2-pagination"><button disabled={offset===0} onClick={()=>setOffset(v=>v-12)}>上一页成员</button><span>第 {offset/12+1} 页</span><button disabled={!resource.data||offset+12>=resource.data.total} onClick={()=>setOffset(v=>v+12)}>下一页成员</button></div></section>;
}
