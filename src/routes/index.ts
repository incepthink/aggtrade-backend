import { Application } from "express";
import platformRouter from "./platform";
import userRouter from "./user"
import activityRouter from "./activity"

const initializeRoutes = (app: Application) => {
    app.use("/platform", platformRouter)
    app.use("/user", userRouter)
    app.use("/activity", activityRouter)
}

export default initializeRoutes;