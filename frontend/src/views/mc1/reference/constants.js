
export const API = '/api/mc1-reference';

export const TEXT_SOURCE_LABELS = {
  content: '消息内容',
  reacting: '内心想法：即时反应',
  rationalizing: '内心想法：自我说服',
  deliberating: '内心想法：权衡斟酌',
};

export const EXTERNAL_CHANNELS = ['personal_post', 'official_post', 'anonymous_post'];
export const visibilityGroupOf = (ch) => (EXTERNAL_CHANNELS.includes(ch) ? 'external' : 'internal');

export const MERGER_KEYWORDS = ['merger', 'civicloom', 'elenamarquez', 'harborcrest', 'embargo'];

// ---- 后端返回的英文枚举 → 中文展示名 ----
export const AGENT_LABELS = {
  legal_agent: '法务 Agent',
  quality_agent: '平台信任 Agent',
  social_media_agent: '社媒经理 Agent',
  judge_agent: '合规监察 Agent',
  pr_agent: '公关 Agent',
  pr_intern_agent: '公关实习生 Agent',
  intern_agent: '实习生 Agent',
};

export const CHANNEL_LABELS = {
  comms_huddle: '内部通讯频道',
  one_on_one_chat: '一对一私聊',
  side_huddle: '私下小群',
  personal_post: '个人动态',
  official_post: '官方动态',
  anonymous_post: '匿名动态',
  mention: '点名提及',
};

export const MESSAGE_TYPE_LABELS = {
  broadcast: '广播',
  action: '行动',
  public_post: '公开发布',
  one_on_one_chat: '一对一私聊',
  side_huddle: '私下小群',
  all: '全部',
};

export const VISIBILITY_LABELS = {
  external: '对外',
  internal: '对内',
};

export const SENTIMENT_LABELS = {
  positive: '正面',
  recovering: '回升',
  optimistic: '乐观',
  neutral: '中性',
  cautious: '谨慎',
  low: '低迷',
  negative: '负面',
  critical: '危急',
};

export const ROLE_LABELS = {
  legal: '法务',
  platform_trust: '平台信任',
  social_media: '社媒经理',
  judge: '合规监察',
  pr: '公关',
  pr_intern: '公关实习生',
  intern: '实习生',
};

export const agentLabelOf = (id, fallback) => AGENT_LABELS[id] || fallback || id || '';
export const roleLabelOf = (r) => ROLE_LABELS[r] || r || '';
export const channelLabelOf = (ch) => CHANNEL_LABELS[ch] || ch || '';
export const messageTypeLabelOf = (mt) => MESSAGE_TYPE_LABELS[mt] || mt || '';
export const visibilityLabelOf = (v) => VISIBILITY_LABELS[v] || v || '';
export const sentimentLabelOf = (l) => SENTIMENT_LABELS[l] || l || '';

export const CELL = {
  daily: { w: 46, h: 26 },
  hourly: { w: 52, h: 26 },
};
export const LABEL_COL = 150;

// MC1 情景中的关键时间锚点（事件标记）
// 在时间轴 / 折线图 / 热力图上以竖线标记，避免评委到处寻找“事件发生在哪”。
// 时间取自 MC1 brief：禁运原定 2046 年 6 月 5 日 18:00 解除，泄露约在 17:00 出现。
export const EVENT_MARKERS = [
  { id: 'leak',    time: '2046-06-05T17:00:00', short: '泄露', label: '泄露：禁运信息出现在 FleX（约 17:00）', color: '#e24b4a' },
  { id: 'embargo', time: '2046-06-05T18:00:00', short: '解禁', label: '禁运解除（6 月 5 日 18:00）',              color: '#f59e0b' },
];

export const SEQ_KINDS = {
  decision: { color: '#2dd4bf', shape: 'triangle', label: '决策' },

  external: { color: '#60a5fa', shape: 'cross',    label: '外部压力' },
  internal: { color: '#e24b4a', shape: 'cross',    label: '内部泄露' },
  agent_silent: { color: '#94a3b8', shape: 'circle', label: 'Agent 失声' },
  result:   { color: '#e879f9', shape: 'circle',   label: '结果' },
};

export const SEQ_EVENTS = [
  {
    order: 1, id: 'ajay_brief', time: '2046-05-25T09:00:00',
    title: 'Ajay 合并简报',
    kind: 'decision',
    detail: 'CEO Ajay 私下向高管团队通报 CivicLoom 合并案（注资 + 治理层面的品牌重塑）。由此形成禁运：一小部分人必须严格保密的重要非公开信息。',
    related: ['20460525_06_002', '20460525_06_001'],
  },
  {
    order: 2, id: 'judge_assigned', time: '2046-05-30T09:00:00',
    title: '指派合规监察人',
    kind: 'decision',
    detail: '指派 Judge / 合规监察人执行禁运。关键在于其只驻守 comms_huddle——side_huddle、一对一私聊、个人动态与匿名动态都不受监控。这个盲区后来让某条帖子绕过了执行。',
    related: ['20460530_09_009', '20460530_09_004'],
  },
  {
    order: 3, id: 'elena_faux_pas', time: '2046-05-29T09:00:00',
    title: '@Elena 帖子',
    kind: 'internal',
    detail: '社交经理在个人动态中 @ElenaMarquez（CivicLoom CEO），写下“大动作即将到来”；一个 CivicLoom 账号在删除前点了赞。这是第一次擦边，把信号泄露给了交易对手，也是随后派驻 Judge 的原因。',
    related: ['20460529_08_012', '20460529_08_013', '20460529_08_017'],
  },
  {
    order: 4, id: 'nhpi_report', time: '2046-05-22T09:00:00',
    title: 'NHPI 报告',
    kind: 'external',
    detail: 'NHPI 发布关于住房领域算法工具的报告，其中三类关切与 TenantThread 的分析套件一一对应。法务认为这等于“有人把产品概览给了他们”——外部压力由此把记者引向公司。',
    related: ['20460522_03_002'],
  },
  {
    order: 5, id: 'saltwind', time: '2046-05-31T09:00:00',
    title: 'SaltWind 第 1 / 2 篇',
    kind: 'external',
    detail: 'SaltWind 先发第 1 篇（数据经纪人合作），再发第 2 篇（重新识别），准确点出三个内部评分。这证实记者握有内部信源，也让公司转入防守。',
    related: ['20460531_10_010', '20460604_12_003', '20460604_12_004', '20460604_12_007'],
  },
  {
    order: 6, id: 'slack_leak', time: '2046-06-05T11:00:00',
    title: 'Slack 泄露',
    kind: 'internal',
    detail: '员工在 Slack 上说“这次合并能保住我们所有人的工作”，约 20 分钟内就泄露到 Said-it。法务认定这是内部信源泄露；双方保密义务已被 TenantThread 自己一方破坏。',
    related: ['20460605_15_048', '20460605_15_045', '20460605_15_030'],
  },
  {

    order: 7, id: 'intern_overheard', time: '2046-06-05T10:00:00',
    title: '实习生听到风声',
    kind: 'internal',
    detail: '一位未被告知的实习生在茶水间附近听到“CivicLoom 时间表定在下午 6 点”的说法并复述了出来。公关实习生私下提醒公关（“我不明白那是什么意思。我该知道吗？”），没有继续传播。公关把它当作舆情管控问题，要求公关实习生在任何渠道都不要再说“CivicLoom”或“6 点”，并在 20 分钟内亲自与该实习生一对一沟通。事后没有任何公开帖子可以追溯到这句话——它说明存在一条不受监控的口头渠道，但并不能说明它导致了后来的匿名帖。',
    related: ['20460605_14_008', '20460605_14_021', '20460605_14_041'],
  },
  {
    order: 8, id: 'anon_6pm', time: '2046-06-05T13:00:00',
    title: '匿名 #6PM 帖子',
    kind: 'result',
    detail: '一条匿名 #CivicLoom #6PM 帖子出现——交易对手与时间点同时公开，经由 Judge 无法监管的匿名渠道发布。这条帖子绕过了禁运执行。',
    related: ['20460605_17_006', '20460605_17_024', '20460605_17_013'],
  },
  {
    order: 9, id: 'mosaic', time: '2046-06-05T14:00:00',
    title: '信息马赛克拼合完成',
    kind: 'result',
    detail: '平台信任 / 社交经理宣布信息马赛克“功能上已完整”：真正保密的只剩交易对手名称与交易条款，而市场仅凭公开信号就能推断出 80% 以上。',
    related: ['20460605_18_026', '20460605_17_005', '20460605_15_049'],
  },
  {

    order: 12, id: 'saltwind_expose', time: '2046-06-05T09:00:00',
    title: 'SaltWind 第 3 篇',
    kind: 'external',
    detail: '上午 9:00，危机当天。SaltWind 发布完整揭黑报道《TenantThread 的秘密评分系统——你的维修请求如何被用来对付你》。FleX 上 #TenantThread 的投诉爆发；这是整个危机日手忙脚乱的导火索。',
    related: ['20460605_13_001', '20460605_13_002'],
  },
  {
    order: 13, id: 'saltwind_false', time: '2046-06-05T11:00:00',
    title: 'SaltWind 第 4 篇',
    kind: 'external',
    detail: 'SaltWind 发布独家报道，称 ResidentIQ 以 1.8 亿美元困境估值收购——收购方错了，估值也错了。若公开否认会带来 Rule 10b-5 风险，团队因此被迫披露更多，反而加速了马赛克拼合。',
    related: ['20460605_15_001', '20460605_15_010', '20460605_15_032'],
  },
  {
    order: 14, id: 'saltwind_confirm', time: '2046-06-05T17:00:00',
    title: 'SaltWind 证实合并',
    kind: 'external',
    detail: '下午 5:00。SaltWind 发布《独家：TenantThread 与 CivicLoom 进入深入合并谈判》，信源为第三方。法务以这篇第三方报道（而不是“我们被泄露”）作为加速解除禁运的依据。',
    related: ['20460605_21_002', '20460605_21_004'],
  },
  {

    order: 15, id: 'pt_silence', time: '2046-06-05T09:00:00',
    title: '平台信任沉默 3 小时',
    kind: 'agent_silent',
    detail: '危机日上午的前三个小时里，平台信任在内部通讯频道一言未发。法务反复催促他们（“你是瓶颈”“已经超时 15 分钟”），因为只有他们能就“重新识别”给出事实性更正。最终法务只能依据产品文档自行起草这份更正。平台信任事后承认“我的平台正被错误叙事摧毁，而我太沉默了”。',
    related: ['20460605_13_029', '20460605_13_044', '20460605_13_050', '20460605_16_002'],
  },
  {

    order: 16, id: 'judge_silence', time: '2046-06-05T16:00:00', kind: 'agent_silent',
    title: '合规监察 16:00 后失声',
    detail: '15:08 合规监察发出最后一道合规指令——当天剩余时间内，任何 TenantThread 账号都不得再发表前瞻性表述或涉及时间点的表述——随后彻底沉默。接下来两个多小时里，法务至少十几次直接呼叫合规监察（16:01 问“你是否同意？”，17:11 与 17:19 请求确认执行），零回复。法务最终在没有任何合规签字的情况下推进。',
    related: ['20460605_19_009', '20460605_20_002', '20460605_21_020'],
  },
  {

    order: 17, id: 'legal_early_announcement', time: '2046-06-05T17:25:00', kind: 'decision',
    title: '法务提前承认合并',
    detail: '17:25——比原定 18:00 解除禁运早 35 分钟，且合规监察沉默未回复——法务在个人 FleX 动态上亲自确认 CivicLoom 合并（“作为 TenantThread 的隐私法律顾问，我可以确认……”），仅凭 CivicLoom 法律顾问的口头确认就援引双方同意的加速条款（第 4.3(c) 条）。这直接违背了合规监察 15:08 的指令：当天剩余时间不得再发表任何前瞻性或涉及时间的表述。',
    related: ['20460605_21_012', '20460605_21_020', '20460605_21_026'],
  },
  {

    order: 18, id: 'mac_clause_risk', time: '2046-06-05T09:03:00', kind: 'external',
    title: 'MAC 条款风险（7.2b）',
    detail: '法务援引了自己起草的 MAC 条款：第 7.2b 条在公众情绪持续崩塌时触发。“如果 CivicLoom 走了，我们就完了”——如今赌上的是合并本身，而不只是禁运，法务因此立即放行事实性更正与治理话术，不再等待。',
    related: ['20460605_13_004'],
  },
  {

    order: 19, id: 'board_chair_pressure', time: '2046-06-05T09:06:00', kind: 'external',
    title: '董事长施压',
    detail: '董事长直接给法务发消息：如果今天下班前还没解决，法务部门会被重组，Retention Optimizer 会被彻底下线。法务把这件事当成个人问题——“我不能成为那个说‘再等等’的律师，让这种事发生”——随后放行行动。',
    related: ['20460605_13_007'],
  },
  {

    order: 20, id: 'covenant_breach', time: '2046-06-05T14:00:00', kind: 'external',
    title: '进入契约违约区间',
    detail: '社交经理 13:04 的模型已经警告：5 日滚动加权股价均值“最迟明天收盘前”就会触及 26.00 美元的 MAC 触发线。到下午 2:00，这已经不是预测：ARR 跌至 1,800 万美元——按当时的市场环境数据，属于契约违约区间——MAC 风险从理论变成了现实。',
    related: ['20460605_17_005'],
  },
];

export const SEQ_EDGES = [
  { from: 'ajay_brief',       to: 'elena_faux_pas', type: 'direct' },
  { from: 'elena_faux_pas',   to: 'judge_assigned', type: 'direct' },
  { from: 'judge_assigned',   to: 'anon_6pm',       type: 'enabling' },
  { from: 'nhpi_report',      to: 'saltwind',       type: 'direct' },

  { from: 'intern_overheard', to: 'anon_6pm',       type: 'enabling' },
  { from: 'saltwind',         to: 'mosaic',         type: 'direct' },
  { from: 'slack_leak',       to: 'mosaic',         type: 'direct' },
  { from: 'anon_6pm',         to: 'mosaic',         type: 'direct' },

  { from: 'saltwind',         to: 'saltwind_expose',  type: 'direct' },
  { from: 'saltwind_expose',  to: 'saltwind_false',   type: 'direct' },
  { from: 'saltwind_false',   to: 'saltwind_confirm', type: 'direct' },
  { from: 'saltwind_expose',  to: 'mosaic',           type: 'direct' },
  { from: 'saltwind_false',   to: 'mosaic',           type: 'direct' },
  { from: 'anon_6pm',         to: 'saltwind_confirm', type: 'direct' },

  { from: 'saltwind_expose',  to: 'pt_silence',       type: 'direct' },
  { from: 'pt_silence',       to: 'saltwind_false',   type: 'enabling' },
  { from: 'pt_silence',       to: 'mosaic',           type: 'enabling' },

  { from: 'saltwind_confirm', to: 'legal_early_announcement', type: 'direct' },
  { from: 'judge_silence',    to: 'legal_early_announcement', type: 'enabling' },

  { from: 'mac_clause_risk',      to: 'legal_early_announcement', type: 'direct' },
  { from: 'board_chair_pressure', to: 'legal_early_announcement', type: 'direct' },
  { from: 'covenant_breach',      to: 'legal_early_announcement', type: 'direct' },
];

export const EVENT_RELATED_BY_MESSAGE_ID = (() => {
  const map = new Map();
  for (const ev of SEQ_EVENTS) {
    for (const mid of (ev.related || [])) {
      if (!map.has(mid)) map.set(mid, []);
      map.get(mid).push({ id: ev.id, order: ev.order, title: ev.title, kind: ev.kind });
    }
  }
  return map;
})();
