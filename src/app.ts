import express from "express";
import cors from "cors";
import router from "./router";
import {
  approveAllowance,
  approveTransaction,
  getQuote,
  rateLimit,
  swap,
} from "./controllers/controllers";
import initializeRoutes from "./routes";

export function createApp(): express.Express {
  const app = express();

  // ── global middleware ───────────────────────────────────────────
  app.use(cors({
    origin: true, // reflect the request origin
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
  }));
  app.use(express.json()); // parse JSON bodies

  app.get("/", (req, res) => {
    res.json({
      message: "Hello World!",
      status: "success",
      endpoints: {
        tokenPrice: "/api/tokenPrice",
        proxy1inch: "/proxy/1inch",
      },
      timestamp: new Date().toISOString(),
    });
  });

  // ── routes placeholder ─────────────────────────────────────────
  // import router from './routes'
  // app.use('/api', router)
  app.get("/proxy/1inch/approve/allowance", rateLimit, approveAllowance);
  app.get("/proxy/1inch/approve/transaction", rateLimit, approveTransaction);
  app.get("/proxy/1inch/swap", rateLimit, swap);
  app.get("/proxy/1inch/quote", rateLimit, getQuote);

  initializeRoutes(app)

  app.use("/api", router);

  return app;
}
