import { Application } from "express";
import platformRouter from "./platform";
import userRouter from "./user"

const initializeRoutes = (app: Application) => {
    app.use("/platform", platformRouter)
    app.use("/user", userRouter)
}

export default initializeRoutes;