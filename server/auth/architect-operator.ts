import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { users } from "@shared/schema";
import { db } from "../db";

/** Session authentication plus the firm-operator boundary for financial routes. */
export async function requireArchitectOperator(req: Request, res: Response, next: NextFunction) {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ message: "Authentication required" });
  try {
    const user = (await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!user || !user.email.toLowerCase().endsWith("@renosud.com")) {
      return res.status(403).json({ message: "Architect operator access required" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}