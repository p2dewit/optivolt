import express from 'express';
import { getLiveBlockGuardStatus, refreshLiveBlockGuard, setLiveBlockGuardMonitorPlan } from '../services/live-block-guard.ts';
const router = express.Router();
router.get('/', (_req, res) => res.json(getLiveBlockGuardStatus()));
router.post('/refresh', async (_req, res) => {
  await refreshLiveBlockGuard();
  res.json(getLiveBlockGuardStatus());
});
router.post('/monitor-plan', async (req, res) => {
  const accepted = await setLiveBlockGuardMonitorPlan(req.body?.plan);
  res.json({ accepted });
});
export default router;
