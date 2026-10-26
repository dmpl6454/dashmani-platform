// The connection to the government Invoice Registration Portal (IRP). Pluggable: NIC's direct
// e-invoice API (nic.ts), a simulated portal for tests and local development (mock.ts), and —
// when chosen — a GSP adapter with the same four calls. Selected by EINVOICE_PROVIDER.

export interface IrpResult {
  irn: string;
  ackNo: string;
  /** As returned by the IRP: "YYYY-MM-DD HH:mm:ss" in IST. */
  ackDate: string;
  signedInvoice: string;
  signedQrCode: string;
}

export class IrpError extends Error {
  constructor(
    message: string,
    public code: string,
    /** Set when the IRP says the document is already registered (duplicate IRN): its details. */
    public existing?: { irn: string; ackNo: string; ackDate: string } | null,
  ) {
    super(message);
    this.name = "IrpError";
  }
}

export interface IrpProvider {
  readonly name: string;
  /** Register a document (INV-01 JSON) and get its IRN. */
  generate(gstin: string, payload: unknown): Promise<IrpResult>;
  /** The registration of a document if the IRP already holds one, else null (safe retries). */
  getByDocument(gstin: string, docType: string, docNumber: string, docDate: string): Promise<IrpResult | null>;
  /** Cancel an IRN (only possible within 24 hours of registration). reason: 1 duplicate, 2 data entry mistake, 3 order cancelled, 4 other. */
  cancel(gstin: string, irn: string, reason: "1" | "2" | "3" | "4", remark: string): Promise<{ cancelDate: string }>;
}

let override: IrpProvider | null | undefined;
let cached: IrpProvider | null | undefined;

/** Tests inject the simulated portal (or null) here. */
export function setIrpProviderForTests(p: IrpProvider | null | undefined): void {
  override = p;
}

export function getIrpProvider(): IrpProvider | null {
  if (override !== undefined) return override;
  if (cached !== undefined) return cached;
  const kind = (process.env.EINVOICE_PROVIDER ?? "").trim().toLowerCase();
  if (kind === "nic") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NicIrp } = require("./nic") as typeof import("./nic");
    cached = NicIrp.fromEnv();
  } else if (kind === "mock") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MockIrp } = require("./mock") as typeof import("./mock");
    cached = new MockIrp();
  } else {
    cached = null;
  }
  return cached;
}
