import { useEffect } from "react";

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "筛选",
    items: [
      ["/ 或 F", "跳到关键词输入框并全选"],
      ["Esc", "未打开侧栏时清空时间窗"],
    ],
  },
  {
    title: "时间刷选与回放",
    items: [
      ["← / →", "游标后退 / 前进 1 小时"],
      ["Shift + ← / →", "游标后退 / 前进 6 小时"],
      ["空格", "播放 / 暂停回放"],
      ["M", "切换回放遮蔽"],
    ],
  },
  {
    title: "事件选择",
    items: [
      ["↑ / ↓", "在事件流中选上一条 / 下一条"],
      ["Enter", "打开证据侧栏"],
    ],
  },
  {
    title: "证据侧栏",
    items: [
      ["Esc", "关闭侧栏"],
      ["?", "打开 / 关闭本说明"],
    ],
  },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="键盘快捷键"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>键盘快捷键</h2>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl className="hotkeys">
                {group.items.map(([keys, desc]) => (
                  <div key={keys} className="hotkey-row">
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{desc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <p className="muted small">
            在输入框内不触发上述快捷键。范围按计划书约定，只覆盖主要操作，不覆盖全部控件。
          </p>
        </div>
      </div>
    </div>
  );
}
