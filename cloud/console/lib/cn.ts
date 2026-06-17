export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function dotClass(s: string) {
  if (s === "done") return "s-done";
  if (s === "running") return "s-running";
  if (s === "failed") return "s-failed";
  if (s === "idle") return "s-idle";
  return "s-warn";
}
