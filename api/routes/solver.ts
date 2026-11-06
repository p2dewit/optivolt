import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError, toHttpError } from '../http-errors.ts';
import { getSolverBenchmark, startSolverBenchmark } from '../services/solver-benchmark-service.ts';

const router = express.Router();

router.post('/benchmark', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(202).json(await startSolverBenchmark());
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to start solver benchmark'));
  }
});

router.get('/benchmark/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = getSolverBenchmark(req.params.id);
    if (!job) throw new HttpError(404, 'Solver benchmark not found or expired.');
    res.json(job);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read solver benchmark'));
  }
});

export default router;
