"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchStats, listDocuments, listNotes } from "@/lib/api";
import { IconAsk, IconDoc, IconExecution, IconNote } from "./icons";

type Counts = { runs: number | null; docs: number | null; notes: number | null };

export function Nav() {
  const pathname = usePathname();
  const [c, setC] = useState<Counts>({ runs: null, docs: null, notes: null });

  // Fetch counts on mount; failure is silent — nav just hides the count.
  useEffect(() => {
    let alive = true;
    Promise.allSettled([fetchStats(), listDocuments(), listNotes()]).then(([s, d, n]) => {
      if (!alive) return;
      setC({
        runs:  s.status === "fulfilled" ? s.value.runsToday : null,
        docs:  d.status === "fulfilled" ? d.value.length    : null,
        notes: n.status === "fulfilled" ? n.value.length    : null,
      });
    });
    return () => { alive = false; };
  }, []);

  const items = [
    { href: "/execution", label: "Execution", icon: <IconExecution />, count: c.runs },
    { href: "/documents", label: "Documents", icon: <IconDoc />,       count: c.docs },
    { href: "/notes",     label: "Notes",     icon: <IconNote />,      count: c.notes },
    { href: "/ask",       label: "Ask Cloud", icon: <IconAsk />,       count: null },
  ];

  return (
    <nav className="nav" aria-label="Sections">
      <div className="nav-section-label">Workspace</div>
      {items.map((it) => {
        const active = pathname?.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className="nav-item"
            aria-current={active ? "page" : "false"}
          >
            {it.icon}
            <span className="nav-item-label">{it.label}</span>
            {it.count != null && <span className="nav-item-count">{it.count}</span>}
          </Link>
        );
      })}
      <div className="nav-foot">
        read-only · sync from Desktop
      </div>
    </nav>
  );
}
