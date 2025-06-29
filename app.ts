import express from "express";
import cors from "cors";
import router from "./router";
import { oneInchProxy, rateLimit } from "./controllers";

export function createApp(): express.Express {
  const app = express();

  // ── global middleware ───────────────────────────────────────────
  app.use(cors()); // allow all origins
  app.use(express.json()); // parse JSON bodies

  // ── routes placeholder ─────────────────────────────────────────
  // import router from './routes'
  // app.use('/api', router)
  app.use("/proxy/1inch", rateLimit, oneInchProxy);

  app.use("/api", router);

  return app;
}
