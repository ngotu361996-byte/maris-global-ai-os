import { factWarnings } from './fact-check';

describe('factWarnings', () => {
  const facts = 'Giá: 199000 VND\n- Chất liệu: Cotton 100%\n- Trọng lượng: 4,5 kg';

  it('accepts numbers written with other separators, and single digits', () => {
    expect(factWarnings('Chỉ 199.000đ, cotton 100%, nặng 4.5 kg. Top 3 lý do mua.', facts)).toEqual(
      [],
    );
  });

  it('reports numbers the facts do not hold, once each', () => {
    expect(factWarnings('Giảm 30%, còn 139.000đ. Giảm 30% hôm nay!', facts)).toEqual([
      'Số liệu không có trong thông tin sản phẩm hoặc yêu cầu: 30, 139.000',
    ]);
  });

  it('reports claims as whole words only, unless the facts make them', () => {
    expect(factWarnings('Sản phẩm best seller, bestseller tuần này', facts)).toEqual([
      'Tuyên bố cần có căn cứ: “best”',
    ]);
    expect(factWarnings('Hàng chính hãng, tốt nhất', `${facts}\nXuất xứ: chính hãng`)).toEqual([
      'Tuyên bố cần có căn cứ: “tốt nhất”',
    ]);
    expect(factWarnings('The #1 choice, guaranteed.', facts)).toEqual([
      'Tuyên bố cần có căn cứ: “#1”, “guaranteed”',
    ]);
  });
});
