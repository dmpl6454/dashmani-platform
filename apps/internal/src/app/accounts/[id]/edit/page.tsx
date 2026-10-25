"use client";
import { useParams } from "next/navigation";
import { AccountForm } from "@/components/account-form";
import { useAccount } from "@/lib/hooks/use-accounts";
import { BoxesLoader } from "@/components/boxes-loader";

export default function EditAccountPage() {
  const { id } = useParams();
  const { data, isLoading } = useAccount(id as string);
  const account = (data as any)?.data;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BoxesLoader />
      </div>
    );
  }
  if (!account) {
    return <div className="text-[12.5px] text-ds-t3 text-center py-12">Account not found</div>;
  }

  return (
    <div className="max-w-2xl pt-[26px] pb-6 crx-animate-fade">
      <AccountForm account={account} />
    </div>
  );
}
