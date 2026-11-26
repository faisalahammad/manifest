import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateInstanceSettingsDto } from './update-instance-settings.dto';

async function errorsFor(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(UpdateInstanceSettingsDto, body));
  return errors.map((error) => error.property);
}

describe('UpdateInstanceSettingsDto', () => {
  it('accepts every listed retention window and null', async () => {
    for (const days of [1, 7, 15, 30, 60, 90, null]) {
      expect(await errorsFor({ logRetentionDays: days })).toEqual([]);
    }
  });

  it('rejects other windows', async () => {
    expect(await errorsFor({ logRetentionDays: 14 })).toEqual(['logRetentionDays']);
    expect(await errorsFor({ logRetentionDays: '7' })).toEqual(['logRetentionDays']);
  });

  it('requires a boolean for signupEnabled', async () => {
    expect(await errorsFor({ signupEnabled: false })).toEqual([]);
    expect(await errorsFor({ signupEnabled: 'no' })).toEqual(['signupEnabled']);
  });
});
