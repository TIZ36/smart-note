type Props = {
  value: Record<string, unknown> | undefined;
};

export function LinkCell({ value }: Props) {
  const href = typeof value?.url === "string" ? value.url : typeof value?.value === "string" ? value.value : "";
  const label = typeof value?.label === "string" ? value.label : href;
  if (!href) return <span className="proto-smart-table-cell-text">Empty</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="proto-smart-table-cell-link"
    >
      {label}
    </a>
  );
}
