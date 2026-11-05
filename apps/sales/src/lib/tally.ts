"use client";
import { mutate } from "swr";

/** After any Tally mutation: refetch every /sales/tally* key (previews, runs, parties, document badges). */
export const refreshTally = () => mutate((k) => typeof k === "string" && k.startsWith("/sales/tally"), undefined, { revalidate: true });
