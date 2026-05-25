"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const token = localStorage.getItem("clientAccessToken");
    router.replace(token ? "/dashboard" : "/login");
  }, [router]);
  return null;
}
