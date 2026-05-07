import { useEffect, useState } from "react";
import { readSettings } from "@/lib/electron";

/* Where the standalone log panel is reachable. Used by the
 * StageDetailModal's "Open in Logs ↗" footer button.
 *
 * Resolution order:
 *   1. settings.log_panel_url (set in Settings → Cloud)
 *   2. settings.cloud_sync_url with port swap to 8090 (default
 *      docker-compose mapping for the panel)
 *   3. http://localhost:8090 (dev default)
 *
 * Returns null when SmartNote isn't connected to cloud at all —
 * the modal hides the button in that case.
 */
export function useLogPanelUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await readSettings();
        let next: string | null = null;
        const explicit = s.log_panel_url;
        if (typeof explicit === "string" && explicit.trim()) {
          next = explicit.trim().replace(/\/$/, "");
        } else if (s.cloud_sync_url) {
          try {
            const u = new URL(s.cloud_sync_url);
            u.port = "8090";
            u.pathname = "";
            next = u.toString().replace(/\/$/, "");
          } catch {
            next = "http://localhost:8090";
          }
        } else {
          next = "http://localhost:8090";
        }
        if (alive) setUrl(next);
      } catch {
        if (alive) setUrl("http://localhost:8090");
      }
    })();
    return () => { alive = false; };
  }, []);
  return url;
}
