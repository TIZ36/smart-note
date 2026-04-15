type Props = {
  questions: string[];
  onSelect: (q: string) => void;
};

export function RelatedQuestions({ questions, onSelect }: Props) {
  if (questions.length === 0) return null;

  return (
    <div className="proto-related-section">
      <div className="proto-related-label">Related</div>
      <div className="proto-related-chips">
        {questions.map((q, i) => (
          <button key={i} type="button" onClick={() => onSelect(q)} className="proto-related-chip">
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
