import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit-log";
import { employeeValidators } from "@dashmani/shared";
import * as employeeService from "../services/employee.service";
import { success } from "../utils/response";
import { parsePagination } from "../utils/pagination";

const router = Router();

router.get("/employees", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pagination = parsePagination(req.query as any);
    const result = await employeeService.listEmployees({
      ...pagination,
      status: req.query.status as string,
      orgUnitId: req.query.orgUnitId as string,
      search: req.query.search as string,
    });
    return success(res, result.items, result.meta);
  } catch (err) { next(err); }
});

router.get("/employees/:id", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const employee = await employeeService.getEmployeeById(req.params.id);
    return success(res, employee);
  } catch (err) { next(err); }
});

router.post("/employees", authenticate, requirePermission("employees", "create"), validate(employeeValidators.createEmployeeSchema), auditLog("employees", "create"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const employee = await employeeService.createEmployee(req.body);
    return success(res, employee, undefined, 201);
  } catch (err) { next(err); }
});

router.put("/employees/:id", authenticate, requirePermission("employees", "edit"), validate(employeeValidators.updateEmployeeSchema), auditLog("employees", "update"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const employee = await employeeService.updateEmployee(req.params.id, req.body);
    return success(res, employee);
  } catch (err) { next(err); }
});

router.delete("/employees/:id", authenticate, requirePermission("employees", "delete"), auditLog("employees", "delete"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await employeeService.softDeleteEmployee(req.params.id);
    return success(res, { message: "Employee deactivated" });
  } catch (err) { next(err); }
});

export default router;
