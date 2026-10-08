"use client";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { InfoForm } from "../_steps";
import { mutateJson, type Campaign } from "@/lib/campaign";

/** Step 1 of a new campaign. Saving it creates the draft and moves to the campaign page. */
export default function NewCampaignPage() {
  const router = useRouter();
  return (
    <>
      <Topstrip title="Start a campaign" sub="Step 1 of 4 · Campaign details" />
      <div className="px-4 sm:px-6 py-6 max-w-[760px] mx-auto w-full flex-1 overflow-y-auto">
        <InfoForm
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
