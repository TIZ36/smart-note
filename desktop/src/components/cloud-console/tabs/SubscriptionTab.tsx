import { useEffect, useState } from "react";
import { fetchUsage, fetchOverview, type Usage, type ConsoleOverview } from "@/lib/cloud-api";
import { ProviderConfigCard } from "../cards/ProviderConfigCard";

/* Subscription — workspace tier, usage counters, and the LLM provider
   config that activates the cloud_pool executor. Self-hosted today;
   when paid tiers ship the tier label here becomes the source of truth. */

export function SubscriptionTab() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [overview, setOverview] = useState<ConsoleOverview | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [u, o] = await Promise.all([fetchUsage(), fetchOverview()]);
        if (!alive) return;
        setUsage(u); setOverview(o); setErr("");
      } catch (e) { if (alive) setErr(String(e)); }
    };
    load();
    const id = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="proto-cc-content">
      <section className="proto-cloud-sync-card">
        <h2 className="proto-cloud-sync-card-title">Plan</h2>
        <div className="proto-plan-row">
          <div>
            <div className="proto-plan-tier">Self-hosted</div>
            <div className="proto-plan-tier-note">
              Running on your own infrastructure. No metered limits.
              Hosted tiers (¥9.9 / ¥99 / $199 monthly) ship next.
            </div>
          </div>
          <div className="proto-plan-status">
            <span className="proto-cc-statusdot proto-cc-statusdot-on" />
            Active
          </div>
        </div>
      </section>

      <section className="proto-cloud-sync-card">
        <h2 className="proto-cloud-sync-card-title">Usage</h2>
        {err && <div className="proto-cc-error">{err}</div>}
        <div className="proto-inventory-grid">
          <UsageCell label="Memories" value={usage?.memory_count} />
          <UsageCell label="Documents" value={usage?.document_count} />
          <UsageCell label="Embed tokens" value={usage?.embed_tokens} />
          <UsageCell label="Retrieve calls" value={usage?.retrieve_calls} />
          <UsageCell label="Devices" value={overview?.counts.devices} />
        </div>
        {usage?.updated_at && (
          <p className="proto-form-hint" style={{ marginTop: 8 }}>
            Last updated {new Date(usage.updated_at).toLocaleString()}
          </p>
        )}
      </section>

      <ProviderConfigCard />
    </div>
  );
}

function UsageCell({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="proto-inventory-cell">
      <div className="proto-inventory-cell-value">
        {value == null ? "—" : value.toLocaleString()}
      </div>
      <div className="proto-inventory-cell-label">{label}</div>
    </div>
  );
}
