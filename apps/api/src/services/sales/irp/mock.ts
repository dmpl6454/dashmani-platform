import crypto from "crypto";
import { IrpError, type IrpProvider, type IrpResult } from "./provider";

/**
 * A simulated IRP with the behaviours that matter: unique IRN per (GSTIN, type, number, date),
 * duplicate submission → error 2150 carrying the existing IRN, look-up by document, cancellation
 * once. failNext() makes the next call fail (to test retries). Used by tests and when
 * EINVOICE_PROVIDER=mock in development — never a real registration.
 */
export class MockIrp implements IrpProvider {
  readonly name = "simulated IRP";
  private docs = new Map<string, IrpResult & { cancelled?: boolean }>();
  private failures: Array<{ code: string; message: string; afterRegister?: boolean }> = [];
  calls: string[] = [];

  failNext(code = "9999", message = "IRP unavailable", afterRegister = false) {
    this.failures.push({ code, message, afterRegister });
  }

  private key(gstin: string, type: string, no: string, dt: string) {
    return `${gstin}|${type}|${no}|${dt}`;
  }

  async generate(gstin: string, payload: unknown): Promise<IrpResult> {
    this.calls.push("generate");
    const p = payload as { DocDtls: { Typ: string; No: string; Dt: string } };
    const k = this.key(gstin, p.DocDtls.Typ, p.DocDtls.No, p.DocDtls.Dt);
    const fail = this.failures.shift();
    if (fail && !fail.afterRegister) throw new IrpError(fail.message, fail.code);
    const existing = this.docs.get(k);
    if (existing) throw new IrpError("Duplicate IRN", "2150", { irn: existing.irn, ackNo: existing.ackNo, ackDate: existing.ackDate });
    const irn = crypto.createHash("sha256").update(k).digest("hex");
    const now = new Date(Date.now() + 330 * 60_000).toISOString().replace("T", " ").slice(0, 19);
    const res: IrpResult = {
      irn,
      ackNo: String(112010000000000 + this.docs.size + 1),
      ackDate: now,
      signedInvoice: `simulated.${Buffer.from(JSON.stringify(payload)).toString("base64url").slice(0, 64)}.sig`,
      signedQrCode: `simulated.${Buffer.from(JSON.stringify({ SellerGstin: gstin, DocNo: p.DocDtls.No, Irn: irn })).toString("base64url")}.sig`,
    };
    this.docs.set(k, res);
    // A timeout after the IRP registered it: the caller never sees the IRN.
    if (fail && fail.afterRegister) throw new IrpError(fail.message, fail.code);
    return res;
  }

  async getByDocument(gstin: string, docType: string, docNumber: string, docDate: string): Promise<IrpResult | null> {
    this.calls.push("getByDocument");
    const d = this.docs.get(this.key(gstin, docType, docNumber, docDate));
    return d && !d.cancelled ? d : null;
  }

  async cancel(gstin: string, irn: string): Promise<{ cancelDate: string }> {
    this.calls.push("cancel");
    const d = [...this.docs.values()].find((x) => x.irn === irn);
    if (!d) throw new IrpError("IRN not found", "2154");
    if (d.cancelled) throw new IrpError("IRN already cancelled", "9999");
    d.cancelled = true;
    return { cancelDate: new Date(Date.now() + 330 * 60_000).toISOString().replace("T", " ").slice(0, 19) };
  }
}
