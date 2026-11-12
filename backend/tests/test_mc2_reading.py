import json
import unittest

from app.domain.mc2_reading import summary


class Mc2ReadingTests(unittest.TestCase):
    def test_queued_read_keeps_target_path_and_pending_semantics(self):
        text = summary("queue_subordinate_task", json.dumps({
            "target_agent": "Agent/person:john_windward", "task": "read_file",
            "args": {"path": "SwiftWren_further_instructions.md"}}))
        self.assertIn("排入任务：读取文件", text)
        self.assertIn("john windward", text)
        self.assertIn("SwiftWren_further_instructions.md", text)
        self.assertNotIn("成功", text)

    def test_post_reference_does_not_fabricate_body(self):
        self.assertEqual(summary("saidit_post", '{"content_source":"SwiftWren.txt"}'), "发布内容来源：SwiftWren.txt")

    def test_mail_and_question_retain_readable_content(self):
        text = summary("received", '{"from":"person:john","to":"person:chloe","subject":"Quarterly plan"}')
        self.assertIn("john → chloe", text)
        self.assertIn("Quarterly plan", text)
        text = summary("ask_agent", '{"question":"Which permissions?","response":"Read only."}')
        self.assertIn("Which permissions?", text)
        self.assertIn("Read only.", text)

    def test_missing_check_result_is_explicit(self):
        text = summary("saidit_post_check", None)
        self.assertIn("没有提供校验结果", text)
        self.assertNotIn("通过", text)


if __name__ == "__main__":
    unittest.main()
