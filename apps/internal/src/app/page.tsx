"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { homePathFor } from "@/lib/roles";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const token = localStorage.getItem("accessToken");
    let user = null;
    try { user = JSON.parse(localStorage.getItem("user") ?? "null"); } catch {}
    router.replace(token ? homePathFor(user) : "/login");
  }, [router]);
  return null;
}
