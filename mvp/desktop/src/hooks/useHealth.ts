import { useState, useEffect } from "react";
import { getMvpStatus } from "../lib/electron";

type HealthState = {
  gatewayOnline: boolean;
  embeddingMode: string;
};

export function useHealth(intervalMs = 3000) {
  const [health, setHealth] = useState<HealthState>({
    gatewayOnline: false,
    embeddingMode: "unknown",
  });

  useEffect(() => {
    let mounted = true;

    async function check() {
      try {
        const status = await getMvpStatus();
        if (mounted) {
          setHealth({
            gatewayOnline: status.gateway_online,
            embeddingMode: status.embedding_mode || "unknown",
          });
        }
      } catch {
        if (mounted) {
          setHealth((h) => ({ ...h, gatewayOnline: false }));
        }
      }
    }

    check();
    const id = setInterval(check, intervalMs);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [intervalMs]);

  return health;
}
