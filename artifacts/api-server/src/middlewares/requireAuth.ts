import { getAuth } from "@clerk/express";
import type { RequestHandler } from "express";

const requireAuth: RequestHandler = (req, res, next) => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }

  res.locals.userId = userId;
  next();
};

export default requireAuth;
