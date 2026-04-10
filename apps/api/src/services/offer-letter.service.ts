import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

interface GenerateOfferLetterData {
  employeeId: string;
  offerDate: Date;
  joiningDate: Date;
  designation: string;
  department?: string;
  salary: number;
  probationMonths?: number;
  location?: string;
  generatedBy: string;
}

export async function generateOfferLetter(data: GenerateOfferLetterData) {
  const employee = await prisma.user.findUnique({
    where: { id: data.employeeId },
    select: { id: true, name: true, email: true },
  });

  if (!employee) {
    throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found");
  }

  const offerLetter = await prisma.offerLetter.create({
    data: {
      employeeId: data.employeeId,
      offerDate: data.offerDate,
      joiningDate: data.joiningDate,
      designation: data.designation,
      department: data.department,
      salary: data.salary,
      probationMonths: data.probationMonths ?? 3,
      location: data.location,
      generatedBy: data.generatedBy,
    },
  });

  return {
    ...offerLetter,
    employee: {
      name: employee.name,
      email: employee.email,
    },
  };
}

export async function getOfferLetters(employeeId?: string) {
  const where = employeeId ? { employeeId } : {};

  const offerLetters = await prisma.offerLetter.findMany({
    where,
    include: {
      employee: {
        select: { name: true, email: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return offerLetters;
}

export async function getOfferLetterById(id: string) {
  const offerLetter = await prisma.offerLetter.findUnique({
    where: { id },
    include: {
      employee: {
        select: {
          name: true,
          email: true,
          phone: true,
          profile: {
            select: { designation: true },
          },
        },
      },
    },
  });

  if (!offerLetter) {
    throw new AppError(404, "OFFER_LETTER_NOT_FOUND", "Offer letter not found");
  }

  return offerLetter;
}

export async function getOfferLetterHtml(id: string) {
  const offerLetter = await getOfferLetterById(id);

  const offerDate = new Date(offerLetter.offerDate).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const joiningDate = new Date(offerLetter.joiningDate).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const salaryFormatted = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(offerLetter.salary);

  const department = offerLetter.department ?? "—";
  const location = offerLetter.location ?? "Remote";
  const probation = offerLetter.probationMonths ?? 3;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 40px; color: #1a1a1a; line-height: 1.7; font-size: 14px; }
    .header { text-align: center; margin-bottom: 40px; border-bottom: 3px solid #2563eb; padding-bottom: 20px; }
    .header h1 { margin: 0; font-size: 28px; color: #2563eb; letter-spacing: 1px; }
    .header p { margin: 4px 0 0; color: #666; font-size: 13px; }
    .date { text-align: right; margin-bottom: 30px; color: #555; }
    .subject { font-weight: 700; font-size: 16px; text-align: center; margin: 30px 0; text-decoration: underline; }
    .greeting { margin-bottom: 20px; }
    .details-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .details-table td { padding: 8px 12px; border: 1px solid #ddd; }
    .details-table td:first-child { font-weight: 600; width: 200px; background: #f8fafc; }
    .section { margin: 20px 0; }
    .signature-block { margin-top: 60px; }
    .signature-line { margin-top: 50px; display: flex; justify-content: space-between; }
    .signature-box { width: 45%; }
    .signature-box .line { border-top: 1px solid #333; padding-top: 5px; margin-top: 60px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Digital Sukoon</h1>
    <p>Marketing &amp; Technology Solutions</p>
  </div>

  <div class="date">Date: ${offerDate}</div>

  <div class="subject">OFFER OF EMPLOYMENT</div>

  <div class="greeting">
    <p>Dear <strong>${offerLetter.employee.name}</strong>,</p>
  </div>

  <div class="section">
    <p>We are pleased to extend this offer of employment to you at <strong>Digital Sukoon</strong>. After careful consideration of your qualifications and experience, we are confident that you will be a valuable addition to our team.</p>
  </div>

  <table class="details-table">
    <tr><td>Designation</td><td>${offerLetter.designation}</td></tr>
    <tr><td>Department</td><td>${department}</td></tr>
    <tr><td>Monthly Salary (CTC)</td><td>${salaryFormatted}</td></tr>
    <tr><td>Probation Period</td><td>${probation} months</td></tr>
    <tr><td>Date of Joining</td><td>${joiningDate}</td></tr>
    <tr><td>Work Location</td><td>${location}</td></tr>
  </table>

  <div class="section">
    <p>During the probation period of <strong>${probation} months</strong>, your performance will be reviewed. Upon successful completion of the probation, you will be confirmed as a permanent employee of the organization.</p>
  </div>

  <div class="section">
    <p>Your compensation and benefits are subject to applicable tax deductions as per the prevailing laws. Details of salary breakup and other benefits will be shared at the time of joining.</p>
  </div>

  <div class="section">
    <p>This offer is contingent upon the satisfactory verification of your credentials, references, and other documents as may be required by the company. Please confirm your acceptance of this offer by signing and returning a copy of this letter.</p>
  </div>

  <div class="section">
    <p>We look forward to welcoming you to the Digital Sukoon family. Should you have any questions, please do not hesitate to reach out to our HR department.</p>
  </div>

  <div class="signature-block">
    <p>Warm regards,</p>
    <div class="signature-line">
      <div class="signature-box">
        <div class="line">Authorized Signatory<br><strong>Digital Sukoon</strong></div>
      </div>
      <div class="signature-box">
        <div class="line">Employee Signature<br><strong>${offerLetter.employee.name}</strong></div>
      </div>
    </div>
  </div>
</body>
</html>`;

  return html;
}
