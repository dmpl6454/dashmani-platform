"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Plus, X, RotateCcw, Trash2, Pencil } from "lucide-react";
import { toTitleCase } from "@dashmani/shared";
import Link from "next/link";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { ModalPortal } from "@/components/modal-portal";

const DEVICE_TYPES = ["LAPTOP", "PHONE", "TABLET", "MONITOR", "KEYBOARD", "MOUSE", "HEADSET", "OTHER"];
const TYPE_LABEL: Record<string, string> = {
  LAPTOP: "Laptop", PHONE: "Phone", TABLET: "Tablet", MONITOR: "Monitor",
  KEYBOARD: "Keyboard", MOUSE: "Mouse", HEADSET: "Headset", OTHER: "Other",
};
// Mockup icon paths, one per device type.
const DICON: Record<string, string> = {
  LAPTOP: "M4 5h16v10H4zM2 19h20",
  PHONE: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2",
  TABLET: "M5 2h14a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2",
  MONITOR: "M3 4h18v12H3zM8 20h8M12 16v4",
  HEADSET: "M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z",
  KEYBOARD: "M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10",
  MOUSE: "M12 2a6 6 0 0 1 6 6v8a6 6 0 0 1-12 0V8a6 6 0 0 1 6-6zM12 6v4",
  OTHER: "M21 16V8l-9-5-9 5v8l9 5zM3.3 7L12 12l8.7-5M12 22V12",
};
const COND_COLOR: Record<string, string> = { New: "var(--hx-00D7A0)", Good: "var(--hx-6EB2FF)", Fair: "var(--hx-E9BD62)", Poor: "var(--hx-FB7185)" };
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const fdY = (v: string) => { const d = new Date(v); return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`; };
const fdS = (v: string) => { const d = new Date(v); return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`; };

function Icon({ d, className = "h-4 w-4" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const BLANK = { employeeId: "", type: "LAPTOP", brand: "", model: "", serialNumber: "", assetTag: "", condition: "Good", notes: "" };
const LABEL = "flex flex-col gap-[7px] text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase min-w-0";
const FIELD =
  "h-[42px] w-full px-3 rounded-[10px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] tracking-normal normal-case font-normal outline-none focus:border-ds-gold placeholder:text-ds-t4 [color-scheme:dark] min-w-0";
const GRID =
  "grid gap-x-3 items-center [grid-template-columns:minmax(180px,22fr)_minmax(140px,18fr)_minmax(130px,16fr)_minmax(76px,9fr)_minmax(92px,11fr)_minmax(110px,12fr)_128px]";
const ROUND_BTN = "h-9 w-9 rounded-full border border-ds-line2 text-ds-t2 grid place-items-center shrink-0 transition-colors";

export default function DevicesPage() {
  usePageTitle("Assigned Devices");
  const { data, isLoading, error, mutate } = useSWR("/admin/devices/all", (url: string) => apiFetch<any>(url));
  // ?limit=500 so the device-assign dropdown lists all employees (API caps at 50 otherwise).
  const { data: employeesData } = useSWR("/employees?limit=500", (url: string) => apiFetch<any>(url));
  const devices: any[] = data?.data || [];
  const employees: any[] = employeesData?.data || [];
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"active" | "returned" | "all">("active");
  const [form, setForm] = useState(BLANK);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "return" | "delete"; device: any } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const filteredDevices = devices.filter((d: any) => {
    if (filter === "active") return !d.returnedAt;
    if (filter === "returned") return !!d.returnedAt;
    return true;
  });

  const activeCount = devices.filter((d: any) => !d.returnedAt).length;
  const laptopCount = devices.filter((d: any) => d.type === "LAPTOP" && !d.returnedAt).length;
  const phoneCount = devices.filter((d: any) => d.type === "PHONE" && !d.returnedAt).length;
  const loaded = !!data;

  useEffect(() => {
    if (!showForm && !confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirm && !busy) setConfirm(null);
      else if (showForm && !saving) setShowForm(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showForm, confirm, busy, saving]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      if (editingId) {
        await apiFetch(`/admin/devices/${editingId}`, { method: "PUT", body: JSON.stringify(form) });
      } else {
        await apiFetch("/admin/devices", { method: "POST", body: JSON.stringify(form) });
      }
      setShowForm(false);
      setEditingId(null);
      setForm(BLANK);
      mutate();
    } catch (err: any) {
      setFormError(err.message || "Failed to save the device");
    } finally {
      setSaving(false);
    }
  }

  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    setActionError("");
    try {
      if (confirm.kind === "return") await apiFetch(`/admin/devices/${confirm.device.id}/return`, { method: "POST" });
      else await apiFetch(`/admin/devices/${confirm.device.id}`, { method: "DELETE" });
      mutate();
      setConfirm(null);
    } catch (err: any) {
      setActionError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(device: any) {
    setForm({
      employeeId: device.employeeId,
      type: device.type,
      brand: device.brand,
      model: device.model,
      serialNumber: device.serialNumber || "",
      assetTag: device.assetTag || "",
      condition: device.condition || "Good",
      notes: device.notes || "",
    });
    setEditingId(device.id);
    setFormError("");
    setShowForm(true);
  }

  // Brand is title-cased; the model is shown exactly as entered ("iPad Air (M2)", "WH-1000XM5").
  const deviceName = (d: any) => `${toTitleCase(d.brand)} ${d.model ?? ""}`.trim();
  const editingDevice = editingId ? devices.find((d) => d.id === editingId) : null;

  const stats = [
    { label: "Active Devices", value: activeCount, color: "var(--hx-00D7A0)", d: DICON.OTHER },
    { label: "Laptops", value: laptopCount, color: "var(--hx-E9BD62)", d: DICON.LAPTOP },
    { label: "Phones", value: phoneCount, color: "var(--hx-6EB2FF)", d: DICON.PHONE },
    { label: "Total (incl. returned)", value: devices.length, color: "var(--hx-9B7EDE)", d: "M4 6h16M4 12h16M4 18h16" },
  ];
  const tabs = [
    { key: "active" as const, label: "Active", n: activeCount },
    { key: "returned" as const, label: "Returned", n: devices.length - activeCount },
    { key: "all" as const, label: "All", n: devices.length },
  ];

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-center justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_320px] min-w-0">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Assigned Devices</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">Track laptops, phones, and other devices assigned to employees</p>
        </div>
        <button
          type="button"
          onClick={() => { setShowForm(true); setEditingId(null); setForm(BLANK); setFormError(""); }}
          className="inline-flex items-center gap-2 h-[46px] px-[22px] rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[14px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)]"
        >
          <Plus className="h-[15px] w-[15px]" strokeWidth={2.4} /> Assign Device
        </button>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="flex items-start justify-between gap-2.5 px-5 py-[18px] rounded-[16px] bg-ds-card border border-[color:var(--hx-2A4658)] min-w-0">
            <span className="leading-[1.15] min-w-0">
              <span className="block text-[12px] font-semibold text-ds-t2 leading-[1.35] [text-wrap:balance]">{s.label}</span>
              <span className="block mt-3 text-[32px] font-bold tracking-[-.04em] tabular-nums text-ds-text">
                {loaded ? String(s.value).padStart(2, "0") : "—"}
              </span>
            </span>
            <span className="h-9 w-9 rounded-[10px] grid place-items-center shrink-0" style={{ background: rgba(s.color, 0.12), color: s.color }}>
              <Icon d={s.d} />
            </span>
          </div>
        ))}
      </section>

      {/* Filters */}
      <section className="flex items-center gap-3 flex-wrap mt-[22px]">
        <div className="flex gap-1 p-[5px] rounded-full bg-ds-inset border border-ds-line2 max-w-full overflow-x-auto" role="tablist" aria-label="Device status">
          {tabs.map((t) => {
            const on = filter === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setFilter(t.key)}
                className={`inline-flex items-center gap-2 h-9 px-[18px] rounded-full text-[13px] font-semibold whitespace-nowrap transition-colors ${on ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "text-ds-t2 hover:text-ds-text"}`}
              >
                {t.label}
                {loaded && <span className={`text-[11px] font-semibold ${on ? "text-[rgba(6,13,20,.6)]" : "text-ds-t3"}`}>{t.n}</span>}
              </button>
            );
          })}
        </div>
        {loaded && (
          <span className="ml-auto text-[12px] text-ds-t3 whitespace-nowrap">
            {filteredDevices.length} {filteredDevices.length === 1 ? "device" : "devices"}
          </span>
        )}
      </section>

      {actionError && !confirm && (
        <div className="mt-3.5 px-3.5 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px] flex items-center justify-between gap-3">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError("")} aria-label="Dismiss" className="shrink-0 hover:text-ds-text"><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Devices List */}
      <section className="mt-[18px] rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)]">
        <div className="overflow-x-auto">
          <div className="min-w-[960px]">
            <div className={`${GRID} h-[52px] px-5 bg-ds-inset border-b border-ds-line2 text-[10.5px] font-semibold tracking-[.08em] uppercase text-ds-t3 whitespace-nowrap`}>
              <span>Device</span><span>Employee</span><span>Serial / Tag</span><span>Condition</span><span>Assigned</span><span>Status</span>
              <span className="text-right">Actions</span>
            </div>
            {isLoading && !data ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`${GRID} h-[76px] px-5 border-b border-[color:var(--hx-132430)]`}>
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-[11px] bg-ds-hover motion-safe:animate-pulse" />
                    <div className="h-3.5 w-32 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                  </div>
                </div>
              ))
            ) : error ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">Devices couldn&apos;t be loaded just now. Refresh to try again.</div>
            ) : filteredDevices.length === 0 ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">
                <Icon d={DICON.LAPTOP} className="h-[30px] w-[30px] mx-auto mb-2.5 opacity-50" />
                No devices found
              </div>
            ) : (
              filteredDevices.map((device: any) => {
                const cc = COND_COLOR[device.condition] ?? "var(--hx-A7B3C2)";
                const returned = !!device.returnedAt;
                const sc = returned ? "var(--hx-738395)" : "var(--hx-00D7A0)";
                return (
                  <div
                    key={device.id}
                    className={`${GRID} min-h-[80px] py-3 px-5 border-b border-[color:var(--hx-132430)] last:border-b-0 text-[13.5px] tabular-nums hover:bg-[color:var(--hx-0A1620)] transition-colors ${returned ? "opacity-[.78]" : ""}`}
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="h-10 w-10 rounded-[11px] bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.28)] text-ds-gold grid place-items-center shrink-0">
                        <Icon d={DICON[device.type] ?? DICON.OTHER} className="h-[18px] w-[18px]" />
                      </span>
                      <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
                        <span className="text-[14.5px] font-semibold text-ds-text truncate" title={deviceName(device)}>{deviceName(device)}</span>
                        <span className="text-[11px] font-semibold tracking-[.08em] text-ds-t3">{device.type}</span>
                      </span>
                    </span>
                    <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
                      {device.employee ? (
                        <>
                          <Link href={`/employees/${device.employee.id}`} className="font-semibold text-[color:var(--hx-E3E8EE)] truncate hover:text-ds-gold">
                            {toTitleCase(device.employee.name)}
                          </Link>
                          <span className="text-[11.5px] text-ds-t3">ID: {device.employee.id.slice(0, 8)}</span>
                        </>
                      ) : (
                        <span className="text-[color:var(--hx-4A6275)]">—</span>
                      )}
                    </span>
                    <span className="flex flex-col gap-[3px] min-w-0 leading-[1.25] text-[12px] text-ds-t2">
                      {device.serialNumber && (
                        <span className="truncate"><span className="text-ds-t3">S/N</span> <span className="font-mono text-ds-t5">{device.serialNumber}</span></span>
                      )}
                      {device.assetTag && (
                        <span className="truncate"><span className="text-ds-t3">Tag</span> <span className="font-mono text-ds-t5">{device.assetTag}</span></span>
                      )}
                      {!device.serialNumber && !device.assetTag && <span className="text-[color:var(--hx-4A6275)]">—</span>}
                    </span>
                    <span>
                      <span className="inline-flex items-center h-[26px] px-[11px] rounded-full text-[11.5px] font-semibold whitespace-nowrap" style={{ background: rgba(cc, 0.12), color: cc }}>
                        {device.condition || "—"}
                      </span>
                    </span>
                    <span className="text-ds-t5 whitespace-nowrap">{device.assignedAt ? fdY(device.assignedAt) : "—"}</span>
                    <span>
                      <span
                        className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border text-[12px] font-semibold whitespace-nowrap"
                        style={{ background: rgba(sc, 0.1), borderColor: rgba(sc, 0.3), color: sc }}
                      >
                        <i className="h-[5px] w-[5px] rounded-full" style={{ background: sc }} />
                        {returned ? `Returned ${fdS(device.returnedAt)}` : "Active"}
                      </span>
                    </span>
                    <span className="flex items-center justify-end gap-1.5">
                      <button type="button" onClick={() => startEdit(device)} title="Edit" aria-label={`Edit ${deviceName(device)}`} className={`${ROUND_BTN} hover:text-ds-gold hover:border-[rgba(233,189,98,.5)]`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {!returned && (
                        <button type="button" onClick={() => { setActionError(""); setConfirm({ kind: "return", device }); }} title="Mark Returned" aria-label={`Mark ${deviceName(device)} returned`} className={`${ROUND_BTN} hover:text-[color:var(--hx-6EB2FF)] hover:border-[rgba(110,178,255,.5)]`}>
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button type="button" onClick={() => { setActionError(""); setConfirm({ kind: "delete", device }); }} title="Delete" aria-label={`Delete ${deviceName(device)}`} className={`${ROUND_BTN} hover:text-[color:var(--hx-FB7185)] hover:border-[rgba(229,72,77,.5)]`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>

      {/* Add/Edit Form Modal */}
      {showForm && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.7)]" onClick={() => !saving && setShowForm(false)}>
              <form
                onSubmit={handleSubmit}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={editingId ? "Edit Device" : "Assign New Device"}
                className="relative w-full max-w-[520px] max-h-full overflow-y-auto bg-ds-card border border-ds-line2 rounded-[16px] p-6 shadow-[0_20px_50px_rgba(0,0,0,.6)] flex flex-col gap-4"
              >
                <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
                <div className="flex items-center justify-between">
                  <span className="text-[16px] font-semibold text-ds-text">{editingId ? "Edit Device" : "Assign New Device"}</span>
                  <button type="button" onClick={() => setShowForm(false)} disabled={saving} aria-label="Close" className="text-ds-t3 hover:text-ds-text">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {editingId ? (
                  <div className="text-[12.5px] text-ds-t2">
                    Assigned to <b className="text-ds-text font-semibold">{editingDevice?.employee ? toTitleCase(editingDevice.employee.name) : "—"}</b>
                  </div>
                ) : (
                  <label className={LABEL}>
                    <span>Employee<span className="text-ds-gold ml-[3px]">*</span></span>
                    <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} required className={`${FIELD} cursor-pointer`}>
                      <option value="" className="bg-ds-card">Select Employee</option>
                      {employees.map((emp: any) => <option key={emp.id} value={emp.id} className="bg-ds-card">{emp.name} — {emp.email}</option>)}
                    </select>
                  </label>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <label className={LABEL}>
                    <span>Type</span>
                    <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={`${FIELD} cursor-pointer`}>
                      {DEVICE_TYPES.map((t) => <option key={t} value={t} className="bg-ds-card">{TYPE_LABEL[t]}</option>)}
                    </select>
                  </label>
                  <label className={LABEL}>
                    <span>Condition</span>
                    <select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })} className={`${FIELD} cursor-pointer`}>
                      {["New", "Good", "Fair", "Poor"].map((c) => <option key={c} value={c} className="bg-ds-card">{c}</option>)}
                    </select>
                  </label>
                  <label className={LABEL}>
                    <span>Brand<span className="text-ds-gold ml-[3px]">*</span></span>
                    <input type="text" placeholder="e.g., Apple" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} required className={FIELD} />
                  </label>
                  <label className={LABEL}>
                    <span>Model<span className="text-ds-gold ml-[3px]">*</span></span>
                    <input type="text" placeholder='e.g., MacBook Pro 14"' value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} required className={FIELD} />
                  </label>
                  <label className={LABEL}>
                    <span>Serial Number</span>
                    <input type="text" placeholder="Optional" value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} className={FIELD} />
                  </label>
                  <label className={LABEL}>
                    <span>Asset Tag</span>
                    <input type="text" placeholder="Optional" value={form.assetTag} onChange={(e) => setForm({ ...form, assetTag: e.target.value })} className={FIELD} />
                  </label>
                </div>
                <label className={LABEL}>
                  <span>Notes</span>
                  <textarea placeholder="Optional" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className={`${FIELD} h-auto py-2.5 resize-y`} />
                </label>
                {formError && (
                  <div className="px-3 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12px]">{formError}</div>
                )}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setShowForm(false)} disabled={saving} className="h-10 px-[18px] rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold hover:text-ds-text disabled:opacity-50">
                    Cancel
                  </button>
                  <button type="submit" disabled={saving} className="h-10 px-5 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13px] font-bold hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60">
                    {saving ? "Saving..." : editingId ? "Update Device" : "Assign Device"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* Return / delete confirmation */}
      {confirm && (() => {
        const isReturn = confirm.kind === "return";
        const color = isReturn ? "var(--hx-6EB2FF)" : "var(--hx-FB7185)";
        const who = confirm.device.employee ? toTitleCase(confirm.device.employee.name) : "the employee";
        return (
          <ModalPortal>
            <div className="ds-root contents">
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.7)]" onClick={() => !busy && setConfirm(null)}>
                <div
                  onClick={(e) => e.stopPropagation()}
                  role="alertdialog"
                  aria-modal="true"
                  aria-label={isReturn ? "Mark this device as returned?" : "Delete this device record permanently?"}
                  className="w-full max-w-[380px] bg-ds-card border border-ds-line2 rounded-[16px] p-6 shadow-[0_20px_50px_rgba(0,0,0,.6)]"
                >
                  <div className="h-10 w-10 rounded-[11px] grid place-items-center" style={{ background: rgba(color, 0.12), color }}>
                    {isReturn ? <RotateCcw className="h-[17px] w-[17px]" /> : <Trash2 className="h-[17px] w-[17px]" />}
                  </div>
                  <div className="mt-3.5 text-[15px] font-semibold text-ds-text">
                    {isReturn ? "Mark this device as returned?" : "Delete this device record permanently?"}
                  </div>
                  <div className="mt-1.5 text-[12.5px] leading-[1.5] text-ds-t2">
                    {isReturn
                      ? `${deviceName(confirm.device)} will be marked as returned by ${who} today.`
                      : `${deviceName(confirm.device)} (${who}) will be removed. This cannot be undone.`}
                  </div>
                  {actionError && (
                    <div className="mt-3.5 px-3 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12px]">{actionError}</div>
                  )}
                  <div className="flex justify-end gap-2 mt-[22px]">
                    <button type="button" onClick={() => setConfirm(null)} disabled={busy} className="h-[38px] px-4 rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold hover:text-ds-text disabled:opacity-50">
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={runConfirm}
                      disabled={busy}
                      className={`h-[38px] px-[18px] rounded-full text-white text-[13px] font-bold disabled:opacity-60 ${isReturn ? "bg-ds-blue" : "bg-[color:var(--hx-E5484D)]"}`}
                    >
                      {busy ? "Working..." : isReturn ? "Mark Returned" : "Delete"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </ModalPortal>
        );
      })()}
    </div>
  );
}
