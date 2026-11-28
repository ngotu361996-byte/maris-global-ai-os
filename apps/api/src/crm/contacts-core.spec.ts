import { contactOf, normEmail, normPhone } from './contacts-core';
import { parseWebhook } from '../meta/inbox-events';
import { leadFields } from '../meta/meta-leads.service';

describe('CRM contact matching', () => {
  it('reads Vietnamese phone numbers written in different ways as one number', () => {
    for (const v of [
      '0912345678',
      '+84 912 345 678',
      '84912345678',
      '0912.345.678',
      '(+84) 912-345-678',
      '0084912345678',
    ])
      expect(normPhone(v)).toBe('0912345678');
    expect(normPhone('12345')).toBeNull();
    expect(normPhone('')).toBeNull();
    expect(normPhone('+1 415 555 0100')).toBe('14155550100');
  });

  it('compares emails without case', () => {
    expect(normEmail('  Thu@Example.COM ')).toBe('thu@example.com');
    expect(normEmail('khong-phai-email')).toBeNull();
  });

  it('finds the name, phone and email in Lead Ads answers', () => {
    expect(
      contactOf([
        { name: 'first_name', values: ['Bảo'] },
        { name: 'last_name', values: ['Ngọc'] },
        { name: 'phone_number', values: ['', '0903111222'] },
        { name: 'EMAIL', values: ['ngoc@example.com'] },
      ]),
    ).toEqual({ name: 'Bảo Ngọc', phone: '0903111222', email: 'ngoc@example.com' });
    expect(contactOf([{ name: 'city', values: ['Hà Nội'] }])).toEqual({
      name: null,
      phone: null,
      email: null,
    });
  });

  it('keeps lead answers small', () => {
    const f = leadFields([
      { name: 'a', values: ['x'.repeat(2000), 1, null] },
      { name: '', values: ['bỏ'] },
      ...Array.from({ length: 60 }, (_, i) => ({ name: `q${i}`, values: ['v'] })),
    ]);
    expect(f[0]!.values[0]).toHaveLength(1000);
    expect(f[0]!.values.slice(1)).toEqual(['1', '']);
    expect(f.length).toBeLessThanOrEqual(50);
    expect(f.some((x) => x.name === '')).toBe(false);
  });

  it('takes "leadgen" webhook changes as lead ids only', () => {
    const [c, bad] = parseWebhook({
      object: 'page',
      entry: [
        {
          id: '6661',
          changes: [
            { field: 'leadgen', value: { leadgen_id: '8201', form_id: '7003', page_id: '6661' } },
            { field: 'leadgen', value: { leadgen_id: '../x' } },
          ],
        },
      ],
    });
    expect(c).toMatchObject({
      field: 'leadgen',
      inbound: null,
      lead: { pageId: '6661', leadgenId: '8201', formId: '7003' },
      skipped: null,
    });
    expect(bad).toMatchObject({ lead: null, skipped: 'thiếu mã lead' });
  });
});
