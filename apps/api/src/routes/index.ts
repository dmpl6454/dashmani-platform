import { Router } from "express";
import healthRoutes from "./health.routes";
import authRoutes from "./auth.routes";
import roleRoutes from "./role.routes";
import employeeRoutes from "./employee.routes";
import teamRoutes from "./team.routes";
import attendanceRoutes from "./attendance.routes";

const router = Router();

router.use(healthRoutes);
router.use(authRoutes);
router.use(roleRoutes);
router.use(employeeRoutes);
router.use(teamRoutes);
router.use(attendanceRoutes);

export default router;
