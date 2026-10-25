"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, Empty, PageError, Skeleton } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { useCampaigns, rupees, nextStepHint } from "@/lib/campaign";
import { CampaignStatus, fmtDate } from "./_ui";

/** Same words as the dashboard's campaign card (a page file may not export it).
 *  No platform list: the catalogue decides which networks are bookable, so the
 *  copy never promises one it lacks. */
const CAMPAIGNS_EMPTY_HINT =
  "Book promotion on our network of pages — pick the accounts, upload your video or image and send it for review.";

export default function CampaignsPage() {
  const router = useRouter();
  const { data, error, isLoading } = useCampaigns();
  const rows = data ?? [];

  return (
    <>
      <Topstrip
        title="Campaigns"
        sub={data ? `${rows.length} total` : undefined}
        right={
          <Button variant="ink" size="sm" icon={<Icon.Plus size={14} sw={2.5} />} onClick={() => router.push("/campaigns/new")}>
            Start a campaign
          </Button>
        }
      />
      <div className="px-4 sm:px-6 py-6 max-w-[1100px] mx-auto w-full flex-1 overflow-y-auto">
        <div className="v3-card overflow-hidden">
          {error && !isLoading && <div className="p-5"><PageError message="Could not load your campaigns. Please refresh." /></div>}
          {isLoading && [...Array(3)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex gap-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.10)" }}>
              <Skeleton className="h-4 w-1/3" /><Skeleton className="h-4 w-20 ml-auto" />
            </div>
          ))}
          {data && rows.length === 0 && (
            <Empty
              icon={<Icon.Megaphone size={20} />}
              title="No campaigns yet"
              hint={CAMPAIGNS_EMPTY_HINT}
              cta={<Button size="sm" variant="ink" onClick={() => router.push("/campaigns/new")}>Start a campaign</Button>}
            />
          )}
          {rows.map((r, i) => {
            const hint = nextStepHint(r);
            return (
            <Link
              key={r.id}
              href={`/campaigns/${r.id}`}
              className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4 px-5 py-4 v3-row transition-colors"
              style={i < rows.length - 1 ? { borderBottom: "1px solid rgba(255,255,255,0.10)" } : undefined}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-ink truncate">{r.name}</div>
                <div className="text-[12px] text-ink-3 truncate">
                  {r.brand} · {r.launchFrom ? `${fmtDate(r.launchFrom)} – ${fmtDate(r.launchTo)}` : "dates not set"}
                </div>
                {/* Own line: appended to the truncating brand/date line it was cut off on phones. */}
                {hint && <div className="text-[12px] text-ink-2 font-semibold truncate">{hint}</div>}
              </div>
              <div className="flex items-center gap-3 sm:gap-4 text-[12.5px] text-ink-2 shrink-0">
                {r.itemCount > 0 && (
                  <span className="tabular-nums">
                    {r.liveCount > 0 ? `${r.liveCount} of ${r.itemCount} live` : `${r.itemCount} account${r.itemCount === 1 ? "" : "s"}`}
                  </span>
                )}
                {r.totalPaise != null && <span className="font-semibold tabular-nums">{rupees(r.totalPaise)}</span>}
                <CampaignStatus status={r.status} />
              </div>
            </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
