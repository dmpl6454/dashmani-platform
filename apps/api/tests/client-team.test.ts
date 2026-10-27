/**
 * Team logins on the client portal: more than one person signs in as the same client company.
 * Invite → join → same company data; the owner alone manages the team; a disabled login loses
 * access on its next request; one email signs in to one place; member password reset; the sales
 * portal manages the same logins.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { hash } from "bcrypt";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { sendEmail } from "../src/services/email.service";
import { createTestRole, createTestUser, generateToken } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const tokenFrom = (url: string) => new URL(url).searchParams.get("token")!;

describe("client team logins", () => {
  let ownerTok: string;
  let clientId: string;

  beforeEach(async () => {
    vi.mocked(sendEmail).mockClear();
    const c = await prisma.client.create({
      data: { companyName: "Acme Studios", contactName: "Asha", email: "owner@acme.test", passwordHash: await hash("Owner#12345", 4), status: "ACTIVE" },
    });
    clientId = c.id;
    const login = await request(app).post("/v1/client/auth/login").send({ email: "owner@acme.test", password: "Owner#12345" });
    expect(login.status).toBe(200);
    expect(login.body.data.user).toMatchObject({ role: "owner", companyName: "Acme Studios" });
    ownerTok = login.body.data.accessToken;
  });

  async function inviteAndJoin(email = "ravi@acme.test", name = "Ravi") {
    const inv = await request(app).post("/v1/client/team").set(auth(ownerTok)).send({ email, name });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.data.member).toMatchObject({ email, name, status: "invited", role: "member", invitedBy: "Asha (account owner)" });
    expect(inv.body.data.emailed).toBe(true);
    const token = tokenFrom(inv.body.data.inviteUrl);
    const join = await request(app).post("/v1/client/auth/join").send({ token, password: "Member#12345" });
    expect(join.status, JSON.stringify(join.body)).toBe(201);
    return { memberId: inv.body.data.member.id, token, session: join.body.data };
  }

  it("invite emails a one-time link; joining signs the person in as the same company", async () => {
    const { token, session } = await inviteAndJoin();
    expect(vi.mocked(sendEmail).mock.calls[0][0]).toMatchObject({ to: "ravi@acme.test", subject: "You're invited to Acme Studios on Digital Sukoon" });
    expect(session.user).toMatchObject({ id: clientId, email: "ravi@acme.test", name: "Ravi", role: "member", companyName: "Acme Studios" });

    // Same company data: a campaign the owner started is visible to the member.
    await prisma.campaignBooking.create({ data: { clientId, name: "Diwali", brand: "Acme", status: "draft" } });
    const list = await request(app).get("/v1/client/campaigns").set(auth(session.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.data.map((b: { name: string }) => b.name)).toContain("Diwali");

    // The link is one-time, and a password login now works.
    expect((await request(app).post("/v1/client/auth/join").send({ token, password: "Another#123" })).status).toBe(400);
    expect((await request(app).get(`/v1/client/auth/join/${token}`)).status).toBe(400);
    const login = await request(app).post("/v1/client/auth/login").send({ email: "RAVI@acme.test", password: "Member#12345" });
    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe("member");
  });

  it("says when the invite email could not be sent, and still returns the link", async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce(null);
    const inv = await request(app).post("/v1/client/team").set(auth(ownerTok)).send({ email: "nomail@acme.test", name: "No Mail" });
    expect(inv.status).toBe(201);
    expect(inv.body.data.emailed).toBe(false);
    expect((await request(app).get(`/v1/client/auth/join/${tokenFrom(inv.body.data.inviteUrl)}`)).status).toBe(200);
  });

  it("shows the invite before joining, and refuses an expired link", async () => {
    const inv = await request(app).post("/v1/client/team").set(auth(ownerTok)).send({ email: "neha@acme.test", name: "Neha" });
    const token = tokenFrom(inv.body.data.inviteUrl);
    const show = await request(app).get(`/v1/client/auth/join/${token}`);
    expect(show.body.data).toEqual({ email: "neha@acme.test", name: "Neha", companyName: "Acme Studios" });
    await prisma.clientUser.update({ where: { id: inv.body.data.member.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
    const late = await request(app).post("/v1/client/auth/join").send({ token, password: "Member#12345" });
    expect(late.status).toBe(400);
    expect(late.body.error.code).toBe("TOKEN_EXPIRED");
    // A fresh link replaces it and the old one stays dead.
    const re = await request(app).post(`/v1/client/team/${inv.body.data.member.id}/resend`).set(auth(ownerTok));
    expect(re.status).toBe(200);
    expect((await request(app).get(`/v1/client/auth/join/${token}`)).status).toBe(400);
    expect((await request(app).post("/v1/client/auth/join").send({ token: tokenFrom(re.body.data.inviteUrl), password: "Member#12345" })).status).toBe(201);
  });

  it("only the owner manages the team; everyone sees it", async () => {
    const { session, memberId } = await inviteAndJoin();
    const t = session.accessToken;
    const team = await request(app).get("/v1/client/team").set(auth(t));
    expect(team.status).toBe(200);
    expect(team.body.data).toMatchObject({ owner: { email: "owner@acme.test", role: "owner" }, members: [{ email: "ravi@acme.test", status: "active" }], you: memberId });
    expect((await request(app).post("/v1/client/team").set(auth(t)).send({ email: "x@acme.test", name: "Xavier" })).status).toBe(403);
    expect((await request(app).post(`/v1/client/team/${memberId}/disable`).set(auth(t))).status).toBe(403);
    expect((await request(app).delete(`/v1/client/team/${memberId}`).set(auth(t))).status).toBe(403);
  });

  it("disabling a login ends its access on the next request and blocks its refresh", async () => {
    const { session, memberId } = await inviteAndJoin();
    expect((await request(app).get("/v1/client/campaigns").set(auth(session.accessToken))).status).toBe(200);
    expect((await request(app).post(`/v1/client/team/${memberId}/disable`).set(auth(ownerTok))).status).toBe(200);
    expect((await request(app).get("/v1/client/campaigns").set(auth(session.accessToken))).status).toBe(401);
    expect((await request(app).post("/v1/client/auth/refresh").send({ refreshToken: session.refreshToken })).status).toBe(401);
    expect((await request(app).post("/v1/client/auth/login").send({ email: "ravi@acme.test", password: "Member#12345" })).status).toBe(403);
    // Back on: a new sign-in works, the old session does not come back.
    expect((await request(app).post(`/v1/client/team/${memberId}/enable`).set(auth(ownerTok))).body.data.status).toBe("active");
    expect((await request(app).get("/v1/client/campaigns").set(auth(session.accessToken))).status).toBe(401);
    expect((await request(app).post("/v1/client/auth/login").send({ email: "ravi@acme.test", password: "Member#12345" })).status).toBe(200);
    // Removed: gone for good.
    expect((await request(app).delete(`/v1/client/team/${memberId}`).set(auth(ownerTok))).status).toBe(200);
    expect((await request(app).post("/v1/client/auth/login").send({ email: "ravi@acme.test", password: "Member#12345" })).status).toBe(401);
  });

  it("a member's refresh rotates, and signing out ends only that person's sessions", async () => {
    const { session } = await inviteAndJoin();
    const ownerLogin = await request(app).post("/v1/client/auth/login").send({ email: "owner@acme.test", password: "Owner#12345" });
    const r = await request(app).post("/v1/client/auth/refresh").send({ refreshToken: session.refreshToken });
    expect(r.status).toBe(200);
    expect((await request(app).get("/v1/client/team").set(auth(r.body.data.accessToken))).body.data.you).not.toBe("owner");
    expect((await request(app).post("/v1/client/auth/logout").set(auth(r.body.data.accessToken))).status).toBe(200);
    expect((await request(app).post("/v1/client/auth/refresh").send({ refreshToken: r.body.data.refreshToken })).status).toBe(401);
    expect((await request(app).post("/v1/client/auth/refresh").send({ refreshToken: ownerLogin.body.data.refreshToken })).status).toBe(200);
  });

  it("one email signs in to one place", async () => {
    await prisma.client.create({ data: { companyName: "Other", contactName: "O", email: "other@x.test", passwordHash: "x" } });
    const dup = await request(app).post("/v1/client/team").set(auth(ownerTok)).send({ email: "Other@X.test", name: "Olga" });
    expect(dup.status).toBe(409);
    expect((await request(app).post("/v1/client/team").set(auth(ownerTok)).send({ email: "owner@acme.test", name: "Asha" })).status).toBe(409);
    await inviteAndJoin("ravi@acme.test");
    const signup = await request(app).post("/v1/client/auth/signup").send({ companyName: "Ravi Co", contactName: "Ravi", email: "ravi@acme.test", password: "Signup#12345" });
    expect(signup.status).toBe(409);
    // "_" is a literal, not a wildcard: rxvi@acme.test is a different address.
    expect((await request(app).post("/v1/client/team").set(auth(ownerTok)).send({ email: "r_vi@acme.test", name: "Rita" })).status).toBe(201);
  });

  it("a member resets their own password; their old sessions end", async () => {
    const { session } = await inviteAndJoin();
    vi.mocked(sendEmail).mockClear();
    expect((await request(app).post("/v1/client/auth/forgot-password").send({ email: "ravi@acme.test" })).status).toBe(200);
    const html = vi.mocked(sendEmail).mock.calls[0][0].html as string;
    const token = /token=([a-f0-9]{64})/.exec(html)![1];
    expect((await request(app).post("/v1/client/auth/reset-password").send({ token, newPassword: "Fresh#123456" })).status).toBe(200);
    expect((await request(app).get("/v1/client/campaigns").set(auth(session.accessToken))).status).toBe(401);
    expect((await request(app).post("/v1/client/auth/login").send({ email: "ravi@acme.test", password: "Fresh#123456" })).status).toBe(200);
    expect((await request(app).post("/v1/client/auth/reset-password").send({ token, newPassword: "Again#123456" })).status).toBe(400);
  });

  it("sales staff see and manage a client's logins; other staff cannot", async () => {
    await createTestRole("Sales", ["view", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const u = await createTestUser({ name: "Priya", roleNames: ["Sales"] });
    const staff = generateToken(u.id, u.email, ["Sales"]);
    const add = await request(app).post(`/v1/sales/clients/${clientId}/logins`).set(auth(staff)).send({ email: "meera@acme.test", name: "Meera" });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.data.member.invitedBy).toBe("Priya (Digital Sukoon)");
    const list = await request(app).get(`/v1/sales/clients/${clientId}/logins`).set(auth(staff));
    expect(list.body.data.members.map((m: { email: string }) => m.email)).toEqual(["meera@acme.test"]);
    expect((await request(app).post(`/v1/sales/clients/${clientId}/logins/${add.body.data.member.id}/disable`).set(auth(staff))).body.data.status).toBe("disabled");
    const other = await createTestUser({ email: "plain@ds.test" });
    expect((await request(app).get(`/v1/sales/clients/${clientId}/logins`).set(auth(generateToken(other.id, other.email, [])))).status).toBe(403);
    // A client token cannot reach the staff routes, and staff cannot reach another company's login.
    expect((await request(app).get(`/v1/sales/clients/${clientId}/logins`).set(auth(ownerTok))).status).toBe(403);
    const elsewhere = await prisma.client.create({ data: { companyName: "Else", contactName: "E", email: "else@x.test", passwordHash: "x" } });
    expect((await request(app).delete(`/v1/sales/clients/${elsewhere.id}/logins/${add.body.data.member.id}`).set(auth(staff))).status).toBe(404);
  });
});
