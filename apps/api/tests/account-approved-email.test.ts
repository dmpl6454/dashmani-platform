import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import app from "../src/app";
import { sendEmail } from "../src/services/email.service";
import { createTestUser, createTestRole, generateToken } from "./helpers";

const sendMock = vi.mocked(sendEmail);

/** The approval email is fire-and-forget; let it settle before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 50));

function approvalEmailsTo(email: string) {
  return sendMock.mock.calls.filter(
    ([o]) => o.to === email && o.subject.includes("account is approved"),
  );
}

describe("account approved email", () => {
  let adminToken: string;

  beforeEach(async () => {
    sendMock.mockClear();
    await createTestRole("Admin", [
      { resource: "employees", action: "view", scope: "global" },
      { resource: "employees", action: "create", scope: "global" },
      { resource: "employees", action: "edit", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);
  });

  async function pendingUser(email: string, status: "ONBOARDING" | "INACTIVE" = "ONBOARDING") {
    await createTestRole("Employee", [{ resource: "attendance", action: "view", scope: "own" }]);
    const u = await createTestUser({ email, roleNames: ["Employee"] });
    return prisma.user.update({ where: { id: u.id }, data: { status } });
  }

  it("emails the person when the Employees page sets a pending account Active", async () => {
    const u = await pendingUser("pending1@example.com");
    const res = await request(app)
      .put(`/v1/employees/${u.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "ACTIVE" });
    expect(res.status).toBe(200);
    await settle();
    const calls = approvalEmailsTo("pending1@example.com");
    expect(calls).toHaveLength(1);
    expect(calls[0][0].html).toContain("/login");
  });

  it("emails the person when approved through /admin/employees/:id/approve", async () => {
    const u = await pendingUser("pending2@example.com");
    const res = await request(app)
      .put(`/v1/admin/employees/${u.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    await settle();
    expect(approvalEmailsTo("pending2@example.com")).toHaveLength(1);
  });

  it("emails the person when an admin invite approves their pending account", async () => {
    await pendingUser("pending3@example.com");
    const res = await request(app)
      .post("/v1/admin/users/invite")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "pending3@example.com" });
    expect(res.status).toBe(200);
    await settle();
    expect(approvalEmailsTo("pending3@example.com")).toHaveLength(1);
  });

  it("does not email when an INACTIVE account is reactivated", async () => {
    const u = await pendingUser("inactive@example.com", "INACTIVE");
    const res = await request(app)
      .put(`/v1/employees/${u.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "ACTIVE" });
    expect(res.status).toBe(200);
    await settle();
    expect(approvalEmailsTo("inactive@example.com")).toHaveLength(0);
  });

  it("does not email when an already-active account is saved", async () => {
    const u = await pendingUser("active@example.com");
    await prisma.user.update({ where: { id: u.id }, data: { status: "ACTIVE" } });
    const res = await request(app)
      .put(`/v1/employees/${u.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "ACTIVE", name: "Renamed" });
    expect(res.status).toBe(200);
    await settle();
    expect(approvalEmailsTo("active@example.com")).toHaveLength(0);
  });

  it("still approves when the email fails to send", async () => {
    sendMock.mockRejectedValueOnce(new Error("smtp down"));
    const u = await pendingUser("smtpdown@example.com");
    const res = await request(app)
      .put(`/v1/employees/${u.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "ACTIVE" });
    expect(res.status).toBe(200);
    await settle();
    const row = await prisma.user.findUnique({ where: { id: u.id } });
    expect(row?.status).toBe("ACTIVE");
  });
});
