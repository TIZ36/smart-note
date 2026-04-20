type Props = {
  value: Record<string, unknown> | undefined;
};

export function TextCell({ value }: Props) {
  const text = typeof value?.value === "string" ? value.value : "";
  return <span className="proto-smart-table-cell-text">{text || "Empty"}</span>;
}
