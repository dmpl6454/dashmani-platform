"use client";
import { mutate } from "swr";
import type { ImportFieldKey, ImportView } from "@/lib/sales-types";

// Small helpers shared by the Swipe import screens (spec-import §5).

/** After apply, undo or discard: every list that could show an imported document or client. */
export async function invalidateAfterImport() {
  const prefixes = ["/sales/invoices", "/sales/payments", "/sales/dashboard", "/sales/clients", "/sales/imports"];
  await mutate((key) => typeof key === "string" && prefixes.some((p) => key.startsWith(p)), undefined, { revalidate: true });
}

export const int = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-IN");

/** The import fields, grouped the way the Columns card shows them. */
export const FIELD_GROUPS: Array<{ title: string; fields: Array<[ImportFieldKey, string]> }> = [
  { title: "Invoice", fields: [["number", "Invoice number"], ["issueDate", "Invoice date"], ["dueDate", "Due date"], ["docType", "Document type"], ["status", "Status"], ["sellerGstin", "Billed-from GSTIN"], ["placeOfSupply", "Place of supply"], ["poNumber", "PO number"], ["poDate", "PO date"], ["notes", "Notes"], ["irn", "IRN"]] },
  { title: "Customer", fields: [["customerName", "Customer name"], ["customerGstin", "Customer GSTIN"], ["customerAddress", "Address"], ["customerCity", "City"], ["customerState", "State"], ["customerPincode", "PIN code"], ["customerEmail", "Email"]] },
  { title: "Lines", fields: [["itemName", "Item"], ["itemDescription", "Item description"], ["hsnSac", "HSN/SAC"], ["quantity", "Quantity"], ["rate", "Rate"], ["lineDiscount", "Item discount"], ["gstRate", "GST rate"]] },
  { title: "Amounts", fields: [["taxable", "Taxable value"], ["discount", "Discount"], ["cgst", "CGST"], ["sgst", "SGST"], ["igst", "IGST"], ["totalTax", "Total tax"], ["cess", "Cess"], ["tcs", "TCS"], ["roundOff", "Round off"], ["total", "Invoice total"]] },
  { title: "Payment", fields: [["amountPaid", "Amount paid"], ["tds", "TDS"], ["balance", "Balance"], ["paidOn", "Paid on"]] },
];
export const REQUIRED_FIELDS = new Set<ImportFieldKey>(["number", "issueDate", "customerName"]);

/** The step the import is on: 1 Columns · 2 Check · 3 Import · 4 Report. */
export function stepOf(v: Pick<ImportView, "status" | "summary">): 1 | 2 | 3 | 4 {
  if (v.status === "applied" || v.status === "undone") return 4;
  if (v.status === "applying" || v.status === "failed") return 3;
  return v.summary?.blockers.some((b) => b.code === "REQUIRED_FIELD_UNMAPPED") ? 1 : 2;
}
