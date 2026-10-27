import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { toHttpError } from '../http-errors.ts';
import { getDayActuals } from '../services/day-actuals-service.ts';

const router = express.Router();
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    const parsedDate = date ? new Date(`${date}T00:00:00Z`) : null;
    if (req.query.date !== undefined && (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date)) {
      res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      return;
    }
    res.json(await getDayActuals(new Date(), date));
  }
  catch (error) { next(toHttpError(error, 503, 'Failed to read today’s GX actuals from Home Assistant')); }
});
export default router;
