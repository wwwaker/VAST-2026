import { useState } from "react";
import { ArrowRight } from "lucide-react";
import type { EventDetail } from "../../../data/api";
import type { ReaderTarget } from "./shared";
import { useRequest } from "./RefreshRegion";
import { query } from "./workspaceApi";

export function FileAvailability({id}:{id:string}) {
  const resource=useRequest(`file-info:${id}`,s=>query<{content_status:string;reason:string;events_truncated:boolean}>('file-info',{file_id:id},s));
  return <small role="status">{resource.loading?'正在核对正文状态…':resource.error?'正文状态暂不可用':resource.data?.content_status==='available'?'可定位正文':resource.data?.events_truncated?'已检查记录未见正文（检查有上限）':resource.data?.content_status==='metadata_only'?'仅元数据，未提供正文':'正文来源尚无法解析'}</small>;
}
/** The three recorded objects only; no filename candidates or causal edges. */
export function CompactSource({event,open}:{event:EventDetail;open:(t:ReaderTarget)=>void}) {
  const [fields,setFields]=useState(false);
  const links=event.relations.filter(r=>r.relation==='post_content_source'&&r.target_kind==='entity');
  if(!event.event_type.includes('post'))return null;
  return <section className="mc2-reading-block"><h3>明确来源依据</h3>{links.length?<><div className="w-compact-source"><button onClick={()=>open({kind:'event',id:event.event_id})}>原始发布记录<br/>{event.event_id}</button><span><ArrowRight size={18}/><small>content_source 明确引用</small></span><div>{links.map(r=><button key={r.dst_id} onClick={()=>open({kind:'file',id:r.dst_id})}>{r.dst_id.replace('MC2:file_path:','')}<FileAvailability id={r.dst_id}/></button>)}</div><span><ArrowRight size={18}/><small>由原始字段解析</small></span><button aria-expanded={fields} onClick={()=>setFields(v=>!v)}>原始字段与定位</button></div>{fields&&<dl className="mc2-fields"><div><dt>字段 content_source</dt><dd>{String(event.details?.content_source??'未记录')}</dd></div><div><dt>来源文件</dt><dd>{event.source_file??'未记录'}</dd></div><div><dt>源序号 / JSON定位</dt><dd>{event.source_ordinal??'未记录'} / {event.source_json_pointer??'未记录'}</dd></div><div><dt>解析依据</dt><dd>{links.map(r=>r.derivation).join('；')}</dd></div></dl>}</>:<p className="mc2-note">此条未记录明确来源；不按文件名前缀猜测文件。</p>}</section>;
}
