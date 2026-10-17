"use client";
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { offerHref } from "@/lib/offers";
import { Loading } from "@/components/ui";

// The address the offer email links to (/booking?id=<offer id>). The offer itself lives at /offer?id=, so this page
// only hands on to it; replace, not push, so Back does not land on a page that immediately redirects again.
// (Without an id it goes to the list.) It is a signed-in route: a signed-out visitor is sent to sign in first and
// comes back here with the id intact.

function Handoff() {
  const router = useRouter();
  const id = useSearchParams().get("id");
  useEffect(() => {
    router.replace(id ? offerHref(id) : "/offers");
  }, [id, router]);
  return <Loading label="Opening your booking…" />;
}

export default function BookingPage() {
  return (
    <Suspense fallback={<Loading label="Opening your booking…" />}>
      <Handoff />
    </Suspense>
  );
}
