"""Recorded roles only. This registry is sent with every relationship projection."""
ROLE_SEMANTICS = {
    'queue_target_agent': ('任务发起执行者', '智能体目标', ['queue_subordinate_task'], ['details.target_agent'], '仅记录任务排队，不表示目标执行成功'),
    'queue_target_person': ('任务发起执行者', '人员目标', ['queue_subordinate_task'], ['details.target'], '仅记录任务排队，不表示目标执行成功'),
    'mail_recipient': ('邮件记录执行者', '收件角色', ['sent', 'send_email'], ['details.to'], '邮件角色按原始字段解析，不另推断一次发送'),
    'mail_sender': ('邮件记录执行者', '发件角色', ['received'], ['details.from'], '发件角色不是新增发送事件'),
    'a2a_destination': ('通信执行者', '明确通信目标', ['propose_meeting'], ['details.a2a.to'], '明确通信目标可以是环境系统，不推断后续行为'),
    'meeting_invitee': ('会议记录执行者', '受邀对象', ['propose_meeting'], ['details.meeting.participants', 'details.calendar_emails_sent'], '邀请不等于实际参会'),
    'system_party': ('活动执行者', '系统角色', ['propose_meeting','saidit_post_check','post_saidit','send_email','read_file','create_file','post_flex','saidit_post','delete_file'], ['relationships（已提供的系统参与角色）'], '仅使用规范化日志中明确提供的系统角色，不按名称猜测，不表示系统之间传播'),
    'room': ('活动执行者', '地点', ['check_access','enter_room'], ['details.room'], '原始地点或准入字段'),
    'file_path': ('活动执行者', '精确文件', ['access_files','create_file', 'read_file', 'delete_file'], ['details.target', 'details.file'], '明确文件操作，不推断正文相同'),
    'queued_file_path': ('任务发起执行者', '任务文件参数', ['queue_subordinate_task'], ['details.args.path', 'details.details'], '文件作为任务参数，不等于已读取'),
    'post_content_source': ('发布执行者', '精确来源文件', ['saidit_post'], ['content_source'], '明确来源引用；引用不等于日志提供正文'),
}


def registry():
    return {key: {'source_role': a, 'target_role': b, 'event_types': c, 'fields': d,
                  'note': e + '；关系事实以原记录 relationships 为准，可在阅读中核对 source:relationships 及字段定位', 'evidence_level': 'recorded', 'default_view': 'matrix',
                  'missing_source': '原记录未提供来源执行者，不推断补齐'}
            for key, (a, b, c, d, e) in ROLE_SEMANTICS.items()}
