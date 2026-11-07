import { EvidenceBasket } from "../components/EvidenceBasket";
import { NotesPanel } from "../components/NotesPanel";
import { useWorkspace } from "../state/workspace";

export function FindingsWorkspace() {
  const { state, notes, notesLoading, selectedEventId, selectedEventAt, addNote, removeNote, noteDraft, setNoteDraft } = useWorkspace();
  const notesMode = state.mode === "notes";
  return (
    <section className="findings-workspace" aria-label="结论工作区">
      <header className="findings-head">
        <div>
          <h2>{notesMode ? "调查笔记" : "案例与证据"}</h2>
          <p className="muted small">{notesMode ? "记录判断、局限和待核实事项。" : "把事件固定为证据，保存案例并形成可导出的结论。"}</p>
        </div>
        <span className="tag">{state.basket.length} 条证据</span>
      </header>
      {notesMode ? (
        <NotesPanel
          notes={notes}
          loading={notesLoading}
          selectedEventId={selectedEventId}
          eventTime={selectedEventAt}
          onAdd={addNote}
          onRemove={removeNote}
          draft={noteDraft}
          onDraftChange={setNoteDraft}
        />
      ) : <EvidenceBasket />}
    </section>
  );
}
