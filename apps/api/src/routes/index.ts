import { Router } from "express";
import healthRoutes from "./health.routes";
import authRoutes from "./auth.routes";
import roleRoutes from "./role.routes";
import employeeRoutes from "./employee.routes";
import teamRoutes from "./team.routes";
import attendanceRoutes from "./attendance.routes";
import taskRoutes from "./task.routes";
import accountRoutes from "./account.routes";
import clientRoutes from "./client.routes";
import projectRoutes from "./project.routes";
import contentRoutes from "./content.routes";
import analyticsRoutes from "./analytics.routes";
import hrAuthRoutes from "./hr-auth.routes";
import hrRoutes from "./hr.routes";
import adminReportsRoutes from "./admin-reports.routes";

const router = Router();

router.use(healthRoutes);
router.use(authRoutes);
router.use(roleRoutes);
router.use(employeeRoutes);
router.use(teamRoutes);
router.use(attendanceRoutes);
router.use(taskRoutes);
router.use(accountRoutes);
router.use(clientRoutes);
router.use(projectRoutes);
router.use(contentRoutes);
router.use(analyticsRoutes);
router.use(hrAuthRoutes);
router.use(hrRoutes);
router.use(adminReportsRoutes);

export default router;
