import { formatFor, localDay } from './meta-publish.service';

describe('publishing helpers', () => {
  it('counts the day in the market’s time zone', () => {
    // 18:30 UTC is already the next morning in Viet Nam.
    expect(localDay(new Date('2026-11-28T18:30:00Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-11-29');
    expect(localDay(new Date('2026-11-28T16:59:00Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-11-28');
  });

  it('picks how an item goes out to each kind of account', () => {
    expect(formatFor('text', null, 'page', 'reel')).toBe('feed');
    expect(formatFor('image', 'image/png', 'page', 'reel')).toBe('photo');
    expect(formatFor('video', 'video/mp4', 'page', 'reel')).toBe('reel');
    expect(formatFor('video', 'video/mp4', 'page', 'video')).toBe('video');
    expect(formatFor('image', 'image/jpeg', 'instagram', 'reel')).toBe('ig_image');
    expect(formatFor('video', 'video/mp4', 'instagram', 'video')).toBe('ig_reel');
    expect(formatFor('text', null, 'instagram', 'reel')).toBeNull();
    expect(formatFor('other', 'application/pdf', 'page', 'reel')).toBeNull();
    expect(formatFor('image', 'image/png', 'ad_account', 'reel')).toBeNull();
  });
});
