import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  listDevices, pairDevice, promoteDevice, unpairDevice, type Device,
} from "@/lib/cloud-api";

export function DevicesTab() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [err, setErr] = useState("");
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);

  const refresh = useCallback(async () => {
    try { setDevices(await listDevices()); setErr(""); }
    catch (e) { setErr(String(e)); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const issuePair = async () => {
    try {
      const r = await pairDevice();
      setPairing({ code: r.pairing_code, expiresAt: r.expires_at });
      refresh();
    } catch (e) { setErr(String(e)); }
  };

  return (
    <div className="proto-cc-content">
      <section className="proto-form-section">
        <div className="proto-cc-section-head">
          <h2 className="proto-form-section-title">Devices</h2>
          <button onClick={issuePair} className="proto-btn proto-btn-primary">
            <Plus size={14} /> Pair new device
          </button>
        </div>

        {err && <div className="proto-cc-error">{err}</div>}

        {pairing && (
          <div className="proto-cc-pair-banner">
            <div className="proto-cc-pair-banner-label">
              On the new device: open SmartNote → Cloud Sync →
              "Pair to an existing workspace" and enter:
            </div>
            <div className="proto-cc-pair-code">{pairing.code}</div>
            <div className="proto-cc-pair-banner-meta">
              expires {new Date(pairing.expiresAt).toLocaleTimeString()} ·
              single-use, becomes invalid once redeemed
            </div>
          </div>
        )}

        {devices.length === 0 ? (
          <div className="proto-cc-empty">No devices paired yet.</div>
        ) : (
          <table className="proto-cc-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Platform</th>
                <th>Primary</th>
                <th>Status</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td className="proto-cc-cell-muted">{d.platform}</td>
                  <td>{d.is_primary ? "★" : ""}</td>
                  <td>
                    <span className={"proto-cc-statusdot " + (d.online ? "proto-cc-statusdot-on" : "")} />
                    {d.online ? "online" : "offline"}
                  </td>
                  <td className="proto-cc-cell-muted">
                    {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "—"}
                  </td>
                  <td className="proto-cc-cell-actions">
                    {!d.is_primary && (
                      <button
                        onClick={() => promoteDevice(d.id).then(refresh).catch((e) => setErr(String(e)))}
                        className="proto-btn proto-btn-secondary"
                      >
                        Promote
                      </button>
                    )}
                    <button
                      onClick={() => unpairDevice(d.id).then(refresh).catch((e) => setErr(String(e)))}
                      className="proto-btn proto-btn-secondary"
                    >
                      Unpair
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
