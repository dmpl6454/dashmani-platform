"use client";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import type { CreatorOfferList } from "@/lib/types";
import { Banner } from "@/components/ui";

/**
 * Shown inside the disconnect and close-account dialogs: what happens to bookings that are still
 * open. Disconnecting stops new answers (an offer can't be accepted on a disconnected page) but a
 * post already accepted can still be recorded; closing the account ends both.
 */
export function OpenBookingsWarning({ action }: { action: "disconnect" | "close" }) {
  const { data } = useSWR<CreatorOfferList>("/creator/offers", fetcher, { revalidateOnFocus: false, dedupingInterval: 5_000 });
  const waiting = data?.counts.waiting ?? 0;
  const toPost = data?.counts.toPost ?? 0;
  if (!waiting && !toPost) return null;
  const parts = [
    waiting ? `${waiting} booking${waiting === 1 ? " is" : "s are"} waiting for your answer` : "",
    toPost ? `${toPost} accepted post${toPost === 1 ? " is" : "s are"} not recorded yet` : "",
  ].filter(Boolean);
  return (
    <Banner tone="warn" title={`${parts.join(" and ")}.`}>
      {action === "disconnect"
        ? waiting
          ? "You can't accept a booking on a disconnected page — it will be treated as declined when its time runs out. Posts you already accepted can still be posted and recorded."
          : "Posts you already accepted can still be posted and recorded after you disconnect."
        : "Once the account is closed you can't answer bookings or record posts, and there is no payout for posts that weren't recorded."}
    </Banner>
  );
}
