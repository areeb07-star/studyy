import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storageRouter from "./storage";
import studyGraphRouter from "./studygraph";
import requireAuth from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireAuth);
router.use(storageRouter);
router.use(studyGraphRouter);

export default router;
