import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AppError(500, "AI_NOT_CONFIGURED", "AI service is not configured. Set ANTHROPIC_API_KEY.");
  }
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const COMPANY = {
  name: "Digital Sukoon",
  legalName: "Dashmani Media Private Limited",
  tagline: "Marketing & Technology Solutions",
  address: "India",
};

async function askClaude(systemPrompt: string, userPrompt: string): Promise<string> {
  const client = getClient();
  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const block = msg.content.find((b) => b.type === "text");
  return block ? block.text : "";
}

// ===== Job Vacancy AI =====

export async function generateJobDescription(input: {
  title: string;
  department?: string;
  type?: string;
  experience?: string;
  salary?: string;
  location?: string;
  notes?: string;
}) {
  const system = `You are an HR content writer for ${COMPANY.name}, a full-service marketing and technology agency in India. Generate professional, engaging job descriptions. Return a JSON object with these keys: description, requirements, responsibilities, benefits. Each value should be a string with items separated by newlines. Keep it realistic for the Indian job market. Do not use markdown formatting in the values — just plain text with newline separators.`;

  const prompt = `Create a complete job listing for:
Title: ${input.title}
Department: ${input.department || "Not specified"}
Type: ${input.type || "Full Time"}
Experience: ${input.experience || "Not specified"}
Salary Range: ${input.salary || "Not specified"}
Location: ${input.location || "Not specified"}
Additional Notes: ${input.notes || "None"}

Return ONLY valid JSON with keys: description, requirements, responsibilities, benefits`;

  const response = await askClaude(system, prompt);
  try {
    const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { description: response, requirements: "", responsibilities: "", benefits: "" };
  }
}

// ===== Offer Letter AI =====

export async function generateOfferLetterContent(input: {
  employeeId: string;
  designation: string;
  department?: string;
  salary: number;
  joiningDate: string;
  probationMonths?: number;
  location?: string;
  specialTerms?: string;
}) {
  const employee = await prisma.user.findUnique({
    where: { id: input.employeeId },
    select: { name: true, email: true, profile: { select: { designation: true } } },
  });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  const salaryFormatted = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(input.salary);

  const system = `You are an HR document writer for ${COMPANY.name} (${COMPANY.legalName}). Generate professional offer letters in HTML format ready for printing. Use proper Indian business letter formatting. The letter should be warm yet professional. Include proper legal terms. Use clean, professional CSS styling with the company brand color #2563eb.`;

  const prompt = `Generate a complete offer letter in HTML format:
Employee Name: ${employee.name}
Designation: ${input.designation}
Department: ${input.department || "Not specified"}
Monthly CTC: ${salaryFormatted}
Joining Date: ${input.joiningDate}
Probation: ${input.probationMonths || 3} months
Location: ${input.location || "Remote"}
Special Terms: ${input.specialTerms || "None"}

Company: ${COMPANY.name} (${COMPANY.legalName})

Generate a complete, ready-to-print HTML document with:
- Company letterhead header
- Date and reference number
- Formal greeting
- Body with position details, compensation, terms
- Reporting structure if applicable
- Probation terms
- Acceptance section
- Signature blocks for both company and employee
- Professional CSS styling

Return ONLY the complete HTML document, no explanation.`;

  return { html: await askClaude(system, prompt), employeeName: employee.name };
}

// ===== Appointment Letter AI =====

export async function generateAppointmentLetter(input: {
  employeeId: string;
  designation: string;
  department?: string;
  salary: number;
  joiningDate: string;
  probationMonths?: number;
  noticePeriod?: number;
  location?: string;
  specialClauses?: string;
}) {
  const employee = await prisma.user.findUnique({
    where: { id: input.employeeId },
    select: { name: true, email: true, phone: true, profile: { select: { designation: true, panNumber: true, aadhaarNumber: true } } },
  });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  const salaryFormatted = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(input.salary);

  const system = `You are an HR legal document writer for ${COMPANY.name} (${COMPANY.legalName}). Generate formal appointment letters in HTML format. These are more detailed and legally binding than offer letters. Follow Indian employment law standards. Use professional CSS styling with company brand color #2563eb.`;

  const prompt = `Generate a formal appointment letter in HTML format:
Employee Name: ${employee.name}
Email: ${employee.email}
Phone: ${employee.phone || "—"}
Designation: ${input.designation}
Department: ${input.department || "Not specified"}
Monthly CTC: ${salaryFormatted}
Date of Joining: ${input.joiningDate}
Probation Period: ${input.probationMonths || 3} months
Notice Period: ${input.noticePeriod || 30} days
Work Location: ${input.location || "Remote"}
Special Clauses: ${input.specialClauses || "None"}

Company: ${COMPANY.name} (${COMPANY.legalName})

Generate a comprehensive appointment letter HTML document including:
- Company letterhead
- Reference number and date
- Employee details section
- Position and compensation details
- Detailed terms of employment:
  1. Probation period terms
  2. Working hours and leave policy overview
  3. Compensation and salary structure
  4. Notice period and termination
  5. Confidentiality and NDA
  6. Non-compete clause
  7. Code of conduct
  8. Intellectual property rights
  9. Governing law (Indian jurisdiction)
- Declaration section for employee to sign
- Dual signature blocks
- Professional print-ready CSS styling

Return ONLY the complete HTML document.`;

  return { html: await askClaude(system, prompt), employeeName: employee.name };
}

// ===== Salary Slip AI =====

export async function generateSalarySlipHtml(salarySlipId: string) {
  const slip = await prisma.salarySlip.findUnique({
    where: { id: salarySlipId },
    include: {
      employee: {
        select: {
          name: true, email: true, phone: true,
          profile: {
            select: {
              designation: true, bankAccountHolderName: true, bankAccountNumber: true,
              bankName: true, bankBranch: true, ifscCode: true, panNumber: true,
            },
          },
        },
      },
    },
  });

  if (!slip) throw new AppError(404, "NOT_FOUND", "Salary slip not found");

  const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const grossSalary = slip.basicSalary + slip.hra + slip.conveyance + slip.medicalAllowance + slip.specialAllowance + slip.otherEarnings;
  const totalDeductions = slip.pf + slip.esi + slip.tax + slip.otherDeductions;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 30px; color: #1a1a1a; font-size: 13px; }
    .header { text-align: center; margin-bottom: 20px; border-bottom: 3px solid #2563eb; padding-bottom: 15px; }
    .header h1 { margin: 0; font-size: 24px; color: #2563eb; letter-spacing: 1px; }
    .header p { margin: 4px 0 0; color: #666; font-size: 12px; }
    .slip-title { text-align: center; font-size: 16px; font-weight: 700; margin: 20px 0; text-decoration: underline; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 15px 0; padding: 12px; background: #f8fafc; border-radius: 6px; }
    .info-grid .item { display: flex; gap: 6px; font-size: 12px; }
    .info-grid .label { font-weight: 600; min-width: 120px; color: #555; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th { background: #2563eb; color: white; padding: 8px 12px; text-align: left; font-size: 12px; }
    td { padding: 6px 12px; border: 1px solid #e2e8f0; font-size: 12px; }
    .earnings td:last-child, .deductions td:last-child { text-align: right; }
    .total-row { font-weight: 700; background: #f1f5f9; }
    .net-pay { text-align: center; margin: 20px 0; padding: 15px; background: #dcfce7; border-radius: 8px; }
    .net-pay .amount { font-size: 28px; font-weight: 700; color: #15803d; }
    .net-pay .label { font-size: 12px; color: #555; text-transform: uppercase; letter-spacing: 1px; }
    .bank-info { margin: 15px 0; padding: 12px; background: #eff6ff; border-radius: 6px; font-size: 12px; }
    .footer { margin-top: 30px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #e2e8f0; padding-top: 15px; }
    @media print { body { padding: 15px; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>${COMPANY.name}</h1>
    <p>${COMPANY.legalName} &mdash; ${COMPANY.tagline}</p>
  </div>

  <div class="slip-title">SALARY SLIP &mdash; ${monthNames[slip.month - 1]} ${slip.year}</div>

  <div class="info-grid">
    <div class="item"><span class="label">Employee Name:</span><span>${slip.employee.name}</span></div>
    <div class="item"><span class="label">Designation:</span><span>${slip.employee.profile?.designation || "—"}</span></div>
    <div class="item"><span class="label">Email:</span><span>${slip.employee.email}</span></div>
    <div class="item"><span class="label">PAN:</span><span>${slip.employee.profile?.panNumber || "—"}</span></div>
    <div class="item"><span class="label">Pay Period:</span><span>${monthNames[slip.month - 1]} ${slip.year}</span></div>
    <div class="item"><span class="label">Status:</span><span>${slip.status}</span></div>
  </div>

  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
    <div>
      <table class="earnings">
        <thead><tr><th colspan="2">Earnings</th></tr></thead>
        <tbody>
          <tr><td>Basic Salary</td><td>${fmt(slip.basicSalary)}</td></tr>
          <tr><td>HRA</td><td>${fmt(slip.hra)}</td></tr>
          <tr><td>Conveyance</td><td>${fmt(slip.conveyance)}</td></tr>
          <tr><td>Medical Allowance</td><td>${fmt(slip.medicalAllowance)}</td></tr>
          <tr><td>Special Allowance</td><td>${fmt(slip.specialAllowance)}</td></tr>
          <tr><td>Other Earnings</td><td>${fmt(slip.otherEarnings)}</td></tr>
          <tr class="total-row"><td>Gross Salary</td><td>${fmt(grossSalary)}</td></tr>
        </tbody>
      </table>
    </div>
    <div>
      <table class="deductions">
        <thead><tr><th colspan="2">Deductions</th></tr></thead>
        <tbody>
          <tr><td>Provident Fund (PF)</td><td>${fmt(slip.pf)}</td></tr>
          <tr><td>ESI</td><td>${fmt(slip.esi)}</td></tr>
          <tr><td>Income Tax (TDS)</td><td>${fmt(slip.tax)}</td></tr>
          <tr><td>Other Deductions</td><td>${fmt(slip.otherDeductions)}</td></tr>
          <tr class="total-row"><td>Total Deductions</td><td>${fmt(totalDeductions)}</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="net-pay">
    <div class="label">Net Pay</div>
    <div class="amount">${fmt(slip.netSalary)}</div>
  </div>

  ${slip.employee.profile?.bankAccountNumber ? `
  <div class="bank-info">
    <strong>Bank Details:</strong> ${slip.employee.profile.bankAccountHolderName || slip.employee.name} |
    A/c: ${slip.employee.profile.bankAccountNumber} |
    ${slip.employee.profile.bankName || ""} ${slip.employee.profile.bankBranch ? `(${slip.employee.profile.bankBranch})` : ""} |
    IFSC: ${slip.employee.profile.ifscCode || "—"}
  </div>` : ""}

  ${slip.remarks ? `<p style="font-size:12px;color:#555;"><strong>Remarks:</strong> ${slip.remarks}</p>` : ""}

  <div class="footer">
    This is a computer-generated document. No signature is required.<br>
    ${COMPANY.legalName} &mdash; ${COMPANY.tagline}
  </div>
</body>
</html>`;

  return html;
}

// Preview variant: takes form data directly instead of a saved slip ID
export async function generateSalarySlipPreviewHtml(input: {
  employeeId: string;
  month: number;
  year: number;
  basicSalary: number;
  hra: number;
  conveyance: number;
  medicalAllowance: number;
  specialAllowance: number;
  otherEarnings: number;
  pf: number;
  esi: number;
  tax: number;
  otherDeductions: number;
  remarks?: string;
}): Promise<{ html: string; employeeName: string; netSalary: number }> {
  const employee = await prisma.user.findUnique({
    where: { id: input.employeeId },
    select: {
      name: true, email: true, phone: true,
      profile: {
        select: {
          designation: true, bankAccountHolderName: true, bankAccountNumber: true,
          bankName: true, bankBranch: true, ifscCode: true, panNumber: true,
        },
      },
    },
  });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const grossSalary = input.basicSalary + input.hra + input.conveyance + input.medicalAllowance + input.specialAllowance + input.otherEarnings;
  const totalDeductions = input.pf + input.esi + input.tax + input.otherDeductions;
  const netSalary = grossSalary - totalDeductions;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 30px; color: #1a1a1a; font-size: 13px; }
    .header { text-align: center; margin-bottom: 20px; border-bottom: 3px solid #2563eb; padding-bottom: 15px; }
    .header h1 { margin: 0; font-size: 24px; color: #2563eb; letter-spacing: 1px; }
    .header p { margin: 4px 0 0; color: #666; font-size: 12px; }
    .slip-title { text-align: center; font-size: 16px; font-weight: 700; margin: 20px 0; text-decoration: underline; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 15px 0; padding: 12px; background: #f8fafc; border-radius: 6px; }
    .info-grid .item { display: flex; gap: 6px; font-size: 12px; }
    .info-grid .label { font-weight: 600; min-width: 120px; color: #555; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th { background: #2563eb; color: white; padding: 8px 12px; text-align: left; font-size: 12px; }
    td { padding: 6px 12px; border: 1px solid #e2e8f0; font-size: 12px; }
    .earnings td:last-child, .deductions td:last-child { text-align: right; }
    .total-row { font-weight: 700; background: #f1f5f9; }
    .net-pay { text-align: center; margin: 20px 0; padding: 15px; background: #dcfce7; border-radius: 8px; }
    .net-pay .amount { font-size: 28px; font-weight: 700; color: #15803d; }
    .net-pay .label { font-size: 12px; color: #555; text-transform: uppercase; letter-spacing: 1px; }
    .bank-info { margin: 15px 0; padding: 12px; background: #eff6ff; border-radius: 6px; font-size: 12px; }
    .footer { margin-top: 30px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #e2e8f0; padding-top: 15px; }
    @media print { body { padding: 15px; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>${COMPANY.name}</h1>
    <p>${COMPANY.legalName} &mdash; ${COMPANY.tagline}</p>
  </div>

  <div class="slip-title">SALARY SLIP &mdash; ${monthNames[input.month - 1]} ${input.year} (PREVIEW)</div>

  <div class="info-grid">
    <div class="item"><span class="label">Employee Name:</span><span>${employee.name}</span></div>
    <div class="item"><span class="label">Designation:</span><span>${employee.profile?.designation || "—"}</span></div>
    <div class="item"><span class="label">Email:</span><span>${employee.email}</span></div>
    <div class="item"><span class="label">PAN:</span><span>${employee.profile?.panNumber || "—"}</span></div>
    <div class="item"><span class="label">Pay Period:</span><span>${monthNames[input.month - 1]} ${input.year}</span></div>
    <div class="item"><span class="label">Status:</span><span>PENDING_APPROVAL</span></div>
  </div>

  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
    <div>
      <table class="earnings">
        <thead><tr><th colspan="2">Earnings</th></tr></thead>
        <tbody>
          <tr><td>Basic Salary</td><td>${fmt(input.basicSalary)}</td></tr>
          <tr><td>HRA</td><td>${fmt(input.hra)}</td></tr>
          <tr><td>Conveyance</td><td>${fmt(input.conveyance)}</td></tr>
          <tr><td>Medical Allowance</td><td>${fmt(input.medicalAllowance)}</td></tr>
          <tr><td>Special Allowance</td><td>${fmt(input.specialAllowance)}</td></tr>
          <tr><td>Other Earnings</td><td>${fmt(input.otherEarnings)}</td></tr>
          <tr class="total-row"><td>Gross Salary</td><td>${fmt(grossSalary)}</td></tr>
        </tbody>
      </table>
    </div>
    <div>
      <table class="deductions">
        <thead><tr><th colspan="2">Deductions</th></tr></thead>
        <tbody>
          <tr><td>Provident Fund (PF)</td><td>${fmt(input.pf)}</td></tr>
          <tr><td>ESI</td><td>${fmt(input.esi)}</td></tr>
          <tr><td>Income Tax (TDS)</td><td>${fmt(input.tax)}</td></tr>
          <tr><td>Other Deductions</td><td>${fmt(input.otherDeductions)}</td></tr>
          <tr class="total-row"><td>Total Deductions</td><td>${fmt(totalDeductions)}</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="net-pay">
    <div class="label">Net Pay</div>
    <div class="amount">${fmt(netSalary)}</div>
  </div>

  ${employee.profile?.bankAccountNumber ? `
  <div class="bank-info">
    <strong>Bank Details:</strong> ${employee.profile.bankAccountHolderName || employee.name} |
    A/c: ${employee.profile.bankAccountNumber} |
    ${employee.profile.bankName || ""} ${employee.profile.bankBranch ? `(${employee.profile.bankBranch})` : ""} |
    IFSC: ${employee.profile.ifscCode || "—"}
  </div>` : ""}

  ${input.remarks ? `<p style="font-size:12px;color:#555;"><strong>Remarks:</strong> ${input.remarks}</p>` : ""}

  <div class="footer">
    This is a computer-generated document. No signature is required.<br>
    ${COMPANY.legalName} &mdash; ${COMPANY.tagline}
  </div>
</body>
</html>`;

  return { html, employeeName: employee.name, netSalary };
}

// ===== Employment Contract AI =====

export async function generateContractContent(input: {
  employeeId: string;
  designation: string;
  department?: string;
  salary: number;
  contractDate: string;
  probationMonths?: number;
  noticePeriod?: number;
  specialClauses?: string;
}) {
  const employee = await prisma.user.findUnique({
    where: { id: input.employeeId },
    select: { name: true, email: true, phone: true, profile: { select: { designation: true, panNumber: true, aadhaarNumber: true, mailingAddress: true } } },
  });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  const salaryFormatted = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(input.salary);

  const system = `You are a legal document specialist for ${COMPANY.name} (${COMPANY.legalName}). Generate comprehensive employment contracts in HTML format following Indian labor law. Include all standard clauses. Use professional CSS styling with brand color #2563eb.`;

  const prompt = `Generate a comprehensive employment contract in HTML format:
Employee Name: ${employee.name}
Email: ${employee.email}
Phone: ${employee.phone || "—"}
Address: ${employee.profile?.mailingAddress || "—"}
PAN: ${employee.profile?.panNumber || "—"}
Designation: ${input.designation}
Department: ${input.department || "Not specified"}
Monthly CTC: ${salaryFormatted}
Contract Date: ${input.contractDate}
Probation: ${input.probationMonths || 3} months
Notice Period: ${input.noticePeriod || 30} days
Special Clauses: ${input.specialClauses || "None"}

Company: ${COMPANY.name} (${COMPANY.legalName})

Generate a legally sound employment contract HTML with:
- Company letterhead
- Parties identification section
- Commencement and duration
- Position and duties
- Compensation and benefits breakdown
- Working hours
- Leave entitlements
- Probation terms
- Termination and notice period
- Confidentiality and NDA
- Non-compete and non-solicitation
- Intellectual property assignment
- Code of conduct
- Dispute resolution
- Governing law (Indian jurisdiction)
- Entire agreement clause
- Signature blocks with witness section
- Print-ready professional CSS

Return ONLY the complete HTML document.`;

  return { html: await askClaude(system, prompt), employeeName: employee.name };
}

// ===== AI Presentation Generator =====

export async function generateAIPresentation(input: {
  topic: string;
  type: "presentation" | "report";
  slideCount?: number;
  style?: string;
  audience?: string;
  additionalNotes?: string;
}) {
  const slides = input.slideCount || (input.type === "report" ? 8 : 10);

  const system = `You are a professional presentation designer for ${COMPANY.name} (${COMPANY.legalName}), a full-service marketing and technology agency. Generate Marp-compatible markdown presentations.

Rules:
- Use --- to separate slides (with blank lines before and after)
- First slide must have the marp frontmatter
- Use clear, concise bullet points
- Include data placeholders where relevant (e.g., "X%" or "₹X")
- Use tables for comparisons and metrics
- Make it visually structured with proper headings
- Use emojis sparingly for visual appeal
- Include a title slide and a closing/thank-you slide
- For reports: include executive summary, key metrics, findings, and recommendations
- For presentations: include agenda, key points, and call-to-action
- Generate exactly ${slides} slides
- Return ONLY the Marp markdown, no explanation`;

  const typeLabel = input.type === "report" ? "Report" : "Presentation";

  const prompt = `Generate a professional ${typeLabel} in Marp markdown format:

Topic: ${input.topic}
Type: ${typeLabel}
Number of Slides: ${slides}
Style/Tone: ${input.style || "Professional and clean"}
Target Audience: ${input.audience || "Business stakeholders"}
${input.additionalNotes ? `Additional Notes: ${input.additionalNotes}` : ""}

Company: ${COMPANY.name}

Generate the complete Marp markdown with frontmatter. Use theme: default with dark background for presentations (backgroundColor: #1a1a1a, color: #ffffff) and light background for reports (backgroundColor: #ffffff, color: #333333).`;

  const markdown = await askClaude(system, prompt);

  // Clean up any code block wrapping Claude might add
  const cleaned = markdown
    .replace(/^```(?:markdown|marp)?\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();

  return { markdown: cleaned, title: `${input.topic} — ${typeLabel}`, slideCount: slides };
}

// ===== General AI Assistant =====

export async function aiAssist(input: {
  task: string;
  context?: string;
  employeeId?: string;
}) {
  let employeeContext = "";
  if (input.employeeId) {
    const emp = await prisma.user.findUnique({
      where: { id: input.employeeId },
      select: { name: true, email: true, phone: true, profile: { select: { designation: true, salary: true, jobDescription: true } } },
    });
    if (emp) {
      employeeContext = `\nEmployee: ${emp.name}, ${emp.profile?.designation || "No designation"}, Salary: ${emp.profile?.salary || "Not set"}`;
    }
  }

  const system = `You are an AI HR assistant for ${COMPANY.name} (${COMPANY.legalName}), a marketing and technology agency in India. Help with HR tasks, policy drafting, email templates, performance feedback, and other administrative work. Be professional, concise, and follow Indian employment norms. If generating HTML documents, use clean professional styling.`;

  const prompt = `${input.task}${employeeContext}${input.context ? `\n\nAdditional context: ${input.context}` : ""}`;

  return { response: await askClaude(system, prompt) };
}
