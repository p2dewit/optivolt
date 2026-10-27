import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/mqtt-service.ts', () => ({
  releaseDynamicEssToVrm: vi.fn(),
  ensureDynamicEssMode4: vi.fn(),
}));
import router from '../../api/routes/settings.ts';
import { loadSettings, loadDefaultSettings, saveSettings } from '../../api/services/settings-store.ts';
import {
  releaseDynamicEssToVrm,
  ensureDynamicEssMode4,
} from '../../api/services/mqtt-service.ts';
const app = express(); app.use(express.json()); app.use('/settings', router);
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
function setup(before, after) {
  vi.clearAllMocks();
  const settings = enabled => ({ pushToVictronEnabled: enabled, dataSources: {} });
  loadDefaultSettings.mockResolvedValue(settings(false));
  loadSettings.mockReset();
  loadSettings.mockResolvedValueOnce(settings(before)).mockResolvedValue(settings(after));
  saveSettings.mockResolvedValue();
  releaseDynamicEssToVrm.mockResolvedValue();
  ensureDynamicEssMode4.mockResolvedValue();
}
describe('settings VRM handover', () => {
  it('persists disabled before handing over and reports confirmation', async () => {
    setup(true, false);
    const res = await request(app).post('/settings').send({ pushToVictronEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.victronModeConfirmed).toBe(1);
    expect(saveSettings.mock.invocationCallOrder[0]).toBeLessThan(releaseDynamicEssToVrm.mock.invocationCallOrder[0]);
  });
  it('does not change mode when already disabled', async () => {
    setup(false, false);
    const res = await request(app).post('/settings')
      .send({ pushToVictronEnabled: false });

    expect(res.status).toBe(200);
    expect(releaseDynamicEssToVrm).not.toHaveBeenCalled();
    expect(ensureDynamicEssMode4).not.toHaveBeenCalled();
  });

  it('activates and confirms mode 4 when enabling Push', async () => {
    setup(false, true);
    const res = await request(app).post('/settings')
      .send({ pushToVictronEnabled: true });

    expect(res.status).toBe(200);
    expect(res.body.victronModeConfirmed).toBe(4);
    expect(ensureDynamicEssMode4).toHaveBeenCalledOnce();
    expect(releaseDynamicEssToVrm).not.toHaveBeenCalled();

    expect(saveSettings.mock.invocationCallOrder[0])
      .toBeLessThan(ensureDynamicEssMode4.mock.invocationCallOrder[0]);
  });

  it('reports failure when mode 4 cannot be confirmed', async () => {
    setup(false, true);
    ensureDynamicEssMode4.mockRejectedValueOnce(
      new Error('Mode 4 not confirmed')
    );

    const res = await request(app).post('/settings')
      .send({ pushToVictronEnabled: true });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to save settings');
    expect(ensureDynamicEssMode4).toHaveBeenCalledOnce();
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ pushToVictronEnabled: true })
    );
  });
  it('reports failure and retries the handover on a repeated save', async () => {
    setup(true, false);
    releaseDynamicEssToVrm.mockRejectedValueOnce(new Error('Mode 1 not confirmed'));
    const failed = await request(app).post('/settings').send({ pushToVictronEnabled: false });
    expect(failed.status).toBe(500);
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ pushToVictronEnabled: false }));
    setup(false, false);
    const retried = await request(app).post('/settings').send({ pushToVictronEnabled: false });
    expect(retried.body.victronModeConfirmed).toBe(1);
  });
});
