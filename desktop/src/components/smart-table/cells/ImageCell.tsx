type Props = {
  value: Record<string, unknown> | undefined;
};

export function ImageCell({ value }: Props) {
  const src = typeof value?.url === "string"
    ? value.url
    : typeof value?.path === "string"
      ? `http://127.0.0.1:8787/${String(value.path).replace(/^\/+/, "")}`
      : typeof value?.value === "string"
        ? value.value
        : "";
  if (!src) return <span className="proto-smart-table-cell-text">Empty</span>;
  return <img src={src} alt="cell" className="proto-smart-table-cell-image" />;
}
