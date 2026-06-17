"use client";
import { useEffect, useState, type ReactNode } from "react";
import { readSession } from "@/lib/auth";

export function PageHead({
  section,
  title,
  status,
  showLiveDot = true,
  liveTime,
}: {
  section: string;
  title: string;
  status?: ReactNode;
  showLiveDot?: boolean;
  liveTime?: boolean;
}) {
  const [ws, setWs] = useState("workspace");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const s = readSession();
    setWs(s?.workspaceLabel.split(" ")[0] ?? "workspace");
  }, []);

  useEffect(() => {
    if (!liveTime) return;
    const id = setInterval(() => setTick((t) => (t + 1) % 60), 1000);
    return () => clearInterval(id);
  }, [liveTime]);

  return (
    <header className="page-head">
      <div className="page-titlewrap">
        <span className="page-eyebrow">
          <span>{ws}</span>
          <span className="crumb-sep">/</span>
          <span>{section}</span>
        </span>
        <h1 className="page-title">{title}</h1>
      </div>
      <span className="page-status">
        {showLiveDot && <span className="live-dot" />}
        {liveTime ? <span>updated {tick}s ago</span> : status}
      </span>
    </header>
  );
}
