import { Router } from "express";
import healthRoutes from "./health.routes";
import authRoutes from "./auth.routes";
import roleRoutes from "./role.routes";

const router = Router();

router.use(healthRoutes);
router.use(authRoutes);
router.use(roleRoutes);

export default router;
