"use client";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, Empty } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";

export default function FilesPage() {
  const router = useRouter();
  return (
    <>
      <Topstrip title="Files" sub="Coming soon" />
      <div className="p-6 flex-1 grid place-items-center">
        <div className="text-center max-w-md">
          <Empty
            icon={<Icon.File size={22}/>}
            title="Files — outside this round"
            hint="The v2 redesign focuses on the five screens called out in the audit: Home, Projects, Content, Content detail, and Approvals. Files lands in the next pass."
            cta={<Button variant="default" size="sm" onClick={() => router.push("/dashboard")} iconRight={<Icon.ArrowRight size={14}/>}>Back to Home</Button>}
          />
        </div>
      </div>
    </>
  );
}
