import { useCallback, useEffect, useState } from "react";
import {
  listDevices, pairDevice, promoteDevice, unpairDevice, type Device,
} from "@/lib/cloud-api";

export function DevicesTab() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [err, setErr] = useState("");
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDevices(await listDevices());
      setErr("");
    } catch (e) { setErr(String(e)); }
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
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-wide text-zinc-400">Devices</h3>
        <button onClick={issuePair}
          className="text-sm px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white">
          Pair new device
        </button>
      </div>
      {err && <div className="text-rose-400 text-sm">{err}</div>}
      {pairing && (
        <div className="bg-emerald-900/30 border border-emerald-800 rounded p-3 text-sm">
          <div>Enter this code on the new device within 10 minutes:</div>
          <div className="text-3xl font-mono tracking-widest mt-1 text-emerald-300">
            {pairing.code}
          </div>
          <div className="text-zinc-500 text-xs mt-1">
            expires {new Date(pairing.expiresAt).toLocaleTimeString()}
          </div>
        </div>
      )}
      {devices.length === 0
        ? <div className="text-zinc-500 text-sm">No devices yet.</div>
        : <table className="w-full text-sm">
            <thead className="text-zinc-500 text-xs uppercase">
              <tr>
                <th className="text-left py-1">Name</th>
                <th className="text-left">Platform</th>
                <th className="text-left">Primary</th>
                <th className="text-left">Online</th>
                <th className="text-left">Last seen</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {devices.map(d => (
                <tr key={d.id} className="border-t border-zinc-800">
                  <td className="py-2">{d.name}</td>
                  <td>{d.platform}</td>
                  <td>{d.is_primary ? "★" : ""}</td>
                  <td>
                    <span className={"inline-block w-2 h-2 rounded-full mr-1 " +
                      (d.online ? "bg-emerald-400" : "bg-zinc-600")} />
                    {d.online ? "online" : "offline"}
                  </td>
                  <td className="text-zinc-500">
                    {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "—"}
                  </td>
                  <td className="text-right space-x-2">
                    {!d.is_primary && (
                      <button onClick={() => promoteDevice(d.id).then(refresh).catch(e => setErr(String(e)))}
                        className="text-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700">
                        Promote
                      </button>
                    )}
                    <button onClick={() => unpairDevice(d.id).then(refresh).catch(e => setErr(String(e)))}
                      className="text-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-rose-800">
                      Unpair
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
    </div>
  );
}
