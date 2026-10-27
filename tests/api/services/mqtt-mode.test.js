import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { client } = vi.hoisted(() => ({ client: {
  getSerial: vi.fn(async () => 'test-portal'),
  writeSetting: vi.fn(), readSetting: vi.fn(), writeScheduleSlot: vi.fn(),
} }));
vi.mock('../../../api/services/victron-mqtt-client.ts', () => ({
  VictronMqttClient: class { constructor() { return client; } },
}));
vi.mock('../../../api/services/settings-store.ts', () => ({ loadSettings: vi.fn(async () => ({ pushToVictronEnabled: true })) }));
import { loadSettings } from '../../../api/services/settings-store.ts';
vi.mock('../../../api/env.ts', () => ({ getMqttEnv: () => ({}) }));
import { ensureDynamicEssMode4, readVictronDynamicEssMode, setDynamicEssSchedule, releaseDynamicEssToVrm, writeDynamicEssSlotSocTarget } from '../../../api/services/mqtt-service.ts';
const row = { timestampMs: 1700000000000, dess: { strategy: 1, flags: 0, socTarget_percent: 60, restrictions: 0, feedin: 1 } };
const validRows = () => Array.from({ length: 4 }, (_, i) => ({ ...row, timestampMs: 1700000000000 + i * 900000 }));
function respondWithWrittenSlots(path) {
  if (path.endsWith('/Mode')) return { value: 4 };
  const match = path.match(/Schedule\/(\d+)\/(Start|Duration|Soc|TargetSoc|Strategy|Flags|Restrictions|AllowGridFeedIn)$/);
  if (!match) return { value: 4 };
  const slot = client.writeScheduleSlot.mock.calls.find(call => call[0] === Number(match[1]))?.[1];
  if (!slot) return { value: null };
  return { value: {
    Start: slot.startEpoch, Duration: slot.durationSeconds, Soc: slot.socTarget,
    TargetSoc: slot.socTarget, Strategy: slot.strategy, Flags: slot.flags,
    Restrictions: slot.restrictions, AllowGridFeedIn: slot.allowGridFeedIn,
  }[match[2]] };
}

describe('verified DESS mode before schedule push', () => {
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(1700000000000); vi.clearAllMocks(); loadSettings.mockResolvedValue({ pushToVictronEnabled: true }); client.writeSetting.mockResolvedValue(); client.readSetting.mockReset(); client.readSetting.mockImplementation(respondWithWrittenSlots); });
  afterEach(() => vi.restoreAllMocks());
  it('sets and verifies mode before writing slots', async () => {
    await setDynamicEssSchedule(validRows(), 4, 900);
    expect(client.writeSetting).toHaveBeenCalledWith('settings/0/Settings/DynamicEss/Mode', 4, { serial: 'test-portal' });
    expect(client.writeSetting.mock.invocationCallOrder[0]).toBeLessThan(client.readSetting.mock.invocationCallOrder[0]);
    expect(client.readSetting.mock.invocationCallOrder[0]).toBeLessThan(client.writeScheduleSlot.mock.invocationCallOrder[0]);
  });
  it('retries an old mode notification', async () => {
    client.readSetting.mockImplementationOnce(() => ({ value: 1 }));
    await setDynamicEssSchedule(validRows(), 4, 900);
    expect(client.readSetting.mock.calls.filter(call => call[0].endsWith('/Mode'))).toHaveLength(3);
    expect(client.writeScheduleSlot).toHaveBeenCalledTimes(4);
  });
  it.each([{ value: 1 }, { value: null }, { value: [4] }])('blocks slots without confirmation: %j', async payload => {
    client.readSetting.mockResolvedValue(payload);
    await expect(setDynamicEssSchedule(validRows(), 4, 900)).rejects.toThrow('Schedule not sent');
    expect(client.writeScheduleSlot).not.toHaveBeenCalled();
  });
  it('blocks slots when reads time out', async () => {
    client.readSetting.mockRejectedValue(new Error('timeout'));
    await expect(setDynamicEssSchedule(validRows(), 4, 900)).rejects.toThrow('Schedule not sent');
    expect(client.writeScheduleSlot).not.toHaveBeenCalled();
  });
  it('blocks slots when writing the mode fails', async () => {
    client.writeSetting.mockRejectedValueOnce(new Error('offline'));
    await expect(setDynamicEssSchedule(validRows(), 4, 900)).rejects.toThrow('offline');
    expect(client.readSetting).not.toHaveBeenCalled();
    expect(client.writeScheduleSlot).not.toHaveBeenCalled();
  });
  it('rejects an empty schedule without changing mode', async () => {
    await expect(setDynamicEssSchedule([], 0, 900)).rejects.toThrow('four DESS schedule slots');
    expect(client.writeSetting).not.toHaveBeenCalled();
  });
  it('rejects a stale plan before changing Victron mode', async () => {
    await expect(setDynamicEssSchedule(validRows().map(r => ({ ...r, timestampMs: r.timestampMs - 3600000 })), 4, 900)).rejects.toThrow('does not cover');
    expect(client.writeSetting).not.toHaveBeenCalled();
  });
  it('reads back every populated field for all four slots', async () => {
    await setDynamicEssSchedule(validRows(), 4, 900);
    for (let i = 0; i < 4; i++) {
      for (const field of ['Start', 'Duration', 'Soc', 'TargetSoc', 'Strategy', 'Flags', 'Restrictions', 'AllowGridFeedIn']) {
        expect(client.readSetting).toHaveBeenCalledWith(
          `settings/0/Settings/DynamicEss/Schedule/${i}/${field}`,
          { serial: 'test-portal', timeoutMs: 2000 },
        );
      }
    }
  });
  it('rejects a strategy mismatch instead of marking the push verified', async () => {
    client.readSetting.mockImplementation(path => path.endsWith('/Strategy') ? { value: 99 } : respondWithWrittenSlots(path));
    await expect(setDynamicEssSchedule(validRows(), 4, 900)).rejects.toThrow('did not confirm schedule slot 0 Strategy');
  });
  it('accepts crossing into the next valid slot during verification', async () => {
    let calls = 0;
    Date.now.mockImplementation(() => (++calls >= 3 ? 1700000000000 + 900001 : 1700000000000));
    await expect(setDynamicEssSchedule(validRows(), 4, 900)).resolves.toMatchObject({ slotsWritten: 4 });
  });
  it('rejects schedule expiry during verification', async () => {
    let calls = 0;
    Date.now.mockImplementation(() => (++calls >= 3 ? 1700000000000 + 3600000 : 1700000000000));
    await expect(setDynamicEssSchedule(validRows(), 4, 900)).rejects.toThrow('no longer covers');
  });
  it('does not record an unconfirmed schedule as sent', async () => {
    client.readSetting.mockImplementation(path => path.endsWith('/Mode') ? { value: 4 } : { value: null });
    await expect(setDynamicEssSchedule(validRows(), 4, 900)).rejects.toThrow('did not confirm schedule slot');
  });
  it('reads the actual mode and lets guard writes reassert verified mode 4', async () => {
    client.readSetting.mockResolvedValue({ value: '4' });
    await expect(readVictronDynamicEssMode()).resolves.toBe(4);
    await ensureDynamicEssMode4();
    expect(client.writeSetting).toHaveBeenCalledWith('settings/0/Settings/DynamicEss/Mode', 4, { serial: 'test-portal' });
  });
});

describe('VRM handover', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    vi.clearAllMocks();
    loadSettings.mockResolvedValue({ pushToVictronEnabled: false });
    client.writeSetting.mockResolvedValue();
    client.readSetting.mockResolvedValue({ value: 1 });
  });
  it('writes and confirms mode 1', async () => {
    await releaseDynamicEssToVrm();
    expect(client.writeSetting).toHaveBeenCalledWith('settings/0/Settings/DynamicEss/Mode', 1, { serial: 'test-portal' });
    expect(client.readSetting).toHaveBeenCalled();
  });
  it('rejects unconfirmed handover', async () => {
    client.readSetting.mockResolvedValue({ value: 4 });
    await expect(releaseDynamicEssToVrm()).rejects.toThrow('mode 1');
  });
  it('blocks schedule and guard writes after disabling', async () => {
    await expect(setDynamicEssSchedule(validRows(), 4, 900)).rejects.toThrow('disabled');
    await writeDynamicEssSlotSocTarget(0, 70);
    expect(client.writeSetting).not.toHaveBeenCalled();
  });
  it('finishes an existing push before handing over', async () => {
    loadSettings.mockResolvedValue({ pushToVictronEnabled: true });
    client.readSetting.mockImplementation(respondWithWrittenSlots);
    let finish;
    let started;
    const inSlot = new Promise(resolve => { started = resolve; });
    client.writeScheduleSlot.mockImplementationOnce(() => { started(); return new Promise(resolve => { finish = resolve; }); });
    const push = setDynamicEssSchedule(validRows(), 4, 900);
    await inSlot;
    loadSettings.mockResolvedValue({ pushToVictronEnabled: false });
    const release = releaseDynamicEssToVrm();
    expect(client.writeSetting).toHaveBeenCalledTimes(1);
    // The slot readbacks must still succeed while release waits in the write queue.
    finish();
    await push;
    client.readSetting.mockResolvedValue({ value: 1 });
    await release;
    expect(client.writeSetting.mock.calls.map(call => call[1])).toEqual([4, 1]);
  });
});
