// Shared fixtures for the reconcile tests (spec-reconcile §4.2, §5.1.7, §5.2.3, §5.3). Built as
// strings / plain objects in code — no binary fixtures.

export const SAMPLE_26AS = [
  "File Creation Date^Permanent Account Number (PAN)^Current Status of PAN^Financial Year^Assessment Year^Name of Assessee^Address Line 1^Address Line 2^Address Line 3^Address Line 4^Address Line 5^Statecode^Pin Code",
  "05-11-2026^AAKCD3352K^Active^2025-26^2026-27^DIGITAL SUKOON PRIVATE LIMITED^702 PARINEE I^ANDHERI WEST^^MUMBAI^^27^400053",
  "",
  "^PART-I - Details of Tax Deducted at Source^",
  "Sr. No.^Name of Deductor^TAN of Deductor^^^^^Total Amount Paid / Credited(Rs.)^Total Tax Deducted(Rs.)^Total TDS Deposited(Rs.)",
  "1^FILMY BRANDS PRIVATE LIMITED^MUMF12345A^^^^^150000.00^15000.00^15000.00",
  "^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks**^Amount Paid / Credited(Rs.)^Tax Deducted##(Rs.)^TDS Deposited(Rs.)",
  "^1^194J^20-Sep-2025^F^30-Oct-2025^-^100000.00^10000.00^10000.00",
  "^2^194J^15-Dec-2025^F^25-Jan-2026^-^50000.00^5000.00^5000.00",
  "2^KANARA FOODS PVT. LTD.^BLRK98765C^^^^^200000.00^4000.00^0.00",
  "^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks**^Amount Paid / Credited(Rs.)^Tax Deducted##(Rs.)^TDS Deposited(Rs.)",
  "^1^194C^22-Dec-2025^U^-^-^200000.00^4000.00^0.00",
  "3^HUNCH MEDIA LLP^DELH55555E^^^^^50000.00^1000.00^1000.00",
  "^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks**^Amount Paid / Credited(Rs.)^Tax Deducted##(Rs.)^TDS Deposited(Rs.)",
  "^1^194C^14-Feb-2026^F^20-May-2026^-^50000.00^1000.00^1000.00",
  "4^RED CHILLI ENTERTAINMENT PVT LTD^DELR77777Z^^^^^80000.00^8000.00^8000.00",
  "^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks**^Amount Paid / Credited(Rs.)^Tax Deducted##(Rs.)^TDS Deposited(Rs.)",
  "^1^194J^05-Mar-2026^F^25-May-2026^-^80000.00^8000.00^8000.00",
  "5^HDFC BANK LIMITED^MUMH03189E^^^^^12500.00^1250.00^1250.00",
  "^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks**^Amount Paid / Credited(Rs.)^Tax Deducted##(Rs.)^TDS Deposited(Rs.)",
  "^1^194A^30-Sep-2025^F^25-Nov-2025^-^12500.00^1250.00^1250.00",
  "6^STAR GROUP HOLDINGS^MUMS11111B^^^^^25000.00^2500.00^2500.00",
  "^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks**^Amount Paid / Credited(Rs.)^Tax Deducted##(Rs.)^TDS Deposited(Rs.)",
  "^1^194J^18-Nov-2025^F^20-Jan-2026^-^25000.00^2500.00^2500.00",
  "",
  "^PART-II - Details of Tax Deducted at Source for 15G / 15H^",
  "^No Transactions Present^",
  "^PART-VI - Details of Tax Collected at Source^",
  "1^SOME SELLER LTD^MUMS00000A^^^^^10000.00^10.00^10.00",
].join("\r\n");

/** The §5.2.3 filed side, as the GST portal's JSON (27AAKCD3352K1ZF, October 2026). */
export function gstr1OctoberJson() {
  const itm = (rt: number, txval: number, h: { iamt?: number; camt?: number; samt?: number }) => ({ num: 1, itm_det: { rt, txval, ...h } });
  return {
    gstin: "27AAKCD3352K1ZF",
    fp: "102026",
    b2b: [
      { ctin: "27AABCU9603R1ZX", inv: [
        { inum: "INV/26-27/016", idt: "14-10-2026", val: 118000, pos: "27", rchrg: "N", inv_typ: "R", itms: [itm(18, 100000, { camt: 9000, samt: 9000 })] },
        { inum: "INV/26-27/0018", idt: "28-10-2026", val: 64900, pos: "27", rchrg: "N", inv_typ: "R", itms: [itm(18, 55000, { camt: 4950, samt: 4950 })] },
        { inum: "INV/26-27/0014", idt: "30-09-2026", val: 23600, pos: "27", rchrg: "N", inv_typ: "R", itms: [itm(18, 20000, { camt: 1800, samt: 1800 })] },
      ] },
      { ctin: "29AAACB1234F1Z8", inv: [
        { inum: "INV/26-27/0017", idt: "22-10-2026", val: 236000, pos: "29", rchrg: "N", inv_typ: "R", itms: [itm(18, 200000, { iamt: 36000 })] },
      ] },
      { ctin: "27AAJFO1111K1Z5", inv: [
        { inum: "INV/26-27/0022", idt: "26-10-2026", val: 5900, pos: "27", rchrg: "N", inv_typ: "R", itms: [itm(18, 5000, { camt: 450, samt: 450 })] },
      ] },
      { ctin: "27AAGCN4321Q1Z2", inv: [
        { inum: "DSPL/26-27/0155", idt: "03-10-2026", val: 47200, pos: "27", rchrg: "N", inv_typ: "R", itms: [itm(18, 40000, { camt: 3600, samt: 3600 })] },
        { inum: "INV/26-27/061", idt: "12-10-2026", val: 11800, pos: "27", rchrg: "N", inv_typ: "R", itms: [itm(18, 10000, { camt: 900, samt: 900 })] },
      ] },
    ],
    cdnr: [
      { ctin: "29AAACB1234F1Z9", nt: [
        { ntty: "C", nt_num: "CN/26-27/0003", nt_dt: "30-10-2026", val: 23600, pos: "29", rchrg: "N", inv_typ: "R", itms: [itm(18, 20000, { iamt: 3600 })] },
      ] },
    ],
  };
}
