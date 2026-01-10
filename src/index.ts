import 'newrelic';
import Moralis from "moralis";
import { createApp } from "./app.js";
import { connectDB } from "./mongodb.js";
import dotenv from "dotenv";
import sequelize from "./utils/db/sequelize"
import "./models/index.js" // Load model associations
import { performStartupGapDetection } from "./services/startupGapDetection.js"

async function bootstrap() {
  dotenv.config();

  const MONGO_URI =
    process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017/aggtrader";
  const PORT = Number(process.env.PORT) || 5000;

  try {
    await sequelize.authenticate()
    await sequelize.sync()

    await connectDB(MONGO_URI);

    await Moralis.start({ apiKey: process.env.MORALIS_API! });

    // Run startup gap detection (auto-backfill if needed)
    await performStartupGapDetection();

    const app = createApp();
    app.listen(PORT, () =>
      console.log(`🚀 Server running at http://localhost:${PORT}`)
    );
  } catch (err) {
    console.error("❌  Failed to start server:", err);
    process.exit(1);
  }
}

bootstrap();

