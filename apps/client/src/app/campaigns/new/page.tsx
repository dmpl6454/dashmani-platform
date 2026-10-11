"use client";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { todayIST } from "@dashmani/shared/src/utils/date";
import { useAuth } from "@/lib/auth";
import { InfoForm } from "../_steps";
import { StepNav } from "../_step-nav";
import { mutateJson, type Campaign } from "@/lib/campaign";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Step 1 of a new campaign. Saving it creates the draft and moves to the campaign page. */
export default function NewCampaignPage() {
  const router = useRouter();
  const { user } = useAuth();
  // The company the client signed up with is the likeliest brand. An invite-created account
  // carries its email domain as a placeholder company ("acme.com") — don't offer that.
  const company = user?.companyName?.trim() ?? "";
  const placeholder = !!user && company.toLowerCase() === (user.email.split("@")[1] ?? "").toLowerCase();
  const real = company.length >= 2 && !placeholder;
  const [yy, mm] = todayIST().split("-");
  const monthLabel = `${MONTHS[Number(mm) - 1]} ${yy}`;

  return (
    <>
      <Topstrip title="Start a campaign" sub="Step 1 of 4 · Campaign details" />
      <div className="px-4 sm:px-6 py-6 max-w-[760px] mx-auto w-full flex-1 overflow-y-auto">
        <StepNav current="info" reached={{ info: true, creative: false, accounts: false, pay: false }} />
        <InfoForm
          // Remount once the session is read, so the prefill lands in the fields.
          key={user?.id ?? "anon"}
          initial={real ? { brand: company.slice(0, 200), name: `${company} — ${monthLabel}`.slice(0, 200) } : undefined}
          submitLabel="Continue"
          onSubmit={async (values) => {
            const c = await mutateJson<Campaign>("/client/campaigns", "POST", values);
            router.replace(`/campaigns/${c.id}`);
          }}
        />
      </div>
    </>
  );
}
