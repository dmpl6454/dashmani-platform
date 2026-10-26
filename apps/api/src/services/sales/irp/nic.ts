import crypto from "crypto";
import fs from "fs";
import { IrpError, type IrpProvider, type IrpResult } from "./provider";

/**
 * NIC's e-invoice API (einvoice1.gst.gov.in; sandbox einv-apisandbox.nic.in), direct integration:
 *  - auth  POST /eivital/v1.04/auth — {Data: base64(RSA_PKCS1(base64(JSON{UserName, Password, AppKey, ForceRefreshAccessToken})))}
 *          with NIC's public key; the response's Sek is AES-256-ECB-encrypted with our AppKey.
 *  - every call carries client_id, client_secret, gstin, user_name and AuthToken headers; request
 *    and response Data are AES-256-ECB with the decrypted Sek, base64.
 *  - POST /eicore/v1.03/Invoice (generate), GET .../Invoice/irnbydocdetails (look up),
 *    POST .../Invoice/Cancel. A duplicate submission fails with 2150 and InfoDtls DUPIRN.
 * Credentials: EINVOICE_CLIENT_ID, EINVOICE_CLIENT_SECRET, EINVOICE_PUBLIC_KEY (PEM text or a
 * file path), and per GSTIN EINVOICE_USER_<GSTIN> / EINVOICE_PASSWORD_<GSTIN>. EINVOICE_BASE_URL
 * defaults to the sandbox.
 */
export interface NicConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  publicKeyPem: string;
  credentials: (gstin: string) => { user: string; password: string } | null;
  fetch?: typeof fetch;
}

type Session = { token: string; sek: Buffer; user: string; expiresAt: number };

export function aesEncrypt(key: Buffer, data: Buffer): string {
  const c = crypto.createCipheriv("aes-256-ecb", key, null);
  return Buffer.concat([c.update(data), c.final()]).toString("base64");
}
export function aesDecrypt(key: Buffer, b64: string): Buffer {
  const d = crypto.createDecipheriv("aes-256-ecb", key, null);
  return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]);
}
const istToMs = (s: string) => Date.parse(`${s.replace(" ", "T")}+05:30`);

export class NicIrp implements IrpProvider {
  readonly name = "NIC IRP";
  private sessions = new Map<string, Session>();
  constructor(private cfg: NicConfig) {}

  static fromEnv(): NicIrp | null {
    const e = process.env;
    if (!e.EINVOICE_CLIENT_ID || !e.EINVOICE_CLIENT_SECRET || !e.EINVOICE_PUBLIC_KEY) return null;
    const pem = e.EINVOICE_PUBLIC_KEY.includes("BEGIN") ? e.EINVOICE_PUBLIC_KEY.replace(/\\n/g, "\n") : fs.readFileSync(e.EINVOICE_PUBLIC_KEY, "utf8");
    return new NicIrp({
      baseUrl: (e.EINVOICE_BASE_URL || "https://einv-apisandbox.nic.in").replace(/\/+$/, ""),
      clientId: e.EINVOICE_CLIENT_ID,
      clientSecret: e.EINVOICE_CLIENT_SECRET,
      publicKeyPem: pem,
      credentials: (gstin) => {
        const user = e[`EINVOICE_USER_${gstin}`];
        const password = e[`EINVOICE_PASSWORD_${gstin}`];
        return user && password ? { user, password } : null;
      },
    });
  }

  private get f() {
    return this.cfg.fetch ?? fetch;
  }

  private async session(gstin: string, force = false): Promise<Session> {
    const cached = this.sessions.get(gstin);
    if (!force && cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached;
    const cred = this.cfg.credentials(gstin);
    if (!cred) throw new IrpError(`No e-invoice API user is configured for GSTIN ${gstin} (EINVOICE_USER_${gstin} / EINVOICE_PASSWORD_${gstin})`, "CONFIG");
    const appKey = crypto.randomBytes(32);
    const json = JSON.stringify({ UserName: cred.user, Password: cred.password, AppKey: appKey.toString("base64"), ForceRefreshAccessToken: true });
    const data = crypto.publicEncrypt({ key: this.cfg.publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(Buffer.from(json).toString("base64"))).toString("base64");
    const res = await this.f(`${this.cfg.baseUrl}/eivital/v1.04/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, gstin },
      body: JSON.stringify({ Data: data }),
    });
    const body = (await res.json().catch(() => ({}))) as { Status?: number | string; Data?: { AuthToken: string; Sek: string; TokenExpiry: string }; ErrorDetails?: Array<{ ErrorCode: string; ErrorMessage: string }> };
    if (String(body.Status) !== "1" || !body.Data) {
      const e = body.ErrorDetails?.[0];
      throw new IrpError(`IRP login failed: ${e?.ErrorMessage ?? `HTTP ${res.status}`}`, e?.ErrorCode ?? "AUTH");
    }
    const s: Session = { token: body.Data.AuthToken, sek: aesDecrypt(appKey, body.Data.Sek), user: cred.user, expiresAt: istToMs(body.Data.TokenExpiry) || Date.now() + 5 * 3600_000 };
    this.sessions.set(gstin, s);
    return s;
  }

  private async call<T>(gstin: string, method: "GET" | "POST", path: string, payload?: unknown, retried = false): Promise<T> {
    const s = await this.session(gstin);
    const res = await this.f(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, gstin, user_name: s.user, AuthToken: s.token },
      ...(payload !== undefined ? { body: JSON.stringify({ Data: aesEncrypt(s.sek, Buffer.from(JSON.stringify(payload))) }) } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as {
      Status?: number | string; Data?: string;
      ErrorDetails?: Array<{ ErrorCode: string; ErrorMessage: string }>;
      InfoDtls?: Array<{ InfCd: string; Desc: unknown }>;
    };
    if (String(body.Status) === "1" && typeof body.Data === "string") return JSON.parse(aesDecrypt(s.sek, body.Data).toString("utf8")) as T;
    const err = body.ErrorDetails?.[0];
    // An expired or invalid token: log in again once.
    if (!retried && err && ["1005", "1004"].includes(String(err.ErrorCode))) {
      this.sessions.delete(gstin);
      return this.call<T>(gstin, method, path, payload, true);
    }
    const dup = body.InfoDtls?.find((i) => i.InfCd === "DUPIRN");
    const d = (typeof dup?.Desc === "string" ? JSON.parse(dup.Desc) : dup?.Desc) as { Irn?: string; AckNo?: string | number; AckDt?: string } | undefined;
    throw new IrpError(
      err ? `${err.ErrorMessage} (IRP ${err.ErrorCode})` : `IRP request failed (HTTP ${res.status})`,
      String(err?.ErrorCode ?? res.status),
      d?.Irn ? { irn: d.Irn, ackNo: String(d.AckNo ?? ""), ackDate: d.AckDt ?? "" } : null,
    );
  }

  private toResult(d: { Irn: string; AckNo: string | number; AckDt: string; SignedInvoice: string; SignedQRCode: string }): IrpResult {
    return { irn: d.Irn, ackNo: String(d.AckNo), ackDate: d.AckDt, signedInvoice: d.SignedInvoice, signedQrCode: d.SignedQRCode };
  }

  async generate(gstin: string, payload: unknown): Promise<IrpResult> {
    return this.toResult(await this.call(gstin, "POST", "/eicore/v1.03/Invoice", payload));
  }

  async getByDocument(gstin: string, docType: string, docNumber: string, docDate: string): Promise<IrpResult | null> {
    const q = `doctype=${encodeURIComponent(docType)}&docnum=${encodeURIComponent(docNumber)}&docdate=${encodeURIComponent(docDate)}`;
    try {
      return this.toResult(await this.call(gstin, "GET", `/eicore/v1.03/Invoice/irnbydocdetails?${q}`));
    } catch (e) {
      if (e instanceof IrpError && !["CONFIG", "AUTH"].includes(e.code) && !/^5\d\d$/.test(e.code)) return null; // not registered
      throw e;
    }
  }

  async cancel(gstin: string, irn: string, reason: "1" | "2" | "3" | "4", remark: string): Promise<{ cancelDate: string }> {
    const d = await this.call<{ Irn: string; CancelDate: string }>(gstin, "POST", "/eicore/v1.03/Invoice/Cancel", { Irn: irn, CnlRsn: reason, CnlRem: remark.slice(0, 100) });
    return { cancelDate: d.CancelDate };
  }
}
