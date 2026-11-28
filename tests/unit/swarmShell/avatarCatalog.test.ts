import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  AVATAR_CATALOG,
  getSeriesLibraryEntries,
  resolveModelSeries,
  resolveSeriesAvatar,
  type CustomAvatarMeta,
} from '../../../packages/swarm-shell/src/shared/avatarCatalog';

describe('按模型系列划分的专属头像库', () => {
  it('公开目录中的每款头像都随源码提供', () => {
    const dir = path.resolve(__dirname, '../../../packages/swarm-shell/src/renderer/avatars');
    expect(AVATAR_CATALOG).toHaveLength(67);
    for (const { id } of AVATAR_CATALOG) {
      expect(existsSync(path.join(dir, `${id}.webp`)), id).toBe(true);
    }
  });
  it('不同平台的同系列模型归入同一个系列并共用专属头像库', () => {
    const cbClaude = resolveModelSeries({ targetKey: 'S-1', host: 'CodeBuddy', model: 'claude-sonnet-4-5' });
    const agClaude = resolveModelSeries({ targetKey: 'S-2', host: 'Antigravity', model: 'claude-opus-4-6' });
    const qoderClaude = resolveModelSeries({ targetKey: 'S-3', host: 'Qoder', model: 'claude-sonnet-4' });
    expect(cbClaude.id).toBe('claude');
    expect(agClaude.id).toBe('claude');
    expect(qoderClaude.id).toBe('claude');

    const zcodeGlm = resolveModelSeries({ targetKey: 'S-4', host: 'ZCode', model: 'glm-4.7' });
    const cbGlm = resolveModelSeries({ targetKey: 'S-5', host: 'CodeBuddy', model: 'glm-5' });
    expect(zcodeGlm.id).toBe('glm');
    expect(cbGlm.id).toBe('glm');

    const selected = { claude: 'unavailable-previous-avatar' };
    expect(
      resolveSeriesAvatar({ targetKey: 'S-1', host: 'CodeBuddy', model: 'claude-sonnet-4-5' }, selected).active.id,
    ).toBe('claude-library');
    expect(
      resolveSeriesAvatar({ targetKey: 'S-2', host: 'Antigravity', model: 'claude-opus-4-6' }, selected).active.id,
    ).toBe('claude-library');
  });

  it('支持各系列及「我的头像」自定义添加，并只出现在所属系列库中', () => {
    const customItems: CustomAvatarMeta[] = [
      { id: 'c-owner', series: 'owner', name: '主人自定义', dataUrl: 'data:image/webp;base64,owner' },
      { id: 'c-ds', series: 'deepseek', name: '鲸鱼新图', dataUrl: 'data:image/webp;base64,ds' },
    ];
    const ownerRes = resolveSeriesAvatar({ targetKey: 'owner', sender: 'owner' }, { owner: 'c-owner' }, customItems);
    expect(ownerRes.series.id).toBe('owner');
    expect(ownerRes.active.id).toBe('c-owner');
    expect(ownerRes.entries.map(item => item.id)).toEqual(['owner', 'c-owner']);

    const claudeRes = resolveSeriesAvatar({ host: 'CodeBuddy', model: 'claude-sonnet-4' }, {}, customItems);
    expect(claudeRes.entries.some(item => item.id === 'c-ds' || item.id === 'c-owner')).toBe(false);

    const dsRes = resolveSeriesAvatar({ host: 'DeepSeek Harness', model: 'deepseek-chat' }, { deepseek: 'c-ds' }, customItems);
    expect(dsRes.active.id).toBe('c-ds');
  });
});
