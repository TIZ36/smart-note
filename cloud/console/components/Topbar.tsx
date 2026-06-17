"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clearSession, readSession, type Session } from "@/lib/auth";
import { IconTheme } from "./icons";

export function Topbar() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => { setSession(readSession()); }, []);

  function toggleTheme() {
    const cur = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
  }
  function signOut() {
    clearSession();
    router.replace("/login");
  }

  return (
    <header className="topbar">
      <span className="brand">SmartNote<span className="brand-sub">Admin</span></span>
      <span className={"ws" + (session ? "" : " is-out")}>
        {session ? session.workspaceLabel : "signed out"}
      </span>
      <span className="spacer" />
      <button className="topbar-action" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
        <IconTheme />
      </button>
      {session && (
        <button className="btn-quiet" onClick={signOut}>Sign out</button>
      )}
    </header>
  );
}
