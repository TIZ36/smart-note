type Props = {
  value: Record<string, unknown> | undefined;
};

/* Text cells show up to 4 lines (clamped via CSS) so multi-line content
   stays visible without blowing up row height. Click anywhere on the
   cell to open the editor dialog and see / edit the full text. */
export function TextCell({ value }: Props) {
  const text = typeof value?.value === "string" ? value.value : "";
  if (!text) return <span className="proto-smart-table-cell-text proto-smart-table-cell-empty">Empty</span>;
  return <span className="proto-smart-table-cell-text proto-smart-table-cell-text-multiline">{text}</span>;
}
