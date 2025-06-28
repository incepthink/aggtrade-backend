import { createApp } from "./app.js";
import { connectDB } from "./database.js";
import dotenv from "dotenv";

async function bootstrap() {
  dotenv.config();

  const MONGO_URI =
    process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017/aggtrader";
  const PORT = Number(process.env.PORT) || 5000;

  try {
    await connectDB(MONGO_URI);

    const app = createApp();
    app.listen(PORT, () => {
      console.log(`🚀  Server running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌  Failed to start server:", err);
    process.exit(1);
  }
}

bootstrap();
