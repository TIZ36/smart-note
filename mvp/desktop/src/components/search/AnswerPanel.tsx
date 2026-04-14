import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { cn } from "../../lib/cn";

type Props = {
  answer: string | null;
  loading: boolean;
  answerId: number | null;
  feedbackGiven: boolean;
  onFeedback: () => void;
  onCitationClick?: (index: number) => void;
};

function TypingIndicator() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)]"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ repeat: Infinity, duration: 1, delay: i * 0.15 }}
          />
        ))}
      </div>
      <div className="space-y-2">
        {[100, 80, 60].map((w, i) => (
          <div key={i} className="h-2.5 animate-shimmer rounded" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

/**
 * Convert [N] citation markers in text to clickable spans.
 * ReactMarkdown renders text nodes — we post-process them.
 */
function CitationText({
  text,
  onCitationClick,
}: {
  text: string;
  onCitationClick?: (index: number) => void;
}) {
  if (!onCitationClick) return <>{text}</>;

  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^\[(\d+)\]$/);
        if (match) {
          const idx = parseInt(match[1], 10);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onCitationClick(idx)}
              className="proto-citation-link"
              title={`Jump to source ${idx}`}
            >
              {part}
            </button>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function AnswerPanel({
  answer,
  loading,
  answerId,
  feedbackGiven,
  onFeedback,
  onCitationClick,
}: Props) {
  return (
    <div>
      <div className="proto-answer-label">Answer</div>

      {loading && !answer ? (
        <TypingIndicator />
      ) : answer ? (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
          <div className="proto-answer-body markdown-content">
            <ReactMarkdown
              components={{
                // Override text rendering to make [N] clickable
                p: ({ children }) => (
                  <p>
                    {Array.isArray(children)
                      ? children.map((child, i) =>
                          typeof child === "string" ? (
                            <CitationText key={i} text={child} onCitationClick={onCitationClick} />
                          ) : (
                            child
                          )
                        )
                      : typeof children === "string" ? (
                          <CitationText text={children} onCitationClick={onCitationClick} />
                        ) : (
                          children
                        )}
                  </p>
                ),
                li: ({ children }) => (
                  <li>
                    {Array.isArray(children)
                      ? children.map((child, i) =>
                          typeof child === "string" ? (
                            <CitationText key={i} text={child} onCitationClick={onCitationClick} />
                          ) : (
                            child
                          )
                        )
                      : typeof children === "string" ? (
                          <CitationText text={children} onCitationClick={onCitationClick} />
                        ) : (
                          children
                        )}
                  </li>
                ),
              }}
            >
              {answer}
            </ReactMarkdown>
          </div>
          {answerId && (
            <div className="proto-answer-feedback">
              <button
                type="button"
                onClick={onFeedback}
                disabled={feedbackGiven}
                className={cn(feedbackGiven && "text-[var(--color-success)]")}
              >
                {feedbackGiven ? "Thanks!" : "\u261D Helpful"}
              </button>
            </div>
          )}
        </motion.div>
      ) : null}
    </div>
  );
}
