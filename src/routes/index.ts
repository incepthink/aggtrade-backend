import { Application } from "express";
import platformRouter from "./platform";
import userRouter from "./user"
import activityRouter from "./activity"
import trackingRouter from "./tracking"
import transactionRouter from "./transaction"
import botRouter from "./bot"

const initializeRoutes = (app: Application) => {
    app.use("/platform", platformRouter)
    app.use("/user", userRouter)
    app.use("/activity", activityRouter)
    app.use("/tracking", trackingRouter)
    app.use("/transaction", transactionRouter)
    app.use("/bot", botRouter)
}

export default initializeRoutes;