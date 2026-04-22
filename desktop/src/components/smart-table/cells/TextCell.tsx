import ReactMarkdown from "react-markdown";

type Props = {
  value: Record<string, unknown> | undefined;
};

/* Text cells render Markdown formatting inline but clamp to ~4 lines
   so multi-line or richly-formatted content stays visible without
   blowing up the row height. Click anywhere on the cell to open the
   editor dialog for the full view + edit. */
export function TextCell({ value }: Props) {
  const text = typeof value?.value === "string" ? value.value : "";
  if (!text) return <span className="proto-smart-table-cell-text proto-smart-table-cell-empty">Empty</span>;
  // react-markdown emits block-level elements; CSS clamp + our own
  // `proto-smart-table-cell-md` reset styles those down so the output
  // fits within the table cell.
  return (
    <div className="proto-smart-table-cell-text proto-smart-table-cell-md">
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
}
