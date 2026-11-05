/** 事件类别：前端只负责颜色与固定标签。
 *  “某个事件类型属于哪一类”由服务端 domain/event_types.py 决定，接口返回 category id。
 *  颜色只由类别序号决定（--cat-1..8），主强调色不参与类别编码。 */

export interface CategoryDef {
  id: number;
  key: string;
  label: string;
}

export const CATEGORIES: CategoryDef[] = [
  { id: 1, key: "comm", label: "内部沟通" },
  { id: 2, key: "post", label: "公开发布" },
  { id: 3, key: "mail", label: "邮件" },
  { id: 4, key: "file", label: "文件操作" },
  { id: 5, key: "task", label: "任务流转" },
  { id: 6, key: "presence", label: "场所与协作" },
  { id: 7, key: "system", label: "系统与流程" },
  { id: 8, key: "other", label: "其他" },
];
