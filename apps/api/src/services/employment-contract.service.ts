import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

interface CreateContractData {
  employeeId: string;
  contractDate: Date;
  designation: string;
  department?: string;
  salary: number;
  probationMonths?: number;
  noticePeriod?: number;
}

export async function createContract(data: CreateContractData) {
  const employee = await prisma.user.findUnique({
    where: { id: data.employeeId },
    select: { id: true, name: true, email: true },
  });

  if (!employee) {
    throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found");
  }

  const contract = await prisma.employmentContract.create({
    data: {
      employeeId: data.employeeId,
      contractDate: data.contractDate,
      designation: data.designation,
      department: data.department,
      salary: data.salary,
      probationMonths: data.probationMonths ?? 3,
      noticePeriod: data.noticePeriod ?? 30,
    },
  });

  return {
    ...contract,
    employee: {
      name: employee.name,
      email: employee.email,
    },
  };
}

export async function getEmployeeContract(employeeId: string) {
  const contract = await prisma.employmentContract.findFirst({
    where: { employeeId },
    include: {
      employee: {
        select: { name: true, email: true, phone: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!contract) {
    throw new AppError(404, "CONTRACT_NOT_FOUND", "No contract found for this employee");
  }

  return contract;
}

export async function agreeToContract(contractId: string, employeeId: string, ipAddress?: string) {
  const contract = await prisma.employmentContract.findUnique({
    where: { id: contractId },
  });

  if (!contract) {
    throw new AppError(404, "CONTRACT_NOT_FOUND", "Contract not found");
  }

  if (contract.employeeId !== employeeId) {
    throw new AppError(403, "FORBIDDEN", "You are not authorized to agree to this contract");
  }

  if (contract.agreedAt) {
    throw new AppError(409, "ALREADY_AGREED", "This contract has already been agreed to");
  }

  const updated = await prisma.employmentContract.update({
    where: { id: contractId },
    data: {
      agreedAt: new Date(),
      agreedFromIp: ipAddress ?? null,
    },
    include: {
      employee: {
        select: { name: true, email: true },
      },
    },
  });

  return updated;
}

export async function getContractHtml(id: string) {
  const contract = await prisma.employmentContract.findUnique({
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

  if (!contract) {
    throw new AppError(404, "CONTRACT_NOT_FOUND", "Contract not found");
  }

  const contractDate = new Date(contract.contractDate).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const salaryFormatted = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(contract.salary);

  const department = contract.department ?? "—";
  const probation = contract.probationMonths ?? 3;
  const noticePeriod = contract.noticePeriod ?? 30;
  const agreedDate = contract.agreedAt
    ? new Date(contract.agreedAt).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

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
    .title { font-weight: 700; font-size: 18px; text-align: center; margin: 30px 0; text-decoration: underline; }
    .details-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .details-table td { padding: 8px 12px; border: 1px solid #ddd; }
    .details-table td:first-child { font-weight: 600; width: 200px; background: #f8fafc; }
    .section { margin: 24px 0; }
    .section h3 { color: #2563eb; font-size: 15px; margin-bottom: 8px; }
    .signature-block { margin-top: 60px; }
    .signature-line { margin-top: 50px; display: flex; justify-content: space-between; }
    .signature-box { width: 45%; }
    .signature-box .line { border-top: 1px solid #333; padding-top: 5px; margin-top: 60px; }
    .agreed-badge { background: #dcfce7; border: 1px solid #16a34a; color: #15803d; padding: 10px 16px; border-radius: 6px; text-align: center; margin: 30px 0; font-weight: 600; }
    .pending-badge { background: #fef9c3; border: 1px solid #ca8a04; color: #a16207; padding: 10px 16px; border-radius: 6px; text-align: center; margin: 30px 0; font-weight: 600; }
    ol { padding-left: 20px; }
    ol li { margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Digital Sukoon</h1>
    <p>Marketing &amp; Technology Solutions</p>
  </div>

  <div class="date">Date: ${contractDate}</div>

  <div class="title">EMPLOYMENT CONTRACT</div>

  <p>This Employment Contract ("Agreement") is entered into between <strong>Digital Sukoon</strong> ("the Company") and <strong>${contract.employee.name}</strong> ("the Employee") on the terms and conditions set forth below.</p>

  <table class="details-table">
    <tr><td>Employee Name</td><td>${contract.employee.name}</td></tr>
    <tr><td>Email</td><td>${contract.employee.email}</td></tr>
    <tr><td>Designation</td><td>${contract.designation}</td></tr>
    <tr><td>Department</td><td>${department}</td></tr>
    <tr><td>Monthly Salary (CTC)</td><td>${salaryFormatted}</td></tr>
    <tr><td>Probation Period</td><td>${probation} months</td></tr>
    <tr><td>Notice Period</td><td>${noticePeriod} days</td></tr>
  </table>

  <div class="section">
    <h3>1. Probation Period</h3>
    <p>The Employee shall be on probation for a period of <strong>${probation} months</strong> from the date of joining. During the probation period, either party may terminate this agreement with 7 days written notice. Upon successful completion of the probation period, the Employee will be confirmed as a permanent employee.</p>
  </div>

  <div class="section">
    <h3>2. Notice Period</h3>
    <p>After confirmation, either party may terminate this agreement by providing <strong>${noticePeriod} days</strong> written notice or salary in lieu thereof. During the notice period, the Employee is expected to complete all pending work and facilitate a proper handover of responsibilities.</p>
  </div>

  <div class="section">
    <h3>3. Confidentiality</h3>
    <p>The Employee agrees to maintain strict confidentiality of all proprietary information, trade secrets, client data, business strategies, and any other confidential information of the Company, both during and after employment. Any breach of confidentiality may result in immediate termination and legal action.</p>
  </div>

  <div class="section">
    <h3>4. Non-Compete</h3>
    <p>During the term of employment and for a period of 6 months following termination, the Employee agrees not to directly or indirectly engage in any business activity that competes with the Company's services, nor solicit any of the Company's clients, partners, or employees.</p>
  </div>

  <div class="section">
    <h3>5. Intellectual Property</h3>
    <p>All work product, inventions, designs, code, content, strategies, and other intellectual property created by the Employee during the course of employment shall be the exclusive property of Digital Sukoon. The Employee hereby assigns all rights, title, and interest in such work product to the Company.</p>
  </div>

  <div class="section">
    <h3>6. General Terms</h3>
    <ol>
      <li>The Employee shall comply with all company policies, rules, and regulations as may be amended from time to time.</li>
      <li>Compensation is subject to applicable tax deductions as per prevailing laws.</li>
      <li>This agreement supersedes all prior agreements and understandings between the parties.</li>
      <li>Any disputes arising from this agreement shall be subject to the jurisdiction of courts at the Company's registered office location.</li>
    </ol>
  </div>

  ${
    agreedDate
      ? `<div class="agreed-badge">Contract agreed by ${contract.employee.name} on ${agreedDate}</div>`
      : `<div class="pending-badge">Pending employee agreement</div>`
  }

  <div class="signature-block">
    <div class="signature-line">
      <div class="signature-box">
        <div class="line">Authorized Signatory<br><strong>Digital Sukoon</strong></div>
      </div>
      <div class="signature-box">
        <div class="line">Employee Signature<br><strong>${contract.employee.name}</strong>${agreedDate ? `<br><em>Agreed on: ${agreedDate}</em>` : ""}</div>
      </div>
    </div>
  </div>
</body>
</html>`;

  return html;
}

export async function listContracts(filters?: { employeeId?: string }) {
  const where = filters?.employeeId ? { employeeId: filters.employeeId } : {};

  const contracts = await prisma.employmentContract.findMany({
    where,
    include: {
      employee: {
        select: { name: true, email: true, phone: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return contracts;
}

export async function getPendingContractForEmployee(employeeId: string) {
  const contract = await prisma.employmentContract.findFirst({
    where: {
      employeeId,
      agreedAt: null,
    },
    include: {
      employee: {
        select: { name: true, email: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!contract) {
    throw new AppError(404, "NO_PENDING_CONTRACT", "No pending contract found for this employee");
  }

  return contract;
}
