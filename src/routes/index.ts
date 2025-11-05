import { Application } from "express";
import platformRouter from "./platform";

const initializeRoutes = (app: Application) => {
    app.use("/platform", platformRouter)
}

export default initializeRoutes;