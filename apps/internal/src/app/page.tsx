"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { landingPathFor, storedUser } from "@/lib/landing";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const token = localStorage.getItem("accessToken");
    router.replace(token ? landingPathFor(storedUser()) : "/login");
  }, [router]);
  return null;
}
