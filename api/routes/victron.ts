import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { toHttpError } from '../http-errors.ts';
import { readVictronDynamicEssMode } from '../services/mqtt-service.ts';
import { getLastPlan, isLastPlanVictronReady } from '../services/planner-service.ts';

const router = express.Router();

router.get('/mode', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const mode = await readVictronDynamicEssMode();
    res.json({ mode, observedAt: new Date().toISOString() });
  } catch (error) {
    next(toHttpError(error, 503, 'Failed to read the Victron Dynamic ESS mode'));
  }
});

router.get('/plan-status', (_req: Request, res: Response) => {
  const plan = getLastPlan();
  res.json({ ready: isLastPlanVictronReady(), computedAtMs: plan?.computedAtMs ?? null });
});

export default router;
