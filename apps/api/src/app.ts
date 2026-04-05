import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import routes from "./routes";
import { errorHandler } from "./middleware/error-handler";

const app = express();

app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({
  origin: [
    process.env.INTERNAL_APP_URL || "http://localhost:3000",
    process.env.CLIENT_APP_URL || "http://localhost:3001",
    process.env.HR_APP_URL || "http://localhost:3002",
  ],
  credentials: true,
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== "test") {
  app.use(morgan("combined"));
}

app.use("/v1", routes);
app.use(errorHandler);

export default app;
