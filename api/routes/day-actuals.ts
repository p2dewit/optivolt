import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { toHttpError } from '../http-errors.ts';
import { fetchAndStoreDayActuals, getDayActualsRange, readArchivedDayActuals } from '../services/day-actuals-archive.ts';

const router = express.Router();
router.get('/range', async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json(await getDayActualsRange()); }
  catch (error) { next(toHttpError(error, 503, 'Could not read the archived DAY ACTUALS date range')); }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    const parsedDate = date ? new Date(`${date}T00:00:00Z`) : null;
    if (req.query.date !== undefined && (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date)) {
      res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      return;
    }
    if (date) {
      const archived = await readArchivedDayActuals(date);
      if (archived) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone: archived.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
        const todayKey = `${parts.year}-${parts.month}-${parts.day}`;
        if (date !== todayKey && date < todayKey) { res.json(archived); return; }
      }
    }
    res.json(await fetchAndStoreDayActuals(new Date(), date));
  }
  catch (error) { next(toHttpError(error, 503, 'Failed to read today’s GX actuals from Home Assistant')); }
});
export default router;
