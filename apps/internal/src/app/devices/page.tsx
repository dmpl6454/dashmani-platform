"use client";
import { useState } from "react";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import { Laptop, Smartphone, Monitor, Headphones, Plus, X, RotateCcw, Trash2, Edit3 } from "lucide-react";
import { toTitleCase } from "@dashmani/shared";
import Link from "next/link";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const DEVICE_TYPES = ["LAPTOP", "PHONE", "TABLET", "MONITOR", "KEYBOARD", "MOUSE", "HEADSET", "OTHER"];

function deviceIcon(type: string) {
  switch (type) {
    case "LAPTOP": return Laptop;
    case "PHONE": case "TABLET": return Smartphone;
    case "MONITOR": return Monitor;
    case "HEADSET": return Headphones;
    default: return Laptop;
  }
}

export default function DevicesPage() {
  const { data, isLoading, mutate } = useSWR("/admin/devices/all", (url: string) => apiFetch<any>(url));
  // ?limit=500 so the device-assign dropdown lists all employees (API caps at 50 otherwise).
  const { data: employeesData } = useSWR("/employees?limit=500", (url: string) => apiFetch<any>(url));
  const devices = data?.data || [];
  const employees = employeesData?.data || [];
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"active" | "returned" | "all">("active");
  const [form, setForm] = useState({ employeeId: "", type: "LAPTOP", brand: "", model: "", serialNumber: "", assetTag: "", condition: "Good", notes: "" });

  const filteredDevices = devices.filter((d: any) => {
    if (filter === "active") return !d.returnedAt;
    if (filter === "returned") return !!d.returnedAt;
    return true;
  });

  const activeCount = devices.filter((d: any) => !d.returnedAt).length;
  const laptopCount = devices.filter((d: any) => d.type === "LAPTOP" && !d.returnedAt).length;
  const phoneCount = devices.filter((d: any) => d.type === "PHONE" && !d.returnedAt).length;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editingId) {
        await apiFetch(`/admin/devices/${editingId}`, { method: "PUT", body: JSON.stringify(form) });
      } else {
        await apiFetch("/admin/devices", { method: "POST", body: JSON.stringify(form) });
      }
      setShowForm(false);
      setEditingId(null);
      setForm({ employeeId: "", type: "LAPTOP", brand: "", model: "", serialNumber: "", assetTag: "", condition: "Good", notes: "" });
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  async function handleReturn(id: string) {
    if (!confirm("Mark this device as returned?")) return;
    try {
      await apiFetch(`/admin/devices/${id}/return`, { method: "POST" });
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this device record permanently?")) return;
    try {
      await apiFetch(`/admin/devices/${id}`, { method: "DELETE" });
      mutate();
    } catch (e: any) { alert(e.message); }
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
    setShowForm(true);
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-3xl font-light text-[#1A1A1A]">Assigned Devices</h1>
          <p className="text-sm text-[#7A7A7A] mt-1">Track laptops, phones, and other devices assigned to employees</p>
        </div>
        <button onClick={() => { setShowForm(true); setEditingId(null); setForm({ employeeId: "", type: "LAPTOP", brand: "", model: "", serialNumber: "", assetTag: "", condition: "Good", notes: "" }); }} className="flex items-center gap-2 bg-[#1A1A1A] text-white py-2.5 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] transition-all">
          <Plus className="h-4 w-4" /> Assign Device
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-[#E8E0D0] p-4">
          <p className="text-xs text-[#7A7A7A]">Active Devices</p>
          <p className="text-2xl font-semibold text-[#1A1A1A]">{activeCount}</p>
        </div>
        <div className="bg-white rounded-xl border border-[#E8E0D0] p-4">
          <p className="text-xs text-[#7A7A7A]">Laptops</p>
          <p className="text-2xl font-semibold text-[#1A1A1A]">{laptopCount}</p>
        </div>
        <div className="bg-white rounded-xl border border-[#E8E0D0] p-4">
          <p className="text-xs text-[#7A7A7A]">Phones</p>
          <p className="text-2xl font-semibold text-[#1A1A1A]">{phoneCount}</p>
        </div>
        <div className="bg-white rounded-xl border border-[#E8E0D0] p-4">
          <p className="text-xs text-[#7A7A7A]">Total (incl. returned)</p>
          <p className="text-2xl font-semibold text-[#1A1A1A]">{devices.length}</p>
        </div>
      </div>

      {/* Add/Edit Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl shadow-xl border border-[#E8E0D0] w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-[#1A1A1A]">{editingId ? "Edit Device" : "Assign New Device"}</h2>
              <button onClick={() => setShowForm(false)} className="text-[#7A7A7A] hover:text-[#1A1A1A]"><X className="h-5 w-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-3">
              {!editingId && (
                <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} required className={inputClass}>
                  <option value="">Select Employee</option>
                  {employees.map((emp: any) => <option key={emp.id} value={emp.id}>{emp.name} — {emp.email}</option>)}
                </select>
              )}
              <div className="grid grid-cols-2 gap-3">
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={inputClass}>
                  {DEVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })} className={inputClass}>
                  <option value="New">New</option>
                  <option value="Good">Good</option>
                  <option value="Fair">Fair</option>
                  <option value="Poor">Poor</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input type="text" placeholder="Brand (e.g., Apple)" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} required className={inputClass} />
                <input type="text" placeholder="Model (e.g., MacBook Pro 14&quot;)" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} required className={inputClass} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input type="text" placeholder="Serial Number (optional)" value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} className={inputClass} />
                <input type="text" placeholder="Asset Tag (optional)" value={form.assetTag} onChange={(e) => setForm({ ...form, assetTag: e.target.value })} className={inputClass} />
              </div>
              <textarea placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className={inputClass} />
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="px-5 py-2.5 rounded-full text-sm text-[#7A7A7A] hover:bg-[#F5F5F5] transition-colors">Cancel</button>
                <button type="submit" className="bg-[#1A1A1A] text-white px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] transition-all">
                  {editingId ? "Update Device" : "Assign Device"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {(["active", "returned", "all"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${filter === f ? "bg-[#1A1A1A] text-white" : "bg-white text-[#7A7A7A] border border-[#E8E0D0] hover:bg-[#FFF8E1]"}`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Devices List */}
      {isLoading ? (
        <div className="flex items-center justify-center h-40"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div>
      ) : filteredDevices.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-12 text-center">
          <Laptop className="h-12 w-12 mx-auto mb-3 text-[#B0B0B0]" />
          <p className="text-[#7A7A7A] font-medium">No devices found</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Device</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Employee</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Serial / Tag</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Condition</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Assigned</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredDevices.map((device: any) => {
                  const Icon = deviceIcon(device.type);
                  return (
                    <tr key={device.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)]">
                      <td className="p-4">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-lg bg-[#FFF3C4] flex items-center justify-center">
                            <Icon className="h-4 w-4 text-[#B8960C]" />
                          </div>
                          <div>
                            <p className="font-semibold text-[#1A1A1A]">{toTitleCase(device.brand)} {toTitleCase(device.model)}</p>
                            <p className="text-xs text-[#7A7A7A]">{device.type}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-4">
                        <Link href={`/employees/${device.employee.id}`} className="text-[#1A1A1A] font-medium hover:text-blue-600">{toTitleCase(device.employee.name)}</Link>
                        <p className="text-xs text-[#7A7A7A]">ID: {device.employee.id.slice(0, 8)}</p>
                      </td>
                      <td className="p-4 text-[#7A7A7A]">
                        {device.serialNumber && <p className="text-xs">S/N: {device.serialNumber}</p>}
                        {device.assetTag && <p className="text-xs">Tag: {device.assetTag}</p>}
                        {!device.serialNumber && !device.assetTag && "—"}
                      </td>
                      <td className="p-4">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                          device.condition === "New" ? "bg-green-50 text-green-700" :
                          device.condition === "Good" ? "bg-blue-50 text-blue-700" :
                          device.condition === "Fair" ? "bg-yellow-50 text-yellow-700" :
                          "bg-red-50 text-red-700"
                        }`}>{device.condition}</span>
                      </td>
                      <td className="p-4 text-[#7A7A7A] text-xs">{new Date(device.assignedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td>
                      <td className="p-4">
                        {device.returnedAt ? (
                          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">Returned {new Date(device.returnedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                        ) : (
                          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700">Active</span>
                        )}
                      </td>
                      <td className="p-4">
                        <div className="flex gap-1.5">
                          <button onClick={() => startEdit(device)} className="p-1.5 rounded-lg hover:bg-[#FFF3C4] text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors" title="Edit">
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                          {!device.returnedAt && (
                            <button onClick={() => handleReturn(device.id)} className="p-1.5 rounded-lg hover:bg-blue-50 text-[#7A7A7A] hover:text-blue-700 transition-colors" title="Mark Returned">
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button onClick={() => handleDelete(device.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-[#7A7A7A] hover:text-red-600 transition-colors" title="Delete">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
