"use client";
/**
 * /pipeline/chat?id=<conversationId> — one channel or DM (&m=<messageId>&t=<rootId> deep links).
 * Without an id: the chat list — team-wide channels and direct messages (campaign channels
 * live inside each campaign). Static export: no [id] route.
 */
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { ConversationPage } from "@/components/pipeline/chat/ConversationPage";
import { ChatSidebar } from "@/components/pipeline/chat/ChatSidebar";
import { GateScreen } from "@/components/pipeline/header/GateScreen";
import { PipelineHeader } from "@/components/pipeline/header/PipelineHeader";

function Route() {
  const id = useSearchParams().get("id");
  if (id) return <ConversationPage key={id} id={id} />;
  return (
    <div className="flex flex-col min-h-0 flex-1 min-w-0">
      <PipelineHeader
        title="Chat"
        left={
          <Link href="/pipeline" aria-label="Back to the board" className="h-11 w-11 -ml-1 grid place-items-center text-ink-3 hover:bg-muted">
            <ChevronLeft size={20} />
          </Link>
        }
      />
      <div className="pl-scroll flex-1">
        <div className="max-w-xl mx-auto w-full">
          <ChatSidebar variant="page" />
        </div>
      </div>
    </div>
  );
}

export default function PipelineChatRoute() {
  return (
    <Suspense fallback={<GateScreen kind="loading" />}>
      <Route />
    </Suspense>
  );
}
