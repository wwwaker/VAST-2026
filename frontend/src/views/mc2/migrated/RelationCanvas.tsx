import { WorkspaceSelect } from "./WorkspaceSelect";
import { Search, ArrowUpRight } from "lucide-react";
import { barShade } from "../../shared/MetricBars";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Edge, RelationData } from "./workspaceApi";
import { relationName } from "./workspaceApi";
import { EntityLabel, EntityLegend, entityName } from "./EntityLabel";
import { number } from "./shared";
import { edgeVisual } from "./relationLayout";

export const edgeKey = (e: Edge) => JSON.stringify([e.source, e.target, e.relation, e.action]);
export function RelationOverview({ data, choose }: { data: RelationData; choose: (role: string) => void }) {
  return <div className="w-relation-overview"><p className="mc2-note">选择一种关系，查看具体对象。每项按不同事件计数，同一事件可以出现在多项中。</p><div className="w-relation-categories">{data.relation_counts.map(role => {
    const edges = data.edges.filter(e => e.relation === role.relation);
    const pairs = [...new Set(edges.map(e => `${entityName(e.source, data.nodes.find(n => n.id === e.source)?.label).split(" · ")[0]} → ${entityName(e.target, data.nodes.find(n => n.id === e.target)?.label).split(" · ")[0]}`))];
    return <button key={role.relation} style={{ "--relation-color": edgeVisual(edges[0]).color } as CSSProperties} onClick={() => choose(role.relation)}><span className="w-relation-category-title">{role.label}<b>{number(role.count)} 条<ArrowUpRight size={14} aria-hidden="true"/></b></span><span className="w-category-direction">{pairs.join("；")}</span></button>;
  })}</div></div>;
}

export type MatrixView = { sort: string; left: number; top: number; cell: number; search?:string; located?:string; active?:[number,number]; local?:string };
export function RelationMatrix({ data, selected, onEdge, onNode, cache, viewKey }: { data: RelationData; selected?: Edge; onEdge: (e: Edge) => void; onNode?:(id:string)=>void; cache: Map<string, MatrixView>; viewKey: string }) {
  const scroll=useRef<HTMLDivElement>(null),cells=useRef(new Map<string,HTMLButtonElement>()),searchBox=useRef<HTMLDivElement>(null);
  const saved=cache.get(viewKey);
  const [sort,setSort]=useState(saved?.sort??'name'),[cell,setCell]=useState(saved?.cell??26),[search,setSearch]=useState(saved?.search??''),[located,setLocated]=useState(saved?.located??''),[local,setLocal]=useState(saved?.local??'');
  const [active,setActive]=useState<[number,number]>(saved?.active??[0,0]),[pair,setPair]=useState<Edge[]>([]),[showCandidates,setShowCandidates]=useState(false),[fitNote,setFitNote]=useState('');
  const [previous,setPrevious]=useState(viewKey);
  if(previous!==viewKey){const v=cache.get(viewKey);setPrevious(viewKey);setSort(v?.sort??'name');setCell(v?.cell??26);setSearch(v?.search??'');setLocated(v?.located??'');setActive(v?.active??[0,0]);setLocal(v?.local??'');setPair([]);setShowCandidates(false);}
  useEffect(()=>{
    if(!showCandidates)return;
    const outside=(e:PointerEvent)=>{if(searchBox.current&&!e.composedPath().includes(searchBox.current))setShowCandidates(false);};
    window.addEventListener('pointerdown',outside);
    return()=>window.removeEventListener('pointerdown',outside);
  },[showCandidates]);
  const save=()=>{cache.set(viewKey,{sort,cell,search,located,active,local,left:scroll.current?.scrollLeft??0,top:scroll.current?.scrollTop??0});};
  useLayoutEffect(()=>{if(scroll.current){const v=cache.get(viewKey);scroll.current.scrollLeft=v?.left??0;scroll.current.scrollTop=v?.top??0;}},[viewKey,cache]);
  useEffect(save,[sort,cell,search,located,active,local,viewKey,cache]);
  const model=useMemo(()=>{
    const nodes=new Map(data.nodes.map(n=>[n.id,n])),ranks=new Map<string,number>(),sources=new Set<string>(),targets=new Set<string>(),grouped=new Map<string,{edges:Edge[];count:number}>();
    for(const e of data.edges){sources.add(e.source);targets.add(e.target);for(const id of new Set([e.source,e.target]))ranks.set(id,(ranks.get(id)??0)+e.count);const key=JSON.stringify([e.source,e.target]),v=grouped.get(key)??{edges:[],count:0};v.edges.push(e);v.count+=e.count;grouped.set(key,v);}
    const name=(id:string)=>entityName(id,nodes.get(id)?.label);
    const ids=[...new Set([...sources,...targets])].sort((a,b)=>(sort==='count'?(ranks.get(b)??0)-(ranks.get(a)??0):0)||name(a).localeCompare(name(b))||a.localeCompare(b));
    const shown=local?new Set(data.edges.filter(e=>e.source===local||e.target===local).flatMap(e=>[e.source,e.target])):null;
    return {nodes,name,ids,sources:ids.filter(id=>sources.has(id)&&(!shown||shown.has(id))),targets:ids.filter(id=>targets.has(id)&&(!shown||shown.has(id))),grouped,max:Math.max(1,...[...grouped.values()].map(v=>v.count)),fullRows:sources.size,fullCols:targets.size};
  },[data,sort,local]);
  const candidates=model.ids.filter(id=>search.trim()&&`${model.name(id)} ${id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const locate=(id?:string)=>{if(!id){if(candidates.length!==1){setShowCandidates(true);if(!candidates.length)setLocated('__not_found__');return;}id=candidates[0];}setLocated(id);setShowCandidates(false);const row=Math.max(0,model.sources.indexOf(id)),col=Math.max(0,model.targets.indexOf(id));setActive([row,col]);if(scroll.current){scroll.current.scrollLeft=Math.max(0,col*(cell+1)-cell);scroll.current.scrollTop=Math.max(0,row*(cell+1)-cell);}requestAnimationFrame(save);};
  const pick=(row:number,col:number)=>{setActive([row,col]);const v=model.grouped.get(JSON.stringify([model.sources[row],model.targets[col]]));if(!v){setPair([]);return;}if(v.edges.length===1){setPair([]);onEdge(v.edges[0]);}else setPair(v.edges);};
  const focus=(row:number,col:number)=>{const next:[number,number]=[Math.max(0,Math.min(model.sources.length-1,row)),Math.max(0,Math.min(model.targets.length-1,col))];setActive(next);cells.current.get(next.join(':'))?.focus({preventScroll:true});cells.current.get(next.join(':'))?.scrollIntoView({block:'nearest',inline:'nearest'});};
  const currentSource=model.sources[active[0]],currentTarget=model.targets[active[1]],currentValue=model.grouped.get(JSON.stringify([currentSource,currentTarget]));
  const axis=(id:string)=><button tabIndex={-1} title={id} onClick={()=>{setLocated(id);onNode?.(id);}}><EntityLabel id={id} label={model.nodes.get(id)?.label} kind={model.nodes.get(id)?.entity_type}/></button>;
  return <><div className="w-graph-tools w-matrix-tools"><span>完整 {model.fullRows} 行 × {model.fullCols} 列 · 连续滚动</span><label>排序<WorkspaceSelect aria-label="矩阵排序" value={sort} onChange={e=>{setSort(e.target.value);setActive([0,0]);if(scroll.current){scroll.current.scrollTop=0;scroll.current.scrollLeft=0;}}}><option value="name">名称</option><option value="count">关系量</option></WorkspaceSelect></label><label>格子<input aria-label="矩阵格子尺寸" type="range" min={14} max={38} value={cell} onChange={e=>setCell(Number(e.target.value))}/></label><button onClick={()=>{const fit=Math.floor(((scroll.current?.clientWidth||800)-172)/Math.max(1,model.targets.length))-1;setCell(Math.max(14,Math.min(38,fit)));setFitNote(fit<14?'已最紧凑，可横向滚动':'已按可用宽度调整');}}>适合宽度</button><span className="w-sr-only" role="status">{fitNote}</span></div>
    <div className="w-matrix-search" ref={searchBox} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();searchBox.current?.querySelector('input')?.focus({preventScroll:true});setShowCandidates(false);}}}><form className="w-matrix-locate" onSubmit={e=>{e.preventDefault();locate();}}><input aria-label="定位矩阵对象" placeholder="输入姓名或对象名称，查看候选" value={search} onFocus={()=>{if(search.trim())setShowCandidates(true);}} onChange={e=>{setSearch(e.target.value);setShowCandidates(true);}}/><button type="submit"><Search size={13}/>定位</button><button type="button" disabled={!candidates.length} onClick={()=>{const next=(candidates.indexOf(located)+1)%candidates.length;locate(candidates[next]);}}>下一个匹配对象</button><button type="button" disabled={!located||located==='__not_found__'} onClick={()=>setLocal(local?'':located)}>{local?'恢复完整矩阵':'只显示相关行/列'}</button><span role="status">{located==='__not_found__'?'未找到此对象':located?`已定位 ${model.name(located)}`:'行：来源 · 列：目标；表头保持可见'}</span></form>
    {showCandidates&&<div className="w-matrix-candidates w-matrix-search-results" role="group" aria-label="矩阵定位候选">{candidates.map(id=><button key={id} onClick={()=>locate(id)}>{model.name(id)} · {model.nodes.get(id)?.entity_type} · {id}</button>)}{search&&!candidates.length&&<span>没有匹配对象</span>}</div>}
    </div>
    <p className="w-matrix-summary" role="status" title={`${currentSource?model.name(currentSource):''} → ${currentTarget?model.name(currentTarget):''} · ${currentValue?.count??0} 个记录组合；方向键移动，Enter/空格选择动作，Home/End定位行首尾，Tab离开`}>{local?`局部 ${model.sources.length}/${model.fullRows} 行 × ${model.targets.length}/${model.fullCols} 列 · `:''}{currentSource&&currentTarget?`${model.name(currentSource)} → ${model.name(currentTarget)} · ${currentValue?.count??0} 个记录组合`:'当前没有可显示的端点'} · 方向键移动，Enter/空格选择动作，Home/End定位行首尾，Tab离开</p>
    <div className="w-matrix-shell">{selected&&(!model.sources.includes(selected.source)||!model.targets.includes(selected.target))&&<div className="w-canvas-notice">选中关系在当前显示外。<button onClick={()=>{setLocal('');setLocated(selected.source);}}>恢复完整矩阵并定位</button></div>}<div className="w-matrix-scroll" ref={scroll} onScroll={save} tabIndex={0} aria-label="有向关系矩阵" onKeyDown={e=>{if(e.key==='Escape'){setPair([]);return;}if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();focus(e.key==='ArrowUp'?active[0]-1:e.key==='ArrowDown'?active[0]+1:active[0],e.key==='Home'?0:e.key==='End'?model.targets.length-1:e.key==='ArrowLeft'?active[1]-1:e.key==='ArrowRight'?active[1]+1:active[1]);}else if((e.key==='Enter'||e.key===' ')&&e.target===scroll.current){e.preventDefault();pick(...active);}}} style={{'--matrix-cell':`${cell}px`} as CSSProperties}>
    <table className="w-relation-matrix" role="grid" aria-rowcount={model.sources.length+1} aria-colcount={model.targets.length+1}><thead><tr><th>来源 ↓ / 目标 →</th>{model.targets.map((id,col)=><th key={id} className={`${located===id?'is-located':''} ${col===active[1]?'is-crosshair':''}`} title={model.name(id)}>{axis(id)}</th>)}</tr></thead><tbody>{model.sources.map((id,row)=><tr key={id}><th className={`${located===id?'is-located':''} ${row===active[0]?'is-crosshair':''}`} title={model.name(id)}>{axis(id)}</th>{model.targets.map((target,col)=>{const v=model.grouped.get(JSON.stringify([id,target])),count=v?.count??0,ratio=Math.log1p(count)/Math.log1p(model.max);return <td key={target} aria-rowindex={row+2} aria-colindex={col+2} className={`${!v?'w-matrix-zero':''} ${row===active[0]||col===active[1]?'is-crosshair':''}`}><button tabIndex={-1} ref={el=>{const k=`${row}:${col}`;if(el)cells.current.set(k,el);else cells.current.delete(k);}} className={selected?.source===id&&selected.target===target?'selected':''} title={`${model.name(id)} → ${model.name(target)} · ${count} 个记录组合${(v?.edges.length??0)>1?'（多种动作，点击区分）':''}`} aria-label={`${model.name(id)} → ${model.name(target)} ${count}`} style={{background:count?barShade('#638a98',ratio):undefined,color:ratio>.65?'white':'#294c70'}} onFocus={()=>setActive([row,col])} onMouseEnter={()=>setActive([row,col])} onClick={()=>pick(row,col)}>{cell>=24&&count?count:''}</button></td>;})}</tr>)}</tbody></table></div>
    {pair.length>1&&<div className="w-pair-types" role="dialog" aria-label="选择该端点对的动作" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setPair([]);scroll.current?.focus();}}}><b>该组合包含多种动作，请选择：</b>{pair.map(e=><button key={edgeKey(e)} onClick={()=>{onEdge(e);setPair([]);}}>{relationName[e.relation]} · {e.action} · {number(e.count)} 条不同事件</button>)}<button onClick={()=>setPair([])}>取消动作选择</button></div>}</div>
    <EntityLegend/><p className="mc2-note">格子显示记录组合数；同一事件可能支持不同角色，不能跨动作直接当作去重事件数。空白为0；缺失来源单列。</p>
  </>;
}
