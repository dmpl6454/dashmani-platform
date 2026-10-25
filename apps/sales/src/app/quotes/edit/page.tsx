"use client";
import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuote } from "@/lib/hooks";
import { DocumentEditor } from "@/components/document-editor";
import { Loading, LoadError, PageHead } from "@/components/sales-ui";

function Editor() {
  const params = useSearchParams();
  const id = params.get("id");
  const clientId = params.get("clientId");
  const { data, error, isLoading, mutate } = useQuote(id);
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (id && (isLoading || !data)) return <Loading />;
  return (
    <>
      <PageHead kicker={<Link href="/quotes" className="hover:text-white">Quotes</Link> as unknown as string} title={data ? `Edit ${data.number}` : "New quote"} />
      <DocumentEditor kind="quote" initial={data} clientIdPreset={clientId} />
    </>
  );
}

export default function QuoteEditPage() {
  return <Suspense fallback={<Loading />}><Editor /></Suspense>;
}
