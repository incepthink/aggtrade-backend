import { Schema, model, type Document } from "mongoose";

export interface IMapping {
  userAddress: string;
  dydxAddress: string;
}

export type MappingDoc = IMapping & Document;

const mappingSchema = new Schema<MappingDoc>(
  {
    userAddress: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
    },
    dydxAddress: { type: String, required: true },
  },
  { timestamps: true }
);

export default model<MappingDoc>("Mapping", mappingSchema);
