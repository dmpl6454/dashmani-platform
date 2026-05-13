"use client";
import { useParams } from "next/navigation";
import { AccountForm } from "@/components/account-form";
import { useAccount } from "@/lib/hooks/use-accounts";

export default function EditAccountPage() {
  const { id } = useParams();
  const { data, isLoading } = useAccount(id as string);
  const account = (data as any)?.data;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" />
      </div>
    );
  }
  if (!account) {
    return <div className="text-[#7A7A7A] text-center py-8">Account not found</div>;
  }

  return (
    <div className="max-w-2xl crx-animate-fade">
      <AccountForm account={account} />
    </div>
  );
}
