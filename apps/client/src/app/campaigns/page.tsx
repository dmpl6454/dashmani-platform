"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, Empty, PageError, Skeleton } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { useCampaigns, rupees } from "@/lib/campaign";
import { CampaignStatus, fmtDate } from "./_ui";

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
              hint="Book promotion on our Instagram, Facebook and YouTube network — pick accounts, upload your creative and pay online."
              cta={<Button size="sm" variant="ink" onClick={() => router.push("/campaigns/new")}>Start a campaign</Button>}
            />
          )}
          {rows.map((r, i) => (
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
          ))}
        </div>
      </div>
    </>
  );
}
