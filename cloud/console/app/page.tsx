"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { readSession } from "@/lib/auth";

export default function Index() {
  const router = useRouter();
  useEffect(() => {
    router.replace(readSession() ? "/execution" : "/login");
  }, [router]);
  return null;
}
