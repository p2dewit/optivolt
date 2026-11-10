import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError, toHttpError } from '../http-errors.ts';
import { getSolverBenchmark, startSolverBenchmark } from '../services/solver-benchmark-service.ts';

const router = express.Router();

router.post('/benchmark', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const strategy = req.body?.strategy;
    if (strategy !== undefined && strategy !== 'aggressive' && strategy !== 'green' && strategy !== 'winter') {
      throw new HttpError(400, 'strategy must be aggressive, green, or winter');
    }
    res.status(202).json(await startSolverBenchmark(strategy));
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to start solver benchmark'));
  }
});

router.get('/benchmark/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const paramId = req.params.id;
    const id = typeof paramId === 'string' ? paramId : paramId[0] ?? '';
    const job = getSolverBenchmark(id);
    if (!job) throw new HttpError(404, 'Solver benchmark not found or expired.');
    res.json(job);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read solver benchmark'));
  }
});

export default router;
