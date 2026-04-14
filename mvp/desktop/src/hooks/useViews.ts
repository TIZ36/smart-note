import { useState, useCallback } from "react";
import { listViews } from "../lib/electron";
import type { ViewItem } from "../lib/types";

export function useViews() {
  const [views, setViews] = useState<ViewItem[]>([]);

  const refresh = useCallback(async (notePath: string) => {
    if (!notePath) return;
    try {
      const data = await listViews(notePath);
      const items: ViewItem[] = data.views.map((v) => {
        const filename = v.path.split("/").pop()?.replace(".md", "") || "";
        return {
          key: filename,
          title: v.name,
          path: v.path,
        };
      });
      setViews(items);
    } catch {
      setViews([]);
    }
  }, []);

  return { views, refreshViews: refresh };
}
