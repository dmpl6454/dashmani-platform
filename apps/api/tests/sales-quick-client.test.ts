/**
 * sales-quick-client.test.ts — quick add (2026-11-26): a client with a name and a contact number,
 * email optional (POST /v1/sales/clients/quick). Without an email `clients.email` is NULL — no
 * made-up address is ever stored (scripts/budget-quick-client-ddl.sql makes the column optional);
 * the first email is added later by any sales user (PUT …/first-email), while an existing email
 * still changes only through the admin route.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";
import { confirmationRecipients } from "../src/services/sales/recon/confirm.service";

let salesToken: string;
let employeeToken: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("sales quick client", () => {
  beforeEach(async () => {
    await createTestRole("Sales", [
      ...["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })),
      { resource: "clients", action: "view", scope: "global" },
    ]);
    await createTestRole("Employee", [{ resource: "attendance", action: "view", scope: "own" }]);
    const sales = await createTestUser({ name: "Sales Person", roleNames: ["Sales"] });
    const emp = await createTestUser({ name: "Plain Employee", roleNames: ["Employee"] });
    salesToken = generateToken(sales.id, sales.email, ["Sales"]);
    employeeToken = generateToken(emp.id, emp.email, ["Employee"]);
  });

  it("adds a client with only a name and a number; it is in the Clients list with no email shown or mailed", async () => {
    const r = await request(app).post("/v1/sales/clients/quick").set(auth(salesToken)).send({ name: "Red Chillies", phone: "98200 12345" });
    expect(r.status).toBe(201);
    expect(r.body.data.companyName).toBe("Red Chillies");
    expect(r.body.data.contactName).toBe("Red Chillies");
    expect(r.body.data.phone).toBe("98200 12345");
    expect(r.body.data.email).toBeNull();
    expect((await prisma.client.findUniqueOrThrow({ where: { id: r.body.data.id } })).email).toBeNull();

    const list = await request(app).get("/v1/sales/clients").set(auth(salesToken));
    expect(list.body.data.some((c: { id: string }) => c.id === r.body.data.id)).toBe(true);

    // Nothing to mail it to: a balance confirmation has no client recipient (and does not throw).
    const to = await confirmationRecipients(r.body.data.id, "dspl");
    expect(to.to).toEqual([]);

    // Two clients without an email never collide on the unique index (NULLs are distinct).
    const second = await request(app).post("/v1/sales/clients/quick").set(auth(salesToken)).send({ name: "Second Co", phone: "9000000000", email: "" });
    expect(second.status).toBe(201);
    expect(second.body.data.email).toBeNull();
  });

  it("keeps an email when one is given, and refuses a used one", async () => {
    const r = await request(app).post("/v1/sales/clients/quick").set(auth(salesToken)).send({ name: "Excel Ent", phone: "9876543210", email: "Ritesh@Excel.test" });
    expect(r.status).toBe(201);
    expect(r.body.data.email).toBe("ritesh@excel.test");
    const dup = await request(app).post("/v1/sales/clients/quick").set(auth(salesToken)).send({ name: "Excel Again", phone: "9876543210", email: "ritesh@excel.test" });
    expect(dup.status).toBe(409);
  });

  it("needs a name and a number, and sales access", async () => {
    expect((await request(app).post("/v1/sales/clients/quick").set(auth(salesToken)).send({ name: "A", phone: "98200 12345" })).status).toBe(400);
    expect((await request(app).post("/v1/sales/clients/quick").set(auth(salesToken)).send({ name: "No Phone" })).status).toBe(400);
    expect((await request(app).post("/v1/sales/clients/quick").set(auth(employeeToken)).send({ name: "Nope Co", phone: "9000000000" })).status).toBe(403);
  });

  it("any sales user adds the FIRST email; a client that already has one is refused", async () => {
    const r = await request(app).post("/v1/sales/clients/quick").set(auth(salesToken)).send({ name: "Later Co", phone: "9000000001" });
    const id = r.body.data.id as string;
    const first = await request(app).put(`/v1/sales/clients/${id}/first-email`).set(auth(salesToken)).send({ email: "hello@later.test" });
    expect(first.status).toBe(200);
    expect(first.body.data.email).toBe("hello@later.test");
    const again = await request(app).put(`/v1/sales/clients/${id}/first-email`).set(auth(salesToken)).send({ email: "other@later.test" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("HAS_EMAIL");
    expect((await prisma.client.findUniqueOrThrow({ where: { id } })).email).toBe("hello@later.test");
  });
});
