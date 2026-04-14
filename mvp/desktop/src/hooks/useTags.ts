import { useState, useCallback } from "react";
import * as api from "../lib/api";

export type TagData = api.TagInfo;

export function useTags() {
  const [tags, setTags] = useState<TagData[]>([]);

  const refresh = useCallback(async () => {
    try {
      const data = await api.fetchTags();
      setTags(data.tags);
    } catch {
      setTags([]);
    }
  }, []);

  return { tags, refreshTags: refresh };
}
