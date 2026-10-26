"use client";
import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useOrder } from "@/lib/hooks";
import { DocumentEditor } from "@/components/document-editor";
import { Loading, LoadError, PageHead } from "@/components/sales-ui";

function Editor() {
  const params = useSearchParams();
  const id = params.get("id");
  const clientId = params.get("clientId");
  const { data, error, isLoading, mutate } = useOrder(id);
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (id && (isLoading || !data)) return <Loading />;
  return (
    <>
      <PageHead kicker={<Link href="/orders" className="hover:text-white">Orders</Link> as unknown as string} title={data ? `Edit ${data.number}` : "New order"} />
      <DocumentEditor kind="order" initial={data} clientIdPreset={clientId} />
    </>
  );
}

export default function OrderEditPage() {
  return <Suspense fallback={<Loading />}><Editor /></Suspense>;
}
