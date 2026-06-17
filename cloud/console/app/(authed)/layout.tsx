"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Topbar } from "@/components/Topbar";
import { Nav } from "@/components/Nav";
import { DetailProvider } from "@/components/DetailOverlay";
import { readSession } from "@/lib/auth";

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!readSession()) {
      router.replace("/login");
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return <div className="app"><Topbar /></div>;

  return (
    <DetailProvider>
      <div className="app">
        <Topbar />
        <div className="shell">
          <Nav />
          <main className="main">{children}</main>
        </div>
      </div>
    </DetailProvider>
  );
}
