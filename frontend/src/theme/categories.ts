/** 事件类别字典：把数据集内的事件类型收敛到固定 8 类。
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

const TYPE_MAP: Record<string, string> = {
  // MC2
  broadcast: "comm",
  one_on_one_chat: "comm",
  side_huddle: "comm",
  agent_message: "comm",
  give_advice: "comm",
  ask_agent: "comm",
  saidit_post: "post",
  post_saidit: "post",
  flex_post: "post",
  post_flex: "post",
  saidit_post_check: "post",
  check_email: "mail",
  access_email: "mail",
  send_email: "mail",
  sent: "mail",
  received: "mail",
  read_file: "file",
  create_file: "file",
  delete_file: "file",
  access_files: "file",
  list_files: "file",
  assign_agent_task: "task",
  queue_subordinate_task: "task",
  task_created: "task",
  task_handoff: "task",
  workflow_route: "task",
  check_in: "presence",
  check_access: "presence",
  enter_room: "presence",
  propose_meeting: "presence",
  suggest_contacts: "presence",
  run_started: "system",
  run_finished: "system",
  agent_call_started: "system",
  agent_call_finished: "system",
  publish_attempt: "system",
  publish_result: "system",
  submit_review: "system",
  review_decision: "system",
  version_updated: "system",
  // MC1
  action: "comm",
  public_post: "post",
};

export function categoryOf(eventType: string): CategoryDef {
  const key = TYPE_MAP[eventType] ?? "other";
  return CATEGORIES.find((c) => c.key === key) ?? CATEGORIES[7];
}

/** 平台回执类事件。统计时必须与动作事件分开，否则发帖量会翻倍（见适配规则 C8）。 */
const RECORD_TYPES = new Set([
  "saidit_post",
  "flex_post",
  "sent",
  "received",
  "publish_result",
  "agent_call_finished",
]);

export function isRecordEvent(eventType: string): boolean {
  return RECORD_TYPES.has(eventType);
}
