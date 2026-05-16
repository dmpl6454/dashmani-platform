import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import rateLimit from "express-rate-limit";
import routes from "./routes";
import { errorHandler } from "./middleware/error-handler";

const app = express();
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");

app.set("trust proxy", 1);

// Security headers — CSP disabled for API (served cross-origin to frontend apps)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

const extraOrigins = process.env.EXTRA_CORS_ORIGINS
  ? process.env.EXTRA_CORS_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(cors({
  origin: [
    process.env.INTERNAL_APP_URL || "http://localhost:3000",
    process.env.CLIENT_APP_URL || "http://localhost:3001",
    process.env.HR_APP_URL || "http://localhost:3002",
    process.env.JOBS_APP_URL || "http://localhost:3003",
    ...extraOrigins,
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
}));

// Global rate limiter
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Too many requests, please try again later" } },
}));

// Stricter rate limit on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Too many login attempts, please try again later" } },
});
app.use("/v1/auth/login", authLimiter);
app.use("/v1/hr/auth/login", authLimiter);

// Stricter rate limit on public job applications (prevent spam)
const publicLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Too many applications, please try again later" } },
});
app.use("/v1/jobs/:id/apply", publicLimiter);
app.use("/v1/internship/apply", publicLimiter);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== "test") {
  app.use(morgan("combined"));
}

// Serve uploaded files (documents, profile pictures)
app.use("/uploads", express.static(UPLOAD_DIR));

app.use("/v1", routes);
app.use(errorHandler);

export default app;
