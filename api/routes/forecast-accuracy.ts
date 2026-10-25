import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getForecastAccuracy } from '../services/forecast-accuracy-service.ts';

const router = express.Router();
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json(await getForecastAccuracy()); }
  catch (error) { next(error); }
});
export default router;
