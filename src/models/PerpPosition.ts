import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from "sequelize";
import sequelize from "../utils/db/sequelize";

export interface PerpPositionAttributes {
  id: number;
  user_id: number;
  wallet_address: string;
  market: string;
  side: "LONG" | "SHORT";
  order_type: "MARKET" | "LIMIT" | "STOP_MARKET" | "STOP_LIMIT";
  status: "OPEN" | "CLOSED" | "LIQUIDATED" | "CANCELLED";
  leverage: number;
  quantity: string;
  entry_price: string | null;
  exit_price: string | null;
  open_order_id: string;
  close_order_id: string | null;
  open_fill_id: string;
  close_fill_id: string | null;
  open_tx_hash: string;
  close_tx_hash: string | null;
  reduce_only: boolean;
  trigger_price: string | null;
  limit_price: string | null;
  opened_at: Date;
  closed_at: Date | null;
  created_at?: Date;
  updated_at?: Date;
}

class PerpPosition
  extends Model<
    InferAttributes<PerpPosition>,
    InferCreationAttributes<PerpPosition>
  >
  implements PerpPositionAttributes
{
  declare id: CreationOptional<number>;
  declare user_id: number;
  declare wallet_address: string;
  declare market: string;
  declare side: "LONG" | "SHORT";
  declare order_type: "MARKET" | "LIMIT" | "STOP_MARKET" | "STOP_LIMIT";
  declare status: CreationOptional<
    "OPEN" | "CLOSED" | "LIQUIDATED" | "CANCELLED"
  >;
  declare leverage: number;
  declare quantity: string;
  declare entry_price: string | null;
  declare exit_price: string | null;
  declare open_order_id: string;
  declare close_order_id: string | null;
  declare open_fill_id: string;
  declare close_fill_id: string | null;
  declare open_tx_hash: string;
  declare close_tx_hash: string | null;
  declare reduce_only: CreationOptional<boolean>;
  declare trigger_price: string | null;
  declare limit_price: string | null;
  declare opened_at: CreationOptional<Date>;
  declare closed_at: Date | null;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
}

PerpPosition.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: {
        model: "users",
        key: "id",
      },
      onDelete: "CASCADE",
    },
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false,
    },
    market: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    side: {
      type: DataTypes.ENUM("LONG", "SHORT"),
      allowNull: false,
    },
    order_type: {
      type: DataTypes.ENUM("MARKET", "LIMIT", "STOP_MARKET", "STOP_LIMIT"),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("OPEN", "CLOSED", "LIQUIDATED", "CANCELLED"),
      allowNull: false,
      defaultValue: "OPEN",
    },
    leverage: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    quantity: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false,
    },
    entry_price: {
      type: DataTypes.DECIMAL(30, 8),
      allowNull: true,
    },
    exit_price: {
      type: DataTypes.DECIMAL(30, 8),
      allowNull: true,
    },
    open_order_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    close_order_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    open_fill_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    close_fill_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    open_tx_hash: {
      type: DataTypes.STRING(66),
      allowNull: false,
    },
    close_tx_hash: {
      type: DataTypes.STRING(66),
      allowNull: true,
    },
    reduce_only: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    trigger_price: {
      type: DataTypes.DECIMAL(30, 8),
      allowNull: true,
    },
    limit_price: {
      type: DataTypes.DECIMAL(30, 8),
      allowNull: true,
    },
    opened_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    closed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: "PerpPosition",
    tableName: "perp_positions",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [
      {
        name: "idx_perp_user_id",
        fields: ["user_id"],
      },
    ],
  },
);

export default PerpPosition;
