import { Router } from "express";
import {
    createBotWallet,
    getAllBotWallets,
    getBotWalletByAddress,
    getBotWalletByIndex,
    updateBotWalletBalances,
    updateBotWalletTokenBalance,
    deleteBotWallet
} from "../controllers/botWallet";

const router = Router();

// CREATE
router.post("/wallets", createBotWallet);

// READ
router.get("/wallets", getAllBotWallets);
router.get("/wallets/address/:wallet_address", getBotWalletByAddress);
router.get("/wallets/index/:wallet_index", getBotWalletByIndex);

// UPDATE
router.patch("/wallets/:wallet_address/balances", updateBotWalletBalances);
router.patch("/wallets/:wallet_address/balance/:token", updateBotWalletTokenBalance);

// DELETE
router.delete("/wallets/:wallet_address", deleteBotWallet);

export default router;