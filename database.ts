import mongoose from "mongoose";

export async function connectDB(uri: string): Promise<void> {
  await mongoose.connect(uri);
  console.log("✅  MongoDB connected");
}
