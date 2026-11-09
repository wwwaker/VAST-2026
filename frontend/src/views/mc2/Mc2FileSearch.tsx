import { useState } from "react";
import { formatUtc, searchFiles } from "../../data/api";

interface FileHit {
  file_id: string;
  path: string;
  event_count: number;
  first_us: number | null;
  last_us: number | null;
  exact: boolean;
}

/**
 * 文件查询：/api/files 的按名检索入口。
 * 只解析文件实体与操作计数；同名不同路径不合并，也不推断正文。
 */
export function Mc2FileSearch({ onOpenFile }: { onOpenFile: (fileId: string, path: string) => void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<FileHit[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const run = async () => {
    const keyword = query.trim();
    if (!keyword) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const payload = await searchFiles(keyword);
      setItems(payload.items);
      setNote(payload.note);
    } catch (err) {
      setItems([]);
      setNote(null);
      setError(err instanceof Error ? err.message : "文件查询失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mc2-file-search">
      <div className="mc2-file-search-row">
        <input
          type="search"
          aria-label="按文件名查询文件实体"
          placeholder="文件路径或名称，例如 SwiftWren"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run();
          }}
        />
        <button type="button" className="btn" onClick={() => void run()} disabled={loading || !query.trim()}>
          {loading ? "查询中…" : "查询文件"}
        </button>
      </div>
      <p className="muted small">
        精确匹配优先、其次子串；返回的是文件实体及其操作计数，点一行在阅读面板查看文件轨迹。
      </p>
      {error && <p className="stream-error">{error}</p>}
      {searched && !error && items.length === 0 && !loading && (
        <p className="muted small">没有匹配的文件实体。文件名相同但路径不同的文件不会合并。</p>
      )}
      <ul className="trace-list">
        {items.map((item) => (
          <li key={item.file_id}>
            <button
              type="button"
              className="trace-item"
              title={item.file_id}
              onClick={() => onOpenFile(item.file_id, item.path)}
            >
              <span className="mono small">{item.path}</span>
              <span className="muted small">{item.event_count} 次操作记录</span>
              <span className="muted small">
                {item.first_us != null ? formatUtc(item.first_us) : "—"}
                {item.last_us != null ? ` → ${formatUtc(item.last_us)}` : ""}
              </span>
              {item.exact && <span className="tag tag-ok">精确匹配</span>}
            </button>
          </li>
        ))}
      </ul>
      {note && <p className="muted small">{note}</p>}
    </div>
  );
}
